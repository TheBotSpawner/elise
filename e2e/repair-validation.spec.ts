import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-065 (conversational repair, canonical names): real model, real Chrome,
 * a throwaway user. On demand only:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test repair-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+adr065-${info.project.name}-${Date.now()}@elise.test`;
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
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

async function newChat(page: Page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.goto("/");
}

/** Sends a message and returns ELISE's reply as stored. */
async function say(page: Page, text: string): Promise<string> {
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 150_000 });
  const { data } = await admin!
    .from("messages")
    .select("content, metadata")
    .eq("workspace_id", workspaceId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);
  const m = data?.[0] as { content: string; metadata: { toolNotes?: string[] } } | undefined;
  return `${m?.content ?? ""}\n[notes] ${(m?.metadata?.toolNotes ?? []).join(" | ")}`;
}

const asks = (reply: string) => /¿\s*(quer[eé]s|lo (corrijo|cambio)|confirm)/i.test(reply);

test("setup", async ({ page }) => {
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
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
});

test("1: the reported case — same task, corrected, no question, no duplicate", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  const r1 = await say(page, "¿Me agregás, por favor, una tarea: cargar finanzas en Mielist?");
  const r2 = await say(page, "No, no, ahí te lo escribiste mal. Mielist como tu nombre, mi Elise.");
  const { data: tasks } = await admin!
    .from("tasks")
    .select("id, title")
    .eq("workspace_id", workspaceId);
  report.case1 = { r1, r2, tasks: tasks?.map((t) => t.title) };
  // Surface: the open task card shows the corrected title without a reload.
  report.case1_screen = await page
    .getByText("Cargar finanzas en Mi ELISE")
    .first()
    .isVisible()
    .catch(() => false);
  expect(tasks).toHaveLength(1);
  expect(tasks![0]!.title).toBe("Cargar finanzas en Mi ELISE");
  expect(asks(r2)).toBe(false);
  expect(r2).not.toMatch(/methods\.(get|update)/);
});

test("2: list item — “No, leche.” corrects, doesn't add", async ({ page }) => {
  await admin!.from("lists").insert({ workspace_id: workspaceId, name: "Compras" });
  await signIn(page);
  await newChat(page);
  const r1 = await say(page, "Agregá huevos a Compras.");
  const r2 = await say(page, "No, leche.");
  const { data: items } = await admin!
    .from("list_items")
    .select("content")
    .eq("workspace_id", workspaceId);
  report.case2 = { r1, r2, items: items?.map((i) => i.content) };
  expect(items?.map((i) => i.content)).toEqual(["Leche"]);
  expect(asks(r2)).toBe(false);
});

test("3: habit — “Mejor 30.” updates the same habit", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  const r1 = await say(page, "Creá el hábito leer 20 minutos, todos los días.");
  const r2 = await say(page, "Mejor 30.");
  const { data: habits } = await admin!
    .from("habits")
    .select("name, target_value")
    .eq("workspace_id", workspaceId);
  report.case3 = { r1, r2, habits };
  expect(habits).toHaveLength(1);
  expect(JSON.stringify(habits)).toMatch(/30/);
  expect(asks(r2)).toBe(false);
});

test("1b: a misheard title already written is corrected in place", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  // Written literally on purpose, as speech recognition would have left it.
  const r1 = await say(page, "Agregá una tarea, literal así: “pagar el hosting de Mielist”.");
  const before = (
    await admin!
      .from("tasks")
      .select("id, title")
      .eq("workspace_id", workspaceId)
      .ilike("title", "%hosting%")
  ).data;
  const r2 = await say(page, "No, ahí lo escribiste mal. Era Mi ELISE, como tu nombre.");
  const after = (
    await admin!
      .from("tasks")
      .select("id, title")
      .eq("workspace_id", workspaceId)
      .ilike("title", "%hosting%")
  ).data;
  report.case1b = { r1, r2, before, after };
  expect(before?.[0]?.title).toMatch(/Mielist/);
  expect(after).toHaveLength(1);
  expect(after![0]!.id).toBe(before![0]!.id);
  expect(after![0]!.title).toBe("Pagar el hosting de Mi ELISE");
  expect(asks(r2)).toBe(false);
});

test("4: two things just written — asks which", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  const r1 = await say(page, "Agregá la tarea revisar presupuesto y agregá yerba a Compras.");
  const r2 = await say(page, "Cambialo a Personal.");
  report.case4 = { r1, r2 };
  expect(r2).toMatch(/\?/);
});

test("4b: one object, “cambialo a Personal” is not a rename", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  const r1 = await say(page, "Agregá la tarea comprar regalo para Ana.");
  const r2 = await say(page, "Cambialo a Personal.");
  const { data } = await admin!
    .from("tasks")
    .select("title")
    .eq("workspace_id", workspaceId)
    .ilike("title", "%regalo%");
  report.case4b = { r1, r2, data };
  expect(data?.[0]?.title).toMatch(/regalo/i);
});

test("6: a literal name is respected", async ({ page }) => {
  await signIn(page);
  await newChat(page);
  const r1 = await say(
    page,
    "Agregá una tarea: revisar el roadmap de Mielist. Mi proyecto se llama Mielist, con T al final.",
  );
  const { data: tasks } = await admin!
    .from("tasks")
    .select("title")
    .eq("workspace_id", workspaceId)
    .ilike("title", "%roadmap%");
  report.case6 = { r1, tasks };
  expect(tasks?.[0]?.title).toMatch(/Mielist/);
});
