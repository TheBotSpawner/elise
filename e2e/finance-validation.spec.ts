import { existsSync, readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of the Finance workspace (ADR-052 + ADR-054) on a throwaway account
 * loaded with the real workbook (FINANCE_WORKBOOK_CSV, the "Movimientos" export): real Chrome,
 * the real database. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test finance-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const workbook = process.env.FINANCE_WORKBOOK_CSV;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.skip(!workbook || !existsSync(workbook), "FINANCE_WORKBOOK_CSV (real data) not set");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr054-${info.project.name}-${Date.now()}@elise.test`;
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
    const { data: dirs } = await admin!.storage.from("finance-imports").list(workspaceId);
    for (const dir of dirs ?? []) {
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
  page.on("pageerror", (e) => errors.push(`pageerror @ ${page.url()}: ${e.message.slice(0, 160)}`));
  page.on(
    "console",
    (m) =>
      m.type() === "error" &&
      errors.push(`console @ ${m.location().url}: ${m.text().slice(0, 160)}`),
  );
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const rows = (page: Page) => page.locator("[data-tx]");
const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Finanzas" }).getByRole(/button|link/ as never, { name });

test("setup: account, workbook imported through the UI, Firbot Ámbito", async ({ page }) => {
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
  workspaceId = ws!.id;

  await page.setViewportSize({ width: 1440, height: 950 });
  await page.goto("/my-elise/finance");
  // Shell visible even with no data at all.
  await expect(page.getByRole("button", { name: "Estadísticas" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Empezá con un gasto" })).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Importar", exact: true }).first().click();
  await (await chooser).setFiles(workbook!);
  await page.waitForURL(/\/finance\/import\//, { timeout: 60_000 });
  await page.getByRole("button", { name: "Previsualizar" }).click();
  const importBtn = page.getByRole("button", { name: /^Importar \d+$/ });
  await expect(importBtn).toBeVisible({ timeout: 60_000 });
  await importBtn.click();
  await expect(page.getByText(/movimientos importados/)).toBeVisible({ timeout: 120_000 });
  const { count } = await admin!
    .from("finance_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  report.imported = count;

  // Business rows (with a project) belong to Firbot; the rest stay Personal / unclassified.
  const { data: firbot } = await admin!
    .from("finance_books")
    .insert({ workspace_id: workspaceId, name: "Firbot", book_type: "business" })
    .select("id")
    .single();
  await admin!
    .from("finance_transactions")
    .update({ book_id: firbot!.id })
    .eq("workspace_id", workspaceId)
    .not("project", "is", null);
  const lines = readFileSync(workbook!, "latin1").split(/\r?\n/).length;
  report.workbookLines = lines;
});

test("movements: shell, real data, scopes, Mes → Año, navigation, search, category filter", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await signIn(page);
  const t0 = Date.now();
  await page.goto("/my-elise/finance");
  await expect(page.getByRole("button", { name: "Movimientos" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  report.openMs = Date.now() - t0;
  // October has no rows: a compact state inside the feed, never onboarding.
  await expect(page.getByText(/No hay movimientos en octubre/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Empezá con un gasto" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("finance-month-empty-wide.png"), fullPage: true });

  await page.getByRole("radio", { name: "Año", exact: true }).click();
  await expect(page).toHaveURL(/gran=year/);
  await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
  const all = await rows(page).count();
  report.yearRows = all;
  await page.screenshot({ path: info.outputPath("finance-year-wide.png"), fullPage: true });

  await page.getByRole("radio", { name: "Firbot", exact: true }).click();
  await expect(page).toHaveURL(/book=/);
  await expect.poll(async () => rows(page).count(), { timeout: 20_000 }).toBeLessThan(all);
  report.firbotRows = await rows(page).count();
  await page.getByRole("radio", { name: "Personal", exact: true }).click();
  await expect
    .poll(async () => rows(page).count(), { timeout: 20_000 })
    .not.toBe(report.firbotRows);
  await page.getByRole("radio", { name: "Todos", exact: true }).click();
  await expect.poll(async () => rows(page).count(), { timeout: 20_000 }).toBe(all);

  // ‹ › on a year: 2025 has nothing, back to 2026.
  await page.getByRole("button", { name: "Período anterior" }).click();
  await expect(page.getByText("2025", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Período siguiente" }).click();
  await expect(page.getByText("2026", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByLabel("Buscar movimientos").fill("OpenAI");
  await expect(page).toHaveURL(/q=OpenAI/, { timeout: 20_000 });
  await expect.poll(async () => rows(page).count(), { timeout: 20_000 }).toBeLessThan(all);
  await page.getByLabel("Buscar movimientos").fill("");
  await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 20_000 });

  await page
    .getByLabel("Categoría")
    .first()
    .selectOption({ label: /Herramientas/ as never })
    .catch(async () => {
      const opt = page
        .getByLabel("Categoría")
        .first()
        .locator("option", { hasText: "Herramientas" });
      await page
        .getByLabel("Categoría")
        .first()
        .selectOption((await opt.getAttribute("value"))!);
    });
  await expect(page).toHaveURL(/category=Herramientas/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Quitar filtro: Categoría/ })).toBeVisible();
  await page.getByRole("button", { name: /Quitar filtro: Categoría/ }).click();
  await expect(page).not.toHaveURL(/category=/, { timeout: 20_000 });
});

test("statistics: KPIs, donut, trend, ranking; click a category to filter", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/finance?gran=year&tab=analysis");
  await expect(page.getByRole("button", { name: "Estadísticas" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const title of [
    "Ingresos vs gastos",
    "Gastos por categoría",
    "Categorías con más gasto",
    "Evolución de gastos",
  ])
    await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("finance-stats.png"), fullPage: true });
  await page
    .getByRole("button", { name: /Herramientas/ })
    .first()
    .click();
  await expect(page).toHaveURL(/category=Herramientas/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Movimientos" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(rows(page).first()).toBeVisible();
  report.drill = "ok";
});

test("budgets: create one and see its progress", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/finance?tab=budgets&gran=month&date=2026-07-01");
  await page.getByRole("button", { name: "Nuevo presupuesto" }).click();
  const cat = page.getByLabel("Categoría", { exact: true });
  const value = await cat.locator("option", { hasText: "Herramientas" }).getAttribute("value");
  await cat.selectOption(value!);
  await page.getByLabel("Monto por mes").fill("100000");
  await page.getByLabel("Moneda", { exact: true }).selectOption("ARS");
  await page.getByRole("button", { name: "Guardar presupuesto" }).click();
  await expect(page.getByRole("progressbar").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/% usado/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("finance-budgets.png"), fullPage: true });
});

test("reports: from the nav, change range, PDF", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.getByRole("link", { name: "Reportes" }).click();
  await page.waitForURL(/\/finance\/reports/);
  await expect(page.getByRole("link", { name: "Reportes" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByLabel("Período").selectOption("this_year");
  await expect(page).toHaveURL(/from=2026-01-01/, { timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("finance-report.png"), fullPage: true });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar PDF" }).click();
  const file = await download;
  const path = info.outputPath("report.pdf");
  await file.saveAs(path);
  const bytes = readFileSync(path);
  report.pdfBytes = bytes.length;
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
});

test("manual entry: modal, inline category, appears at once, edit updates everything", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.getByRole("button", { name: "Registrar movimiento" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Registrar movimiento" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Monto", { exact: true }).fill("48.000");
  await dialog.getByLabel("Descripción").fill("Veterinaria");
  await dialog.getByRole("combobox", { name: "Categoría" }).click();
  await dialog.getByRole("combobox", { name: "Categoría" }).fill("Mascotas");
  await dialog.getByRole("option", { name: /Crear categoría “Mascotas”/ }).click();
  await dialog.getByLabel("Ícono").fill("🐶");
  await dialog.getByRole("button", { name: "Crear", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Categoría" })).toHaveValue(/Mascotas/, {
    timeout: 20_000,
  });
  await page.screenshot({ path: info.outputPath("finance-modal.png") });
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /Veterinaria/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("ARS 48.000").first()).toBeVisible();

  // Edit: amount changes in the row and the KPIs.
  await page.getByRole("button", { name: /Veterinaria/ }).click();
  await page
    .getByRole("dialog", { name: "Detalle del movimiento" })
    .getByRole("button", { name: "Editar" })
    .click();
  const edit = page.getByRole("dialog", { name: "Editar movimiento" });
  await edit.getByLabel("Monto", { exact: true }).fill("52.000");
  await edit.getByRole("button", { name: "Guardar" }).click();
  await expect(edit).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText("ARS 52.000").first()).toBeVisible({ timeout: 20_000 });
  report.manual = "ok";

  for (const [name, w, h] of [
    ["laptop", 1366, 800],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-elise/finance?gran=year");
    await expect(page.getByRole("button", { name: "Movimientos" })).toBeVisible();
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`finance-${name}.png`), fullPage: true });
  }
  void nav;
});
