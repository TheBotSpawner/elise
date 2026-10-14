import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of the Finance polish pass: header (wallet icon, no subtitle, no
 * "Fuentes"), no tab scrollbar arrows, Movements without an empty side column, "Importar" →
 * the import page, "+ Crear cuenta" inline in the movement dialog, neutral budget copy, both
 * themes.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test finance-polish-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+finpolish-${info.project.name}-${Date.now()}@elise.test`;
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

/** Header, tabs and Movements layout checks, in whichever theme is active. */
async function checkWorkspace(page: Page, theme: string) {
  await page.goto("/my-elise/finance");
  const h1 = page.getByRole("heading", { level: 1, name: "Finanzas" });
  await expect(h1).toBeVisible();
  expect(await h1.locator("svg").count()).toBe(1);
  await expect(page.getByText("Tus ingresos y gastos, ordenados.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Fuentes" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Importar" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Registrar movimiento" }).first()).toBeVisible();
  // The tab bar never scrolls vertically (that was the up/down arrow artifact).
  const nav = page.getByRole("navigation", { name: "Finanzas" });
  report[`tabsVerticalOverflow_${theme}`] = await nav.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(report[`tabsVerticalOverflow_${theme}`]).toBe(0);
  for (const tab of ["Movimientos", "Estadísticas", "Presupuestos", "Reportes"])
    await expect(nav.getByText(tab)).toBeVisible();
}

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
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id;
});

test("1–3: header, tabs, Movements width at desktop, laptop and tablet", async ({ page }, info) => {
  await signIn(page);
  for (const [name, w, h] of [
    ["wide", 1920, 1080],
    ["laptop", 1366, 800],
    ["tablet", 820, 1180],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await checkWorkspace(page, `light_${name}`);
    // No reserved side column when it has nothing to show: the content spans the workspace.
    const nav = await page.getByRole("navigation", { name: "Finanzas" }).boundingBox();
    const search = await page.getByPlaceholder(/Buscar movimientos/).boundingBox();
    const empty = await page.getByText("Empezá con un gasto").locator("..").boundingBox();
    report[`movementsWidth_${name}`] = {
      nav: nav?.width,
      search: search?.width,
      empty: empty?.width,
    };
    expect(Math.abs((empty?.width ?? 0) - (nav?.width ?? 0))).toBeLessThan(4);
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`finance-${name}.png`), fullPage: true });
  }
});

test("4: Importar opens the import page (files, connected sources, previous imports)", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.getByRole("link", { name: "Importar" }).first().click();
  await page.waitForURL(/\/my-elise\/finance\/sources/);
  await expect(page.getByRole("heading", { level: 1, name: "Importar" })).toBeVisible();
  await expect(page.getByText("Importar archivo")).toBeVisible();
  await expect(page.getByText("Conectar una Google Sheet")).toBeVisible();
  expect(await page.locator('input[type="file"]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("finance-import.png"), fullPage: true });
  report.import = "ok";
});

test("5–10: + Crear cuenta inline keeps the movement and selects the account", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/finance");
  await page.getByRole("button", { name: "Registrar movimiento" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Monto").fill("1500");
  await d.getByLabel("Descripción").fill("Almuerzo con cliente");
  // Category: the first suggested one.
  await d.getByLabel("Categoría").click();
  const firstCategory = page.getByRole("listbox").getByRole("option").first();
  const categoryName = (await firstCategory.textContent())?.trim() ?? "";
  await firstCategory.click();
  const scope = d.getByLabel("Ámbito");
  if (await scope.count()) await scope.selectOption({ index: 1 }).catch(() => null);
  const scopeValue = (await scope.count()) ? await scope.inputValue() : null;

  await d.getByLabel("Cuenta").click();
  await page.getByRole("listbox").getByRole("option", { name: "+ Crear cuenta" }).click();
  await d.getByLabel("Nombre", { exact: true }).fill("Banco Validación", { timeout: 10_000 });
  await expect(d.getByText("Nueva cuenta")).toBeVisible();
  await d.locator('select[aria-label="Tipo"]').last().selectOption("bank", { timeout: 10_000 });
  await page.screenshot({ path: info.outputPath("finance-new-account.png") });
  await d.getByRole("button", { name: "Crear", exact: true }).click();

  await expect(d).toBeVisible();
  await expect(d.getByLabel("Cuenta")).toHaveValue("Banco Validación", { timeout: 15_000 });
  await expect(d.getByLabel("Monto")).toHaveValue("1500");
  await expect(d.getByLabel("Descripción")).toHaveValue("Almuerzo con cliente");
  if (scopeValue !== null) await expect(scope).toHaveValue(scopeValue);
  const { data: account } = await admin!
    .from("finance_accounts")
    .select("name, account_type")
    .eq("workspace_id", workspaceId)
    .eq("name", "Banco Validación")
    .maybeSingle();
  expect(account).toBeTruthy();
  report.account = { ...account, category: categoryName, scope: scopeValue };

  await d.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(d).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText("Almuerzo con cliente").first()).toBeVisible({ timeout: 15_000 });
  const { data: tx } = await admin!
    .from("finance_transactions")
    .select("amount, currency, account_id, description")
    .eq("workspace_id", workspaceId)
    .eq("description", "Almuerzo con cliente")
    .maybeSingle();
  report.movement = tx;
  await page.screenshot({ path: info.outputPath("finance-after-save.png"), fullPage: true });
});

test("11: budgets empty state in neutral Spanish", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/finance?tab=budgets");
  await expect(page.getByText(/Todavía no hay presupuestos/)).toBeVisible();
  await expect(page.getByText(/lucas/)).toHaveCount(0);
  report.budgetCopy = await page.getByText(/Todavía no hay presupuestos/).textContent();
  await page.screenshot({ path: info.outputPath("finance-budgets.png"), fullPage: true });
});

test("12: dark mode", async ({ page }, info) => {
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await checkWorkspace(page, "dark");
  report.darkTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.screenshot({ path: info.outputPath("finance-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "Registrar movimiento" }).first().click();
  await page.getByRole("dialog").getByLabel("Cuenta").click();
  await page.getByRole("listbox").getByRole("option", { name: "+ Crear cuenta" }).click();
  await page.screenshot({ path: info.outputPath("finance-dark-dialog.png") });
  await page.keyboard.press("Escape");
  await page.goto("/my-elise/finance?tab=budgets");
  await page.screenshot({ path: info.outputPath("finance-dark-budgets.png"), fullPage: true });
  await page.goto("/my-elise/finance/sources");
  await page.screenshot({ path: info.outputPath("finance-dark-import.png"), fullPage: true });
});
