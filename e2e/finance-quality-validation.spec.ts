import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { strToU8, zipSync } from "fflate";

import { mercadoPagoSettlementCsv } from "../tests/fixtures/mercado-pago-settlement";

/**
 * Real validation of ADR-075 with a throwaway user: ELISE's own dialogs (never the browser's),
 * back links, category icons / rename / delete, the Mercado Pago report through the Finance
 * screen and through chat (same pipeline, Trigger.dev import), and a generic .xlsx in chat.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test finance-quality-validation --project=desktop
 * (with `trigger dev` running: imports run in the background)
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 400_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/finance-quality";
const CSV = Buffer.from(mercadoPagoSettlementCsv());
let email = "";
let userId = "";
let workspaceId = "";
let nativeDialogs = 0;
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+finq-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  report.nativeDialogs = nativeDialogs;
  console.log(`VALIDATION ${JSON.stringify(report)}`);
  if (workspaceId) await admin!.from("workspaces").delete().eq("id", workspaceId);
  if (userId) await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  // Any browser-native dialog is a failure of this milestone.
  page.on("dialog", (d) => {
    nativeDialogs++;
    void d.dismiss();
  });
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const categories = async () =>
  (
    await admin!
      .from("finance_categories")
      .select("id, name, category_type, icon")
      .eq("workspace_id", workspaceId)
  ).data ?? [];

async function openCategories(page: Page) {
  await page.goto("/my-elise/finance");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Más", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Categorías" }).click();
  await expect(page.getByRole("dialog", { name: "Categorías" })).toBeVisible();
}

async function askWithFile(
  page: Page,
  text: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const since = new Date().toISOString();
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  if (
    !(await page
      .locator("textarea")
      .first()
      .isVisible()
      .catch(() => false))
  )
    await page.getByRole("button", { name: "Escribir" }).first().click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Adjuntar un archivo" }).first().click();
  await (await chooser).setFiles(file);
  await page.getByRole("button", { name: /Adjuntar a este mensaje/ }).click();
  await expect(page.getByText(file.name).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2_500);
  const box = page.locator("textarea").first();
  await box.fill(text);
  await box.press("Enter");
  // The turn starts (Stop shows) — slower with a file — and then ends.
  await expect(page.getByRole("button", { name: "Detener" }))
    .toBeVisible({ timeout: 30_000 })
    .catch(() => undefined);
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 240_000 });
  await page.waitForTimeout(1_500);
  const { data: tools } = await admin!
    .from("tool_executions")
    .select("tool_name")
    .eq("workspace_id", workspaceId)
    .gte("started_at", since);
  const reply = (await page.locator("body").innerText()).slice(-900);
  return { tools: (tools ?? []).map((t) => t.tool_name), reply };
}

test("setup: categories with movements, twins by type, the wallet's account", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
  // Finance prepares its starter categories on the first visit.
  await page.goto("/my-elise/finance");
  await page.waitForLoadState("networkidle");
  await admin!.from("finance_accounts").insert({
    workspace_id: workspaceId,
    name: "Mercado Pago",
    account_type: "digital_wallet",
    source: "user_ui",
  });
  const { data: cats, error } = await admin!
    .from("finance_categories")
    .insert([
      { workspace_id: workspaceId, name: "Regalos", category_type: "expense", source: "user_ui" },
      { workspace_id: workspaceId, name: "Préstamos", category_type: "expense", source: "user_ui" },
      { workspace_id: workspaceId, name: "Préstamos", category_type: "income", source: "user_ui" },
    ])
    .select("id, name, category_type");
  if (error) throw error;
  const regalos = cats!.find((c) => c.name === "Regalos")!.id;
  const loanOut = cats!.find((c) => c.category_type === "expense" && c.name === "Préstamos")!.id;
  const tx = (category_id: string, amount: string, day: string) => ({
    workspace_id: workspaceId,
    transaction_type: "expense",
    amount,
    currency: "ARS",
    transaction_date: `2026-10-${day}`,
    category_id,
    source: "user_ui",
    status: "completed",
    fingerprint: `${day}|${amount}|${category_id}`,
  });
  const ins = await admin!
    .from("finance_transactions")
    .insert([
      tx(regalos, "1000", "01"),
      tx(regalos, "2500", "02"),
      tx(regalos, "300", "03"),
      tx(loanOut, "50000", "04"),
    ]);
  if (ins.error) throw ins.error;
  report.setup = { categories: (await categories()).length };
});

test("A · '+' opens ELISE's 'Nuevo ámbito', never the browser's prompt", async ({ page }) => {
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuevo ámbito" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo ámbito" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Nombre")).toBeFocused();
  await dialog.getByLabel("Nombre").fill("  Trabajo  ");
  await dialog.getByLabel("Nombre").press("Enter");
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("radio", { name: /Trabajo/ })).toBeVisible();
  // A second "Trabajo" is refused inline.
  await page.getByRole("button", { name: "Nuevo ámbito" }).click();
  await dialog.getByLabel("Nombre").fill("trabajo");
  await dialog.getByRole("button", { name: "Crear ámbito" }).click();
  await expect(dialog.getByText("Ya existe un ámbito con ese nombre.")).toBeVisible();
  await page.screenshot({ path: `${OUT}/scope.png` });
  report.scope = { nativeDialogs };
  expect(nativeDialogs).toBe(0);
});

test("B · child pages say 'Volver a …'", async ({ page }) => {
  await signIn(page);
  await page.goto("/my-elise/finance/connect");
  await expect(page.getByRole("link", { name: "Volver a Importar" })).toBeVisible();
  await page.goto("/my-elise/finance/sources");
  await expect(page.getByRole("link", { name: "Volver a Finanzas" })).toBeVisible();
});

test("C/D · emoji from the picker, rename by id, friendly duplicate", async ({ page }) => {
  await signIn(page);
  await openCategories(page);
  const dialog = page.getByRole("dialog", { name: "Categorías" });
  // Icon: a button that opens ELISE's picker; any emoji, ZWJ included.
  await dialog.getByRole("button", { name: "Ícono: Regalos" }).click();
  const picker = page.getByRole("dialog", { name: "Ícono: Regalos" });
  await picker.getByLabel("Pegá o escribí un emoji…").fill("👨‍💻");
  await picker.getByRole("button", { name: "👨‍💻" }).last().click();
  const regalosRow = dialog.locator("li", { has: page.getByLabel("Nombre: Regalos") });
  await regalosRow.getByRole("button", { name: "Guardar" }).click();
  await expect
    .poll(async () => (await categories()).find((c) => c.name === "Regalos")?.icon, {
      timeout: 15_000,
    })
    .toBe("👨‍💻");
  // Rename the expense "Préstamos" only (an income one has the same name).
  const loanRow = dialog.locator("li", { has: page.getByLabel("Nombre: Préstamos") }).first();
  await loanRow.getByLabel("Nombre: Préstamos").fill("Créditos");
  await loanRow.getByRole("button", { name: "Guardar" }).click();
  await expect
    .poll(async () => (await categories()).filter((c) => c.name === "Créditos").length, {
      timeout: 15_000,
    })
    .toBe(1);
  const after = await categories();
  expect(after.find((c) => c.name === "Créditos")!.category_type).toBe("expense");
  expect(after.find((c) => c.name === "Préstamos")!.category_type).toBe("income");
  // A duplicate name: the reason, not "Error inesperado".
  const creditRow = dialog.locator("li", { has: page.getByLabel("Nombre: Créditos") });
  await creditRow.getByLabel("Nombre: Créditos").fill("regalos");
  await creditRow.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog.getByText("Ya existe una categoría con ese nombre.")).toBeVisible();
  await page.screenshot({ path: `${OUT}/categories.png` });
  // After a reload the emoji is intact.
  await openCategories(page);
  await expect(
    page
      .getByRole("dialog", { name: "Categorías" })
      .getByRole("button", { name: "Ícono: Regalos" }),
  ).toHaveText("👨‍💻");
  report.categories = { renamed: true, emoji: "👨‍💻" };
});

test("E · deleting a category with movements keeps them, uncategorized", async ({ page }) => {
  await signIn(page);
  await openCategories(page);
  const dialog = page.getByRole("dialog", { name: "Categorías" });
  await dialog.getByRole("button", { name: "Eliminar categoría: Regalos" }).click();
  const confirm = page.getByRole("dialog", { name: "Eliminar “Regalos”" });
  await expect(confirm.getByText(/Hay 3 movimientos usando esta categoría/)).toBeVisible();
  await page.screenshot({ path: `${OUT}/delete-confirm.png` });
  await confirm.getByRole("button", { name: "Eliminar categoría" }).click();
  await page.waitForTimeout(3_000);
  const gone = !(await categories()).some((c) => c.name === "Regalos");
  const { data: txs } = await admin!
    .from("finance_transactions")
    .select("id, category_id, amount")
    .eq("workspace_id", workspaceId)
    .in("amount", ["1000", "2500", "300"]);
  const toast = (await page.locator("body").innerText()).match(
    /Categoría eliminada\.|necesita la última actualización|latest ELISE database update|No pudimos eliminar/,
  )?.[0];
  report.delete = {
    gone,
    kept: txs?.length,
    uncategorized: txs?.every((t) => !t.category_id),
    toast,
  };
  expect(txs).toHaveLength(3);
  expect(nativeDialogs).toBe(0);
});

test("F · Mercado Pago report through the Finance screen: only the currency is asked", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/my-elise/finance/sources");
  await page.waitForLoadState("networkidle");
  await page
    .locator('input[type="file"][accept*=".xlsx"]')
    .setInputFiles({ name: "settlement-report.csv", mimeType: "text/csv", buffer: CSV });
  await page.waitForURL(/\/my-elise\/finance\/import\//, { timeout: 60_000 });
  await expect(page.getByText(/Reconocí un reporte de Mercado Pago/)).toBeVisible({
    timeout: 120_000,
  });
  const currency = page.getByLabel("Moneda del archivo");
  await expect(currency).toBeVisible();
  await expect(page.getByLabel("Tipo de movimiento")).toHaveValue("sign");
  await currency.selectOption("ARS");
  await expect(page.getByRole("button", { name: "Importar 230" })).toBeEnabled({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/ui-import.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancelar" }).last().click();
  report.ui = { importable: 230 };
});

test("G · the same file in chat: same analysis, no 'truncado', durable import", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const r = await askWithFile(page, "¿Me importás estos movimientos a mis finanzas personales?", {
    name: "settlement-report.csv",
    mimeType: "text/csv",
    buffer: CSV,
  });
  await page.screenshot({ path: `${OUT}/chat-card.png` });
  report.chat = { tools: r.tools, reply: r.reply.slice(-400) };
  expect(r.tools).toContain("finance.importFile");
  expect(r.reply).not.toMatch(/truncad|volv[eé] a adjuntar|adjuntalo de nuevo/i);
  const card = page
    .locator("section, article, div")
    .filter({ hasText: "settlement-report.csv" })
    .filter({
      has: page.getByLabel("Moneda del archivo"),
    });
  await card.last().getByLabel("Moneda del archivo").selectOption("ARS");
  await card.last().getByRole("button", { name: "Importar 230" }).click();
  await expect
    .poll(
      async () =>
        (
          await admin!
            .from("imports")
            .select("status, imported_rows")
            .eq("workspace_id", workspaceId)
            .eq("status", "completed")
        ).data?.[0]?.imported_rows,
      { timeout: 240_000, intervals: [3_000] },
    )
    .toBe(230);
  const { data: imp } = await admin!
    .from("imports")
    .select("runtime_job_id, imported_rows, source_label")
    .eq("workspace_id", workspaceId)
    .eq("status", "completed")
    .single();
  const { data: txs } = await admin!
    .from("finance_transactions")
    .select("account_id, currency, category_id")
    .eq("workspace_id", workspaceId)
    .eq("source", "import");
  report.chatImport = {
    imported: imp?.imported_rows,
    background: Boolean(imp?.runtime_job_id),
    accounts: new Set(txs?.map((t) => t.account_id)).size,
    currencies: [...new Set(txs?.map((t) => t.currency))],
  };
  expect(txs).toHaveLength(230);
});

test("H · a generic .xlsx in chat: sheets and columns, no OCR, no 'unsupported'", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const r = await askWithFile(page, "¿Qué hojas y columnas tiene este Excel?", {
    name: "presupuesto.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbook()),
  });
  report.xlsx = { tools: r.tools, reply: r.reply.slice(-400) };
  expect(r.reply).toMatch(/Gastos/);
  expect(r.reply).toMatch(/Monto/);
  expect(r.reply).not.toMatch(/no puedo leer|no soportad|formato no/i);
});

test("mobile · dialogs fit a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Nuevo ámbito" }).click();
  const box = await page.getByRole("dialog", { name: "Nuevo ámbito" }).boundingBox();
  await page.screenshot({ path: `${OUT}/mobile-scope.png` });
  await page.keyboard.press("Escape");
  await openCategories(page);
  await page
    .getByRole("dialog", { name: "Categorías" })
    .getByRole("button", { name: /^Ícono: / })
    .first()
    .click();
  const picker = await page.getByRole("dialog", { name: /^Ícono: / }).boundingBox();
  await page.screenshot({ path: `${OUT}/mobile-picker.png` });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  report.mobile = { scopeWidth: box?.width, pickerWidth: picker?.width, overflow };
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(picker!.width).toBeLessThanOrEqual(390);
  expect(overflow).toBe(false);
});

/** "Gastos": Fecha, Concepto, Monto + two rows. */
function workbook(): Uint8Array {
  const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const cell = (r: string, v: string) => `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      xml(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      ),
    ),
    "_rels/.rels": strToU8(
      xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    ),
    "xl/workbook.xml": strToU8(
      xml(
        `<workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="Gastos" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      ),
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      xml(
        `<worksheet ${ns}><sheetData><row r="1">${cell("A1", "Fecha")}${cell("B1", "Concepto")}${cell("C1", "Monto")}</row><row r="2">${cell("A2", "2026-10-01")}${cell("B2", "Luz")}${cell("C2", "-8000")}</row><row r="3">${cell("A3", "2026-10-02")}${cell("B3", "Sueldo")}${cell("C3", "350000")}</row></sheetData></worksheet>`,
      ),
    ),
  });
}
