import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-050 (Tasks workspace) and ADR-051 (Lists workspace) on a
 * throwaway account: real Chrome, the real database (with whatever migrations it has). On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test workspaces-validation --project=desktop
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
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr050-${info.project.name}-${Date.now()}@elise.test`;
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
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ws) await admin!.from("workspaces").delete().eq("id", ws.id);
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
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
  await signIn(page); // first sign-in bootstraps the workspace
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  await page.goto("/");
  await expect(page).not.toHaveURL(/onboarding|login/, { timeout: 30_000 });
});

test("Tasks: Today by default, quick add, detail, complete, views, search", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await signIn(page);
  const t0 = Date.now();
  await page.goto("/my-elise/tasks");
  await expect(page.getByRole("heading", { name: "Hoy", level: 2 })).toBeVisible();
  report.tasksOpenMs = Date.now() - t0;
  // Quick add, dated today (the Today view's default): appears in Today.
  const quick = page.getByLabel("¿Qué hay que hacer?");
  await quick.fill("Preparar propuesta Larrea");
  await quick.press("Enter");
  await expect(page.getByRole("button", { name: /Preparar propuesta Larrea/ })).toBeVisible({
    timeout: 20_000,
  });
  await page.keyboard.press("n");
  await expect(quick).toBeFocused();
  await quick.fill("Llamar a Rod");
  await quick.press("Enter");
  await expect(page.getByRole("button", { name: /Llamar a Rod/ })).toBeVisible({ timeout: 20_000 });
  // Detail: title + description, then complete from the list.
  const t1 = Date.now();
  await page.getByRole("button", { name: /Preparar propuesta Larrea/ }).click();
  const detail = page.getByRole("complementary", { name: "Preparar propuesta Larrea" });
  await expect(detail).toBeVisible();
  report.openDetailMs = Date.now() - t1;
  await detail.getByLabel("Descripción").fill("Incluir anexo de precios");
  await detail.getByLabel("Título").click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("tasks-desktop-wide.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const t2 = Date.now();
  await page.getByRole("checkbox", { name: /Marcar como hecha: Llamar a Rod/ }).click();
  // Done leaves the active view at once (optimistic), and is in Completadas.
  await expect(page.getByRole("button", { name: /Llamar a Rod/ })).toHaveCount(0);
  report.completeOptimisticMs = Date.now() - t2;
  // Search finds by description.
  await page.getByLabel("Buscar tareas").fill("anexo");
  await expect(page.getByRole("button", { name: /Preparar propuesta Larrea/ })).toBeVisible();
  await page.getByLabel("Buscar tareas").fill("");
  for (const v of ["Inbox", "Próximo", "Vencidas", "Completadas", "Todas"]) {
    await page
      .getByRole("navigation", { name: "Vistas de tareas" })
      .getByRole("button", { name: new RegExp(`^${v}`) })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: v, level: 2 })).toBeVisible();
    if (v === "Completadas")
      await expect(page.getByRole("button", { name: /Llamar a Rod/ })).toBeVisible({
        timeout: 20_000,
      });
  }
  for (const [name, w, h] of [
    ["laptop", 1280, 800],
    ["tablet", 820, 1100],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-elise/tasks");
    await page.waitForTimeout(800);
    await page.screenshot({ path: info.outputPath(`tasks-${name}.png`), fullPage: false });
    report[`tasksOverflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
  }
});

test("Lists: starters, columns, quick add, complete, detail, search, reload", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1600, height: 950 });
  await signIn(page);
  const t0 = Date.now();
  await page.goto("/my-elise/lists");
  await expect(page.getByRole("region", { name: "Lista de Compras" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lista de Viaje" })).toBeVisible();
  report.listsOpenMs = Date.now() - t0;
  const shopping = page.getByRole("region", { name: "Lista de Compras" });
  const add = shopping.getByLabel(/Agregar elemento · Lista de Compras/);
  const items = ["leche", "café", "arroz", "detergente", "shampoo", "pan", "yerba", "manteca"];
  const t1 = Date.now();
  for (const i of items) {
    await add.fill(i);
    await add.press("Enter");
  }
  await expect(add).toBeFocused();
  for (const i of items)
    await expect(shopping.getByRole("button", { name: i, exact: true })).toBeVisible({
      timeout: 20_000,
    });
  report.add8ItemsMs = Date.now() - t1;
  // Complete 3 → they move to Completados.
  for (const i of ["leche", "café", "arroz"])
    await shopping.getByRole("checkbox", { name: `Completar ${i}` }).click();
  await expect(shopping.getByRole("button", { name: /Completados \(3\)/ })).toBeVisible({
    timeout: 20_000,
  });
  // Detail: description.
  await shopping.getByRole("button", { name: "shampoo", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Elemento" });
  await sheet.getByLabel("Descripción").fill("El de coco");
  await sheet.getByLabel("Nombre").click();
  await page.waitForTimeout(1200);
  await sheet.getByRole("button", { name: "Cerrar" }).first().click();
  // Search.
  await page.getByLabel("Buscar en listas").fill("coco");
  await expect(shopping.getByRole("button", { name: /shampoo/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lista de Viaje" })).toHaveCount(0);
  await page.getByLabel("Buscar en listas").fill("");
  await page.screenshot({ path: info.outputPath("lists-desktop-wide.png") });
  // New list → appended as a column.
  await page.getByRole("button", { name: "Nueva lista" }).first().click();
  await page.getByLabel("Nombre de la lista").fill("Películas");
  await page.getByLabel("Nombre de la lista").press("Enter");
  await expect(page.getByRole("region", { name: "Películas" })).toBeVisible({ timeout: 20_000 });
  // Reload: state persists.
  await page.waitForTimeout(1500);
  await page.reload();
  const again = page.getByRole("region", { name: "Lista de Compras" });
  await expect(again.getByRole("button", { name: /Completados \(3\)/ })).toBeVisible();
  await expect(again.getByText("El de coco")).toBeVisible();
  for (const [name, w, h] of [
    ["laptop", 1280, 800],
    ["tablet", 820, 1100],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    await page.screenshot({ path: info.outputPath(`lists-${name}.png`) });
    report[`listsPageOverflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
  }
});
