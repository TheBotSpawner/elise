import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of the Knowledge document widgets and ELISE's document viewer: cited passages
 * as quotes, "Ver en el documento" at the cited page, "Abrir documento completo", several
 * documents as an accordion. A seeded throwaway user with a real PDF in Storage. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test document-viewer-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
let conversationId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+viewer-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Leo QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  if (workspaceId) {
    const { data } = await admin!.storage
      .from("knowledge-originals")
      .list(`workspace/${workspaceId}/knowledge`, { limit: 100 });
    void data;
    await admin!.from("workspaces").delete().eq("id", workspaceId);
  }
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

/** A PDF with one line of text per page. */
function pdf(pages: string[]): Buffer {
  const objs: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  const font = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const ids: Record<string, string> = {};

test("setup: a Space with a stored PDF and two document Surfaces", async () => {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  const ws = { workspace_id: workspaceId };
  const space = (
    await admin!
      .from("knowledge_spaces")
      .insert({ ...ws, name: "Legislación" })
      .select("id")
      .single()
  ).data!;
  ids.space = space.id as string;
  const source = (
    await admin!
      .from("knowledge_sources")
      .insert({
        ...ws,
        space_id: space.id,
        provider_key: "elise_native",
        source_type: "upload",
        display_name: "Archivos subidos",
      })
      .select("id")
      .single()
  ).data!;
  for (const [key, title] of [
    ["protocolo", "PROTOCOLO 2026.pdf"],
    ["consignas", "100 CONSIGNAS para EPI.pdf"],
  ] as const) {
    const item = (
      await admin!
        .from("knowledge_items")
        .insert({
          ...ws,
          space_id: space.id,
          source_id: source.id,
          item_type: "file",
          external_id: `qa-${key}`,
          title,
          mime_type: "application/pdf",
          status: "ready",
        })
        .select("id")
        .single()
    ).data!;
    const versionId = crypto.randomUUID();
    const path = `workspace/${workspaceId}/knowledge/${item.id}/${versionId}/${key}.pdf`;
    const up = await admin!.storage
      .from("knowledge-originals")
      .upload(path, pdf(["Pagina 1", "Pagina 2: recuperatorios", "Pagina 3: actividad practica"]), {
        contentType: "application/pdf",
      });
    if (up.error) throw up.error;
    const { error } = await admin!.from("knowledge_versions").insert({
      id: versionId,
      ...ws,
      knowledge_item_id: item.id,
      version_number: 1,
      status: "ready",
      is_current: true,
      storage_path: path,
      mime_type: "application/pdf",
    });
    if (error) throw error;
    await admin!
      .from("knowledge_items")
      .update({ current_version_id: versionId })
      .eq("id", item.id);
    ids[key] = item.id as string;
  }
  const { data: conv } = await admin!
    .from("conversations")
    .insert({ ...ws, user_id: userId, title: "Instancias del EPI" })
    .select("id")
    .single();
  conversationId = conv!.id as string;
  await admin!.from("messages").insert([
    { conversation_id: conversationId, ...ws, role: "user", content: "¿Qué dice el protocolo?" },
    { conversation_id: conversationId, ...ws, role: "assistant", content: "Esto dice." },
  ]);
  const passage = (n: number, page: number, excerpt: string) => ({
    ref: n,
    chunkId: crypto.randomUUID(),
    section: null,
    page,
    excerpt,
  });
  const doc = (key: string, title: string, passages: ReturnType<typeof passage>[]) => ({
    itemId: ids[key]!,
    title,
    sourceType: "upload",
    spaceName: "UTN › Legislación",
    url: null,
    passages,
  });
  const protocolo = doc("protocolo", "PROTOCOLO 2026.pdf", [
    passage(
      1,
      2,
      "RECUPERATORIO reemplaza a la obtenida en la 1er. Instancia de evaluación (EPI). Para acceder al Final también tiene posibilidad de rendir un 2do. Recuperatorio.… [truncated]",
    ),
    passage(
      2,
      3,
      "Ambas Cátedras de LEGISLACIÓN han considerado especialmente encomendar una Actividad Práctica Evaluativa",
    ),
  ]);
  const consignas = doc("consignas", "100 CONSIGNAS para EPI.pdf", [
    passage(3, 2, "33) Indicar las actitudes procesales posibles que tienen las Partes."),
    passage(4, 3, "34) Determinar 3 diferencias entre el Concurso Preventivo y la Quiebra."),
  ]);
  const now = new Date().toISOString();
  const surface = (id: string, handle: string, type: string, payload: unknown) => ({
    id,
    handle,
    type,
    title: "",
    state: "ready",
    priority: 80,
    size: "large",
    source: { capability: "knowledge", label: "UTN › Legislación" },
    ref: null,
    payload,
    actions: [],
    intentId: null,
    turn: 1,
    createdAt: now,
    updatedAt: now,
  });
  const { error } = await admin!.from("live_workspaces").insert({
    ...ws,
    user_id: userId,
    conversation_id: conversationId,
    surfaces: [
      surface("knowledge_source:one", "S1", "knowledge_source", protocolo),
      surface("knowledge_result:many", "S2", "knowledge_result", {
        enough: true,
        sources: [consignas, protocolo],
      }),
    ],
    turn: 1,
    next_handle: 3,
    version: 1,
  });
  if (error) throw error;
});

test("widgets quote the passages and open the whole document in the viewer", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto(`/chat/${conversationId}`);
  await expect(page.getByText("Fragmentos relevantes").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("[truncated]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("widgets.png"), fullPage: true });

  // "Ver en el documento" opens the PDF in ELISE, at the cited page.
  await page.getByText("Ver en el documento").first().click();
  const frame = page.locator("dialog iframe");
  await expect(frame).toBeVisible({ timeout: 30_000 });
  expect(await frame.getAttribute("src")).toMatch(/#page=\d+$/);
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: info.outputPath("viewer.png") });
  await expect(page.getByRole("link", { name: /Descargar/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // "Abrir documento completo" opens it from the start.
  await page.getByText("Abrir documento completo").first().click();
  await expect(frame).toBeVisible({ timeout: 30_000 });
  expect(await frame.getAttribute("src")).not.toMatch(/#page=/);
});

test("a document's actions: a ⋯ menu and a trash button", async ({ page }, info) => {
  await signIn(page);
  await page.goto(`/knowledge/spaces/${ids.space}`);
  const row = page.getByRole("listitem").filter({ hasText: "PROTOCOLO 2026.pdf" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // The actions are no longer spelled out on the row…
  await expect(row.getByRole("button", { name: "Subir nueva versión" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /^Eliminar/ })).toBeVisible();
  // …they're in its menu.
  await row.getByRole("button", { name: "Más acciones" }).click();
  await expect(page.getByRole("menuitem", { name: "Describir" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Subir nueva versión" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("space-actions.png") });
});
