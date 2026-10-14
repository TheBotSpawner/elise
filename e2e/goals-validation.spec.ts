import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-055 (Goals v2) on a throwaway account: real Chrome, the real
 * database, the real model for the chat / voice-equivalent steps.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test goals-validation --project=desktop
 *
 * Before migration 042 the Vision steps are reported as blocked and the rest still runs (the
 * page must degrade, never break).
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
let migrated = false;
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr055-${info.project.name}-${Date.now()}@elise.test`;
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

const goalRow = (title: string) =>
  admin!
    .from("goals")
    .select("*")
    .eq("workspace_id", workspaceId)
    .ilike("title", `%${title}%`)
    .maybeSingle()
    .then((r) => r.data as Record<string, unknown> | null);

async function ask(page: Page, text: string) {
  await page.goto("/");
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 150_000 });
}

/** Surfaces of a type on the user's latest Canvas. */
async function surfaces(type: string) {
  const { data } = await admin!
    .from("live_workspaces")
    .select("surfaces")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.surfaces ?? []) as { type: string; id: string; payload: unknown }[]).filter(
    (s) => s.type === type,
  );
}

const recentTools = async () =>
  (
    await admin!
      .from("tool_executions")
      .select("tool_name")
      .eq("workspace_id", workspaceId)
      .order("started_at", { ascending: false })
      .limit(8)
  ).data?.map((c) => c.tool_name) ?? [];

test("setup: account, a Workout habit, migration check", async ({ page }) => {
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
  await admin!.from("habits").insert({
    workspace_id: workspaceId,
    name: "Workout",
    frequency_type: "weekly",
    target_value: 3,
    metadata: { icon: "🏋️" },
  });
  migrated = !(await admin!.from("visions").select("id").limit(1)).error;
  report.migration042 = migrated ? "applied" : "NOT applied (Vision steps blocked)";
});

test("1–9: empty state, Vision, a goal with target and period, progress and history", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/my-elise/goals");
  await expect(page.getByText("Todavía no tenés objetivos.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("goals-empty.png"), fullPage: true });

  // 2. Vision
  if (migrated) {
    await page.getByRole("button", { name: "Crear visión" }).click();
    const d = page.getByRole("dialog");
    await d
      .getByLabel("Visión", { exact: true })
      .fill(
        "Firbot Solutions es una agencia boutique de automatización rentable, reconocida por sistemas simples y confiables.",
      );
    await d.getByRole("button", { name: "Crear visión" }).click();
    await expect(page.getByText(/Firbot Solutions es una agencia/).first()).toBeVisible();
    report.vision = "created";
  }

  // 3–6. Goal: name, target 12, period this year, Vision
  await page
    .getByRole("button", { name: /Nuevo objetivo|Crear objetivo/ })
    .first()
    .click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Nombre").fill("Conseguir 12 clientes rentables");
  await d.getByLabel("Nombre").blur();
  await d.getByRole("radio", { name: "Número" }).click();
  await d.getByLabel("Meta").fill("12");
  await d.getByLabel("Unidad").fill("clientes");
  await d.getByLabel("Período").selectOption("this_year");
  if (migrated) {
    await d.getByRole("button", { name: "Visión", exact: true }).click();
    await d.getByPlaceholder("Agregar visión…").click();
    await page.getByRole("option", { name: /Firbot Solutions/ }).click();
  }
  await page.screenshot({ path: info.outputPath("goals-new-dialog.png") });
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  const created = await goalRow("12 clientes");
  const year = new Date().getFullYear();
  expect(created).toMatchObject({
    target_value: 12,
    metric: "clientes",
    period_start: `${year}-01-01`,
    period_end: `${year}-12-31`,
    target_date: null,
  });
  report.goal = {
    period: migrated ? [created!.period_start, created!.period_end] : "v1 columns only",
    deadline: created!.target_date,
  };

  // 7. Progress bar
  const bar = page.getByRole("progressbar").first();
  await expect(bar).toHaveAttribute("aria-valuenow", "0");

  // 8. Update to 3 from the value
  await page.getByRole("button", { name: /Actualizar progreso: 0 \/ 12/ }).click();
  const editor = page.getByRole("dialog", { name: /Actualizar progreso/ });
  await editor.getByLabel("Actual").fill("3");
  await editor.getByLabel("Nota (opcional)").fill("Cerré ACME");
  await editor.getByRole("button", { name: "Guardar" }).click();
  await expect.poll(async () => Number((await goalRow("12 clientes"))?.current_value)).toBe(3);
  await expect(page.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "25");

  // 9. History in the detail
  await page.getByRole("button", { name: "Conseguir 12 clientes rentables", exact: true }).click();
  const detail = page.getByRole("region", { name: "Conseguir 12 clientes rentables" });
  if (migrated) await expect(detail.getByText("Cerré ACME")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: info.outputPath("goals-detail.png"), fullPage: true });
  report.progress = "ok";
});

test("10–15: a habit-linked goal, a check-in moves it, goal and Vision detail", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/my-elise/goals");
  await page.getByRole("button", { name: "Nuevo objetivo" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Nombre").fill("Entrenar 36 veces");
  await d.getByRole("radio", { name: "Número" }).click();
  await d.getByLabel("Meta").fill("36");
  await d.getByLabel("Unidad").fill("entrenamientos");
  await d.getByLabel("Período").selectOption("months_3");
  await d.getByRole("button", { name: "Hábitos", exact: true }).click();
  await d.getByPlaceholder("Agregar hábito…").click();
  await page.getByRole("option", { name: /Workout/ }).click();
  await expect(d.getByRole("switch", { name: /Usar para el progreso/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  await expect.poll(async () => (await goalRow("Entrenar"))?.progress_mode).toBe("linked");

  // 12. Mark Workout today on the Habits screen
  await page.goto("/my-elise/habits");
  // Today is the last enabled day cell of the week (future days are disabled).
  await page.locator(`button[aria-label^="Workout, "]:not([disabled])`).last().click();
  const { data: habit } = await admin!
    .from("habits")
    .select("id")
    .eq("workspace_id", workspaceId)
    .single();
  await expect
    .poll(
      async () =>
        (await admin!.from("habit_entries").select("id").eq("habit_id", habit!.id)).data?.length ??
        0,
      {
        timeout: 15_000,
      },
    )
    .toBeGreaterThan(0);
  // The habit row shows its related goal.
  await expect(page.getByText("Entrenar 36 veces").first()).toBeVisible();

  // 13. The goal moved, computed in code
  await page.goto("/my-elise/goals");
  await expect(page.getByRole("button", { name: /Actualizar progreso: 1 \/ 36/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Entrenar 36 veces", exact: true }).click();
  await expect(page.getByText("suma al progreso").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("goals-linked-detail.png"), fullPage: true });

  // 15. Vision detail
  if (migrated) {
    await page
      .getByRole("button", { name: /Firbot Solutions es una agencia/ })
      .first()
      .click();
    await expect(page.getByText(/de 1 objetivo/).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("goals-vision-detail.png"), fullPage: true });
  }
  report.habitLinked = "ok";
});

test("16–18: period filters and search", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/my-elise/goals");
  const period = page.getByLabel("Período").first();
  await period.selectOption("this_quarter");
  const q = await page.getByRole("button", { name: /Actualizar progreso/ }).count();
  await period.selectOption("this_year");
  const y = await page.getByRole("button", { name: /Actualizar progreso/ }).count();
  await period.selectOption("all");
  await page.getByLabel("Buscar objetivos").fill("clientes");
  await expect(page.getByRole("button", { name: /Actualizar progreso/ })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("goals-search.png"), fullPage: true });
  report.filters = { thisQuarter: q, thisYear: y };
});

test("19–24: chat — overview Surface, relate a habit, update by voice without duplicates", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await admin!.from("goals").insert({
    workspace_id: workspaceId,
    title: "Mejorar mi estado físico",
    progress_type: "binary",
  });

  await ask(page, "¿Cómo vengo con mis objetivos de este año?");
  report.overviewTools = await recentTools();
  await expect
    .poll(async () => (await surfaces("goals_overview")).length, { timeout: 30_000 })
    .toBe(1);
  await page.screenshot({ path: info.outputPath("goals-chat-overview.png"), fullPage: true });

  await ask(page, "Relacioná Workout con mi objetivo de mejorar mi estado físico.");
  report.linkTools = await recentTools();
  const fitness = await goalRow("estado físico");
  const { data: links } = await admin!
    .from("goal_links")
    .select("resource_type")
    .eq("goal_id", fitness!.id as string);
  expect(links?.map((l) => l.resource_type)).toContain("habit");

  await ask(page, "Marcá que ya conseguí 7 de los 12 clientes.");
  report.updateTools = await recentTools();
  await expect
    .poll(async () => Number((await goalRow("12 clientes"))?.current_value), { timeout: 30_000 })
    .toBe(7);
  const clients = await goalRow("12 clientes");
  const goalSurfaces = (await surfaces("goal")).filter((s) =>
    JSON.stringify(s.payload).includes(clients!.id as string),
  );
  report.goalSurfacesForClients = goalSurfaces.length;
  expect(goalSurfaces.length).toBeLessThanOrEqual(1);
  await ask(page, "Sumale uno más a clientes.");
  await expect
    .poll(async () => Number((await goalRow("12 clientes"))?.current_value), { timeout: 30_000 })
    .toBe(8);
  const after = (await surfaces("goal")).filter((s) =>
    JSON.stringify(s.payload).includes(clients!.id as string),
  );
  expect(after.length).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("goals-chat-update.png"), fullPage: true });
  report.chat = "ok";
});

test("25–26: complete a goal, it shows in Logros with its date", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await signIn(page);
  await page.goto("/my-elise/goals");
  await page.getByRole("button", { name: "Conseguir 12 clientes rentables", exact: true }).click();
  await page
    .getByRole("region", { name: "Conseguir 12 clientes rentables" })
    .getByRole("button", { name: "Marcar logrado" })
    .first()
    .click();
  await expect.poll(async () => (await goalRow("12 clientes"))?.status).toBe("completed");
  await page.getByRole("radio", { name: /Logros/ }).click();
  await expect(page.getByText(/Logrado el/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("goals-logros.png"), fullPage: true });
  report.completed = "ok";
});

test("responsive: wide desktop, laptop, tablet and mobile", async ({ page }, info) => {
  await signIn(page);
  for (const [name, w, h] of [
    ["wide", 1920, 1080],
    ["laptop", 1366, 800],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-elise/goals");
    await expect(page.getByRole("radio", { name: /Activos/ })).toBeVisible();
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`goals-${name}.png`), fullPage: true });
  }
});
