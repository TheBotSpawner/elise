import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-073 with a real export from another finance app (never committed):
 * analysis, the understood mapping, accounts resolved against the user's own, the background
 * import with live progress, the result, and a second import of the same file.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 FINANCE_FILE=<path.xlsx> \
 *     npx playwright test finance-migration-validation --project=desktop
 * (with `trigger dev` running for files over 500 rows)
 */
const real = process.env.E2E_REAL === "1";
const file = process.env.FINANCE_FILE;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !file || !url || !secret, "On demand: E2E_REAL=1, FINANCE_FILE, Supabase");
test.describe.configure({ mode: "serial", timeout: 600_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/finance-migration";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+migration-${info.project.name}-${Date.now()}@elise.test`;
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
  console.log(`VALIDATION ${JSON.stringify(report)}`);
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

async function upload(page: Page) {
  await page.goto("/my-elise/finance/sources");
  await page.waitForLoadState("networkidle");
  await page.locator('input[type="file"][accept*=".xlsx"]').setInputFiles(file!);
  await page.waitForURL(/\/my-elise\/finance\/import\//, { timeout: 60_000 });
  await expect(page.getByText(/^(Encontré|Necesito)/)).toBeVisible({ timeout: 120_000 });
}

test("setup: the user's own accounts and a category", async ({ page }) => {
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
  const { error } = await admin!.from("finance_accounts").insert([
    { workspace_id: workspaceId, name: "Efectivo" },
    { workspace_id: workspaceId, name: "Mercado Pago" },
  ]);
  if (error) throw error;
  await admin!
    .from("finance_categories")
    .insert({ workspace_id: workspaceId, name: "Comida", category_type: "expense" });
});

test("analysis → background import with progress → result", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  const t0 = Date.now();
  await upload(page);
  report.analysisMs = Date.now() - t0;
  report.headline = await page.getByText(/^(Encontré|Necesito)/).innerText();
  await page.screenshot({ path: `${OUT}/analysis.png`, fullPage: true });
  report.accounts = await page
    .locator("li")
    .filter({ has: page.getByRole("combobox", { name: /^Qué es/ }) })
    .evaluateAll((lis) =>
      lis.slice(0, 8).map((li) => {
        const select = li.querySelector("select")!;
        return `${li.querySelector("span")?.textContent} → ${select.options[select.selectedIndex]?.text}`;
      }),
    );
  const go = page.getByRole("button", { name: /^Importar \d+/ });
  report.button = await go.innerText();
  await go.click();
  await expect(page.getByText(/Importando movimientos|Importación completada/)).toBeVisible({
    timeout: 60_000,
  });
  await page.screenshot({ path: `${OUT}/progress.png` });
  report.progressSeen = await page.getByText(/Importando movimientos · \d+ \/ \d+/).count();
  await expect(page.getByText("Importación completada")).toBeVisible({ timeout: 300_000 });
  await page.screenshot({ path: `${OUT}/result.png` });
  report.result = await page
    .locator("body")
    .innerText()
    .then((t) => t.slice(0, 400));

  const { data: txs } = await admin!
    .from("finance_transactions")
    .select("transaction_type, account_id, to_account_id, category_id")
    .eq("workspace_id", workspaceId)
    .is("archived_at", null);
  const { data: accounts } = await admin!
    .from("finance_accounts")
    .select("id, name, source")
    .eq("workspace_id", workspaceId);
  const name = (id: string | null) => accounts?.find((a) => a.id === id)?.name ?? null;
  report.db = {
    movements: txs?.length,
    byType: Object.fromEntries(
      ["expense", "income", "transfer"].map((k) => [
        k,
        txs?.filter((t) => t.transaction_type === k).length,
      ]),
    ),
    transfersWithBothAccounts: txs?.filter(
      (t) => t.transaction_type === "transfer" && t.account_id && t.to_account_id,
    ).length,
    accounts: accounts?.map((a) => `${a.name}${a.source === "import" ? " (nueva)" : ""}`),
    cashRows: txs?.filter((t) => name(t.account_id) === "Efectivo").length,
  };
  expect(txs!.length).toBeGreaterThan(500);
  expect(accounts!.some((a) => a.name === "Cash")).toBe(false);
});

test("the same file again: everything is recognized as already imported", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await upload(page);
  await page.screenshot({ path: `${OUT}/again-mobile.png`, fullPage: true });
  report.again = await page
    .locator("body")
    .innerText()
    .then((t) => t.slice(0, 600));
  const { count } = await admin!
    .from("finance_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .is("archived_at", null);
  report.movementsAfterSecondAnalysis = count;
});
