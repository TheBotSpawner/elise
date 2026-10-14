import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-056 (Notes v2): rich text stored as Markdown, one note in
 * several Knowledge Spaces, indexing once, retrieval through membership, legacy notes, chat.
 * Knowledge ingestion must run in-process for the retrieval checks:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome TRIGGER_SECRET_KEY= npx playwright test notes-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const ids: Record<string, string> = {};
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr056-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Validación", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  console.log(`VALIDATION ${JSON.stringify({ ...report, errors }, null, 1)}`);
  if (!userId) return;
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  page.on("pageerror", (e) => errors.push(`pageerror @ ${page.url()}: ${e.message.slice(0, 160)}`));
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const noteBy = async (title: string) =>
  (
    await admin!
      .from("notes")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("title", title)
      .eq("status", "active")
  ).data ?? [];

const memberships = async (noteId: string) =>
  ((await admin!.from("note_knowledge_spaces").select("space_id").eq("note_id", noteId)).data ?? [])
    .map((m) => m.space_id as string)
    .sort();

/** Retrieval exactly as ELISE runs it (keywords only), scoped to these Spaces. */
const retrieve = async (keywords: string, spaces: string[]) =>
  (
    await admin!.rpc("search_knowledge_chunks", {
      p_workspace_id: workspaceId,
      p_keywords: keywords,
      p_embedding: null,
      p_embedding_model: "",
      p_space_ids: spaces,
      p_item_ids: null,
      p_limit: 10,
    })
  ).data as { knowledge_item_id: string; chunk_id: string; content: string }[] | null;

const editor = (page: Page) => page.getByRole("textbox", { name: "Escribí…" });

async function pickSpaces(page: Page, names: string[]) {
  await page.getByRole("button", { name: /^Conocimiento/ }).click();
  const dialog = page.getByRole("dialog", { name: "Conocimiento" });
  for (const n of names) await dialog.getByText(n, { exact: true }).click();
  await page.keyboard.press("Escape");
}

test("setup: Spaces and a legacy plain-text note", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id;
  for (const name of ["Firbot Solutions", "Firbot Marketing"]) {
    const { data } = await admin!
      .from("knowledge_spaces")
      .insert({ workspace_id: workspaceId, name, created_by_user_id: userId })
      .select("id")
      .single();
    ids[name] = data!.id;
  }
  const { data: general } = await admin!
    .from("knowledge_spaces")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "general")
    .single();
  ids["General Knowledge"] = general!.id;
  const { data: legacy } = await admin!
    .from("notes")
    .insert({
      workspace_id: workspaceId,
      title: "Nota vieja",
      content: "Llamar a Ana el lunes\nRevisar presupuesto 2027",
      created_by_user_id: userId,
    })
    .select("id")
    .single();
  ids.legacy = legacy!.id;
});

test("1: formatting survives save → leave → reopen → refresh", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/notes");
  await page.getByRole("button", { name: "Nueva nota" }).click();
  await page.getByLabel("Título").fill("Prueba de formato");
  await editor(page).click();
  // Markdown shortcuts as people type them.
  await page.keyboard.type("# Reunión");
  await page.keyboard.press("Enter");
  await page.keyboard.type("**Decisiones** ");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- Primera");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Segunda");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("*Comentario* ");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect.poll(async () => (await noteBy("Prueba de formato")).length).toBe(1);
  const stored = (await noteBy("Prueba de formato"))[0]!.content as string;
  report.formatMarkdown = stored;
  for (const token of ["# Reunión", "**Decisiones**", "- Primera", "- Segunda", "*Comentario*"])
    expect(stored).toContain(token);
  // Leave, come back, refresh.
  await page.goto("/my-elise");
  await page.goto("/my-elise/notes");
  await page.reload();
  await page.getByRole("button", { name: /Prueba de formato/ }).click();
  await expect(editor(page).locator("h1", { hasText: "Reunión" })).toBeVisible();
  await expect(editor(page).locator("strong", { hasText: "Decisiones" })).toBeVisible();
  await expect(editor(page).locator("ul li")).toHaveCount(2);
  await expect(editor(page).locator("em", { hasText: "Comentario" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("notes-format.png"), fullPage: true });
});

test("2–6: one note in three Spaces, edit, remove a Space, remove all, no duplicates", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/notes");
  await page.getByRole("button", { name: "Nueva nota" }).click();
  await page.getByLabel("Título").fill("Proceso comercial");
  await editor(page).click();
  await page.keyboard.type("Pasos de la propuesta comercial: brief, borrador, revisión.");
  await pickSpaces(page, ["General Knowledge", "Firbot Solutions", "Firbot Marketing"]);
  await page.screenshot({ path: info.outputPath("notes-spaces.png"), fullPage: true });
  await page.getByRole("button", { name: "Guardar", exact: true }).click();

  // 2. One note, three memberships, one knowledge item, one set of chunks.
  await expect.poll(async () => (await noteBy("Proceso comercial")).length).toBe(1);
  const note = (await noteBy("Proceso comercial"))[0]!;
  const three = [ids["General Knowledge"]!, ids["Firbot Solutions"]!, ids["Firbot Marketing"]!];
  await expect.poll(async () => (await memberships(note.id)).length).toBe(3);
  const items = async () =>
    (await admin!.from("knowledge_items").select("id").eq("external_id", note.id)).data ?? [];
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBe(1);
  const itemId = (await items())[0]!.id as string;
  await expect
    .poll(async () => ((await retrieve("propuesta", three)) ?? []).length, { timeout: 120_000 })
    .toBeGreaterThan(0);
  const versions = async () =>
    (await admin!.from("knowledge_versions").select("id").eq("knowledge_item_id", itemId)).data ??
    [];
  report.versionsAfterCreate = (await versions()).length;
  for (const name of ["General Knowledge", "Firbot Solutions", "Firbot Marketing"]) {
    const hits = (await retrieve("propuesta", [ids[name]!])) ?? [];
    expect(new Set(hits.map((h) => h.knowledge_item_id))).toEqual(new Set([itemId]));
  }
  // 6. Two Spaces in scope: the note comes back once.
  const both =
    (await retrieve("propuesta", [ids["General Knowledge"]!, ids["Firbot Solutions"]!])) ?? [];
  report.dedupe = { rows: both.length, chunks: new Set(both.map((h) => h.chunk_id)).size };
  expect(both.length).toBe(new Set(both.map((h) => h.chunk_id)).size);
  expect(new Set(both.map((h) => h.knowledge_item_id)).size).toBe(1);

  // 3. Edit one paragraph: the new text is found from all three Spaces.
  await page.getByRole("button", { name: /Proceso comercial/ }).click();
  await editor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Incluye cotización express.");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  for (const name of ["General Knowledge", "Firbot Solutions", "Firbot Marketing"])
    await expect
      .poll(async () => ((await retrieve("cotización & express", [ids[name]!])) ?? []).length, {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
  report.versionsAfterEdit = (await versions()).length;

  // 4. Remove Firbot Marketing (chip ×): only membership changes, no new version.
  await page.reload();
  await page.getByRole("button", { name: "Quitar de Firbot Marketing" }).click();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect.poll(async () => (await memberships(note.id)).length).toBe(2);
  await expect
    .poll(async () => ((await retrieve("cotización", [ids["Firbot Marketing"]!])) ?? []).length, {
      timeout: 30_000,
    })
    .toBe(0);
  expect(
    ((await retrieve("cotización", [ids["General Knowledge"]!])) ?? []).length,
  ).toBeGreaterThan(0);
  expect(((await retrieve("cotización", [ids["Firbot Solutions"]!])) ?? []).length).toBeGreaterThan(
    0,
  );
  report.versionsAfterScopeChange = (await versions()).length;
  expect(report.versionsAfterScopeChange).toBe(report.versionsAfterEdit);
  expect((await noteBy("Proceso comercial")).length).toBe(1);

  // 5. Remove every Space: the note stays, outside Knowledge.
  await page.reload();
  await page.getByRole("button", { name: "Quitar de General Knowledge" }).click();
  await page.getByRole("button", { name: "Quitar de Firbot Solutions" }).click();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect.poll(async () => (await memberships(note.id)).length).toBe(0);
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBe(0);
  expect(((await retrieve("cotización", three)) ?? []).length).toBe(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Proceso comercial/ }).getByText("Fuera de Conocimiento"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("notes-outside.png"), fullPage: true });
});

test("7: a legacy plain-text note opens, formats and saves without loss", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto(`/my-elise/notes?note=${ids.legacy}`);
  await expect(editor(page)).toContainText("Llamar a Ana el lunes");
  await expect(editor(page)).toContainText("Revisar presupuesto 2027");
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+b");
  await page.keyboard.type("Urgente");
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect
    .poll(async () => ((await noteBy("Nota vieja"))[0]?.content as string) ?? "")
    .toContain("**Urgente**");
  const content = (await noteBy("Nota vieja"))[0]!.content as string;
  expect(content).toContain("Llamar a Ana el lunes");
  expect(content).toContain("Revisar presupuesto 2027");
  report.legacy = content;
});

test("8: chat — create in two Spaces, then take it out of one", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  const ask = async (text: string) => {
    await page.goto("/");
    const box = page.locator("textarea").first();
    if (!(await box.isVisible().catch(() => false)))
      await page.getByRole("button", { name: "Escribir" }).first().click();
    await box.fill(text);
    await box.press("Enter");
    await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, {
      timeout: 150_000,
    });
  };
  await ask(
    "Creá una nota llamada 'Proceso de propuestas' y guardala en General Knowledge y Firbot Solutions.",
  );
  await expect
    .poll(async () => (await noteBy("Proceso de propuestas")).length, { timeout: 30_000 })
    .toBe(1);
  const note = (await noteBy("Proceso de propuestas"))[0]!;
  expect(await memberships(note.id)).toEqual(
    [ids["General Knowledge"]!, ids["Firbot Solutions"]!].sort(),
  );
  await ask("Sacala de General Knowledge.");
  await expect
    .poll(async () => await memberships(note.id), { timeout: 30_000 })
    .toEqual([ids["Firbot Solutions"]!]);
  report.chatTools = (
    await admin!
      .from("tool_executions")
      .select("tool_name")
      .eq("workspace_id", workspaceId)
      .order("started_at", { ascending: false })
      .limit(6)
  ).data?.map((c) => c.tool_name);
  await page.screenshot({ path: info.outputPath("notes-chat.png"), fullPage: true });
});

test("responsive and dark mode", async ({ page }, info) => {
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page);
  for (const [name, w, h] of [
    ["desktop", 1440, 950],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/my-elise/notes?note=${ids.legacy}`);
    await expect(editor(page)).toBeVisible();
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`notes-dark-${name}.png`), fullPage: true });
  }
});
