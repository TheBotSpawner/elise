import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-035: ELISE managing Knowledge through conversation, Space metadata as
 * Knowledge, and the shared extraction path (a native PDF; a scanned PDF without OCR configured).
 * Real model, real Chrome. On demand only:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test knowledge-admin-validation --project=desktop
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
  email = `e2e+adr035-${info.project.name}-${Date.now()}@elise.test`;
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
  if (workspaceId) {
    const bucket = admin!.storage.from("knowledge-originals");
    const { data: items } = await admin!
      .from("knowledge_versions")
      .select("storage_path")
      .eq("workspace_id", workspaceId);
    const paths = (items ?? []).map((i) => i.storage_path as string).filter(Boolean);
    if (paths.length) await bucket.remove(paths);
    await admin!.from("workspaces").delete().eq("id", workspaceId);
  }
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Types on Home/the conversation and returns ELISE's visible answer to it. */
async function ask(page: Page, text: string): Promise<string> {
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  const before = await page
    .locator("[data-role=assistant], article")
    .count()
    .catch(() => 0);
  void before;
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 180_000 });
  // ELISE's stored answer to this message (what the user reads, minus formatting).
  await page.waitForTimeout(800);
  const { data } = await admin!
    .from("messages")
    .select("content, role, created_at, conversations!inner(user_id)")
    .eq("conversations.user_id", userId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);
  return String(data?.[0]?.content ?? "").slice(0, 1500);
}

const spaces = async () =>
  (
    await admin!
      .from("knowledge_spaces")
      .select("id, name, parent_space_id, description, context, status")
      .eq("workspace_id", workspaceId)
  ).data ?? [];

/** A one-page PDF with a text layer, or without (a "scan"). */
function pdf(text: string | null): Buffer {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "0 0 1 rg 72 72 300 300 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

test("setup: onboarding", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
});

test("Knowledge by conversation: create, describe, inspect, update — metadata answers at once", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const r1 = await ask(
    page,
    "Creame un espacio de conocimiento llamado Acme Automation. Descripción: ayuda a pequeñas empresas a reducir el trabajo administrativo repetitivo con automatización.",
  );
  const acme = (await spaces()).find((s) => s.name === "Acme Automation");
  expect(acme?.description).toMatch(/administrativo/i);

  const r2 = await ask(page, "Adentro creá una sección que se llame Onboarding.");
  const onboarding = (await spaces()).find((s) => s.name === "Onboarding");
  expect(onboarding?.parent_space_id).toBe(acme!.id);

  // A fresh conversation: no memory of having created it — only Knowledge.
  await page.getByRole("button", { name: "Nueva conversación" }).first().click();
  await page.waitForURL((u) => u.pathname === "/");
  const r3 = await ask(page, "¿Qué es Acme Automation?");
  expect(r3).toMatch(/administrativ|automatiz/i);
  expect(r3).not.toMatch(/no (encontré|tengo) (suficiente|información)/i);

  const r4 = await ask(page, "¿Qué espacios de conocimiento tengo?");
  expect(r4).toMatch(/Acme Automation/);

  await ask(
    page,
    "Actualizá la descripción de Acme Automation: además construimos asistentes de inteligencia artificial.",
  );
  expect((await spaces()).find((s) => s.name === "Acme Automation")?.description).toMatch(
    /asistentes/i,
  );
  await page.getByRole("button", { name: "Nueva conversación" }).first().click();
  await page.waitForURL((u) => u.pathname === "/");
  const r5 = await ask(page, "¿Qué hace Acme Automation?");
  expect(r5).toMatch(/asistentes/i);
  report.metadata = { r1, r2, r3, r4, r5 };
  await page.screenshot({ path: info.outputPath("metadata-answer.png") });
});

test("Documents: native PDF ready; scanned PDF says why; inventory, retry, move, archive with approval", async ({
  page,
}, info) => {
  await signIn(page);
  const onboarding = (await spaces()).find((s) => s.name === "Onboarding")!;
  await page.goto(`/knowledge/spaces/${onboarding.id}`);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([
      {
        name: "proceso-de-alta.pdf",
        mimeType: "application/pdf",
        buffer: pdf("Proceso de alta: el cliente firma el contrato y recibe acceso en 48 horas."),
      },
      { name: "contrato-escaneado.pdf", mimeType: "application/pdf", buffer: pdf(null) },
    ]);
  const items = async () =>
    (
      await admin!
        .from("knowledge_items")
        .select("id, title, status, status_detail, space_id")
        .eq("workspace_id", workspaceId)
    ).data ?? [];
  await expect
    .poll(async () => (await items()).map((i) => `${i.title}:${i.status}`).sort(), {
      timeout: 120_000,
      intervals: [2_000],
    })
    .toEqual(["contrato-escaneado.pdf:needs_attention", "proceso-de-alta.pdf:ready"]);
  const scannedItem = (await items()).find((i) => i.title === "contrato-escaneado.pdf")!;
  report.scannedReason = scannedItem.status_detail;
  expect(scannedItem.status_detail).toMatch(/scanned|OCR/i);
  await page.screenshot({ path: info.outputPath("knowledge-space.png"), fullPage: true });

  await page.goto("/");
  const inv = await ask(page, "¿Qué tengo cargado en la sección Onboarding de Acme Automation?");
  expect(inv).toMatch(/proceso-de-alta|contrato/i);
  const why = await ask(page, "¿Por qué no aparece el contrato escaneado?");
  expect(why).toMatch(/escane|OCR|reconoc/i);
  const retry = await ask(page, "Reintentá los documentos que fallaron en Acme Automation.");
  const move = await ask(
    page,
    "Mové el documento proceso-de-alta a Acme Automation como fuente general del espacio.",
  );
  await expect
    .poll(async () => (await items()).find((i) => i.title === "proceso-de-alta.pdf")?.space_id)
    .toBe((await spaces()).find((s) => s.name === "Acme Automation")!.id);
  const archive = await ask(page, "Archivá el espacio Acme Automation.");
  // Archiving always waits for approval: nothing archived yet.
  expect((await spaces()).find((s) => s.name === "Acme Automation")?.status).toBe("active");
  // The card on the Canvas (the transcript drawer holds a hidden copy).
  const approve = page.locator("button:visible", { hasText: /^Aprobar$/ }).first();
  await approve.waitFor({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("archive-approval.png") });
  await approve.click();
  await expect
    .poll(async () => (await spaces()).find((s) => s.name === "Acme Automation")?.status, {
      timeout: 30_000,
    })
    .toBe("archived");
  report.documents = { inv, why, retry, move, archive };
});
