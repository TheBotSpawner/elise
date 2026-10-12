import { existsSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-052 (Finance Workspace v2) on a throwaway account: real Chrome,
 * the real database (with whatever migrations it has). Imports the workbook's Movimientos export
 * when FINANCE_WORKBOOK_CSV points at it. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test finance-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const workbook = process.env.FINANCE_WORKBOOK_CSV;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr052-${info.project.name}-${Date.now()}@elise.test`;
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
  if (workspaceId) {
    const { data: files } = await admin!.storage.from("finance-imports").list(workspaceId, {
      limit: 100,
    });
    for (const dir of files ?? []) {
      const { data: inner } = await admin!.storage
        .from("finance-imports")
        .list(`${workspaceId}/${dir.name}`);
      const paths = (inner ?? []).map((f) => `${workspaceId}/${dir.name}/${f.name}`);
      if (paths.length) await admin!.storage.from("finance-imports").remove(paths);
    }
    await admin!.from("workspaces").delete().eq("id", workspaceId);
  }
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  page.on("pageerror", (e) => errors.push(`pageerror @ ${page.url()}: ${e.message.slice(0, 120)}`));
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 200)}`),
  );
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("setup: account ready (onboarding skipped)", async ({ page }) => {
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
    .maybeSingle();
  workspaceId = ws!.id;
  const v2 = await admin!.from("finance_books").select("id").limit(1);
  report.financeV2Migrated = !v2.error;
});

test("Movements: quick add, grouped list, detail, mark paid, archive + undo", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  const t0 = Date.now();
  await page.goto("/my-elise/finance");
  await expect(page.getByRole("heading", { name: "Empezá con un gasto" })).toBeVisible();
  report.financeOpenMs = Date.now() - t0;

  const add = async (o: {
    type?: string;
    amount: string;
    currency: string;
    who: string;
    pending?: boolean;
  }) => {
    await page.getByRole("button", { name: "Registrar movimiento" }).first().click();
    const dialog = page.getByRole("dialog");
    if (o.type) await dialog.getByRole("radio", { name: o.type }).click();
    await dialog.getByLabel("Monto").fill(o.amount);
    await dialog.getByLabel("Moneda").selectOption(o.currency);
    await dialog.getByLabel("Descripción").fill(o.who);
    if (o.pending) await dialog.getByLabel("Estado").selectOption("pending");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
  };
  const t1 = Date.now();
  await add({ amount: "42.000", currency: "ARS", who: "Meta Ads" });
  report.quickAddMs = Date.now() - t1;
  await add({ type: "Ingreso", amount: "2.330,83", currency: "NZD", who: "RSFA" });
  await add({ amount: "18.000", currency: "ARS", who: "Hosting anual", pending: true });

  await expect(page.getByRole("tab", { name: "Movimientos" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // KPIs per currency, never merged.
  await expect(page.locator("li").filter({ hasText: /^ARS/ }).first()).toBeVisible();
  await expect(page.locator("li").filter({ hasText: /^NZD/ }).first()).toBeVisible();
  await expect(page.getByText("Cada moneda se suma por separado")).toBeVisible();
  await expect(page.getByText(/pendiente no está incluido/)).toBeVisible();

  // Detail → mark as done.
  await page.getByRole("button", { name: /Hosting anual/ }).click();
  const detail = page.getByRole("dialog");
  await expect(detail.getByText("Pendiente")).toBeVisible();
  await detail.getByRole("button", { name: "Marcar como hecho" }).click();
  await expect(detail).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/pendiente no está incluido/)).toHaveCount(0, { timeout: 20_000 });

  // Archive + Undo.
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: /Meta Ads/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Archivar" }).click();
  await page.getByRole("button", { name: "Deshacer" }).click({ timeout: 9_000 });
  await expect(page.getByRole("button", { name: /Meta Ads/ })).toBeVisible({ timeout: 20_000 });
  report.undo = "ok";

  // Period navigation: back one month, then forward again.
  const label = page.getByRole("button", { name: "Período anterior" }).locator("xpath=..");
  const before = await label.innerText();
  await page.getByRole("button", { name: "Período anterior" }).click();
  await expect(label).not.toHaveText(before, { timeout: 20_000 });
  await expect(page.getByText("Nada coincide con estos filtros.").first()).toBeVisible();
  await page.getByRole("button", { name: "Período siguiente" }).click();
  await expect(page.getByRole("button", { name: /Meta Ads/ })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("finance-movements.png"), fullPage: true });

  // Search.
  await page.getByLabel("Buscar movimientos").fill("hosting");
  await expect(page.getByRole("button", { name: /Meta Ads/ })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Hosting anual/ })).toBeVisible();
  await page.getByLabel("Buscar movimientos").fill("");
  await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 20_000 });

  // Analysis + Budgets tabs.
  await page.getByRole("tab", { name: "Análisis" }).click();
  await expect(
    page.getByText(/Gastos por categoría|Ingresos vs.? gastos|Sin movimientos/).first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await page.screenshot({ path: info.outputPath("finance-analysis.png"), fullPage: true });
  await page.getByRole("tab", { name: "Presupuestos" }).click();
  await expect(page.getByText(/Todavía no hay presupuestos|Presupuestos de/)).toBeVisible({
    timeout: 20_000,
  });
});

test("Import the workbook's Movimientos sheet", async ({ page }, info) => {
  test.skip(!workbook || !existsSync(workbook), "FINANCE_WORKBOOK_CSV not set");
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/finance/sources");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Importar CSV o Excel" }).click();
  await (await chooser).setFiles(workbook!);
  await page.waitForURL(/\/finance\/import\//, { timeout: 60_000 });
  // The suggested mapping: Monto (positivo), Medio → account, Comprobante → reference.
  await expect(page.getByLabel(/^Monto$/)).toHaveValue("2", { timeout: 30_000 });
  await page.getByRole("button", { name: "Previsualizar" }).click();
  const importBtn = page.getByRole("button", { name: /^Importar \d+$/ });
  await expect(importBtn).toBeVisible({ timeout: 60_000 });
  report.workbookImportButton = await importBtn.innerText();
  await page.screenshot({ path: info.outputPath("finance-import-preview.png"), fullPage: true });
  const t = Date.now();
  await importBtn.click();
  // The wizard error (role alert with text), not Next.js's empty route announcer.
  const outcome = page
    .getByText(/movimientos importados/)
    .or(page.getByRole("alert").filter({ hasText: /\w/ }));
  await expect(outcome.first()).toBeVisible({ timeout: 120_000 });
  report.workbookImportOutcome = await outcome.first().innerText();
  await expect(page.getByText(/movimientos importados/)).toBeVisible();
  report.workbookImportMs = Date.now() - t;
  const { count } = await admin!
    .from("finance_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .not("import_id", "is", null);
  report.workbookImported = count;
  const { data: cats } = await admin!
    .from("finance_categories")
    .select("name")
    .eq("workspace_id", workspaceId);
  report.prefixedCategories = (cats ?? []).filter((c) => /^gastos?\s*-/i.test(c.name)).length;

  await page.goto("/my-elise/finance?period=this_year&tab=analysis");
  await expect(page.getByText(/Ingresos vs\.? gastos/).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("finance-analysis-year.png"), fullPage: true });
});

test("Report: preview, sections, PDF download", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  const t = Date.now();
  await page.goto("/my-elise/finance/reports");
  await expect(page.getByRole("heading", { name: "Reporte financiero" }).first()).toBeVisible();
  report.reportOpenMs = Date.now() - t;
  await expect(page.getByLabel("Período")).toHaveValue("last_30_days");
  await page.getByRole("checkbox", { name: "Detalle de movimientos" }).uncheck();
  await expect(page).toHaveURL(/sections=/, { timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("finance-report.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar PDF" }).click();
  const file = await download;
  const path = info.outputPath("report.pdf");
  await file.saveAs(path);
  const { readFileSync } = await import("node:fs");
  const bytes = readFileSync(path);
  report.pdfBytes = bytes.length;
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

  // Mobile layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-elise/finance");
  await expect(page.getByRole("tab", { name: "Movimientos" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  report.mobileHorizontalOverflow = overflow;
  await page.screenshot({ path: info.outputPath("finance-mobile.png"), fullPage: true });
});
