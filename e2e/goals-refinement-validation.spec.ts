import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-057 (Goals refinement + My Elise headers): icon + title
 * headers without subtitles, "Nueva visión" beside "Nuevo objetivo", the period as a date range
 * with its duration, shortcuts that only fill dates, removable optional fields, older goals.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test goals-refinement-validation --project=desktop
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
const ids: Record<string, string> = {};
const report: Record<string, unknown> = {};
const errors: string[] = [];

test.beforeAll(async ({}, info) => {
  email = `e2e+adr057-${info.project.name}-${Date.now()}@elise.test`;
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

const goalRow = async (title: string) =>
  (
    await admin!
      .from("goals")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("title", title)
      .maybeSingle()
  ).data as Record<string, unknown> | null;

async function newGoal(page: Page, title: string) {
  await page.getByRole("button", { name: "Nuevo objetivo" }).first().click();
  const d = page.getByRole("dialog");
  await d.getByLabel("Nombre").fill(title);
  await d.getByRole("radio", { name: "Número" }).click();
  await d.getByLabel("Meta").fill("12");
  return d;
}

const MODULES = [
  ["tasks", "Tareas"],
  ["habits", "Hábitos"],
  ["goals", "Objetivos"],
  ["lists", "Listas"],
  ["notes", "Notas"],
  ["finance", "Finanzas"],
] as const;

async function checkHeaders(
  page: Page,
  theme: string,
  info: { outputPath: (n: string) => string },
) {
  for (const [path, title] of MODULES) {
    await page.goto(`/my-elise/${path}`);
    const h1 = page.getByRole("heading", { level: 1, name: title });
    await expect(h1).toBeVisible();
    expect(await h1.locator("svg").count()).toBe(1);
    // No generic subtitle under the title.
    expect(await page.locator("main header p, header:has(h1) p").count()).toBe(0);
    const box = await h1.boundingBox();
    report[`header_${theme}_${path}`] = box ? [Math.round(box.x), Math.round(box.y)] : null;
    await page.screenshot({ path: info.outputPath(`header-${theme}-${path}.png`) });
  }
}

test("setup: a habit, a Vision, a goal from before this milestone", async ({ page }) => {
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
  const { data: habit } = await admin!
    .from("habits")
    .insert({
      workspace_id: workspaceId,
      name: "Workout",
      frequency_type: "weekly",
      target_value: 3,
    })
    .select("id")
    .single();
  ids.habit = habit!.id;
  const { data: vision } = await admin!
    .from("visions")
    .insert({ workspace_id: workspaceId, title: "Firbot Solutions rentable", icon: "🚀" })
    .select("id")
    .single();
  ids.vision = vision!.id;
  // As ADR-055 created it: period this year, deadline copied from the period end.
  const { data: legacy } = await admin!
    .from("goals")
    .insert({
      workspace_id: workspaceId,
      title: "Objetivo anterior",
      progress_type: "numeric",
      target_value: 10,
      current_value: 4,
      metric: "ventas",
      period_start: "2026-01-01",
      period_end: "2026-12-31",
      target_date: "2026-12-31",
    })
    .select("id")
    .single();
  ids.legacy = legacy!.id;
  await admin!.from("goal_links").insert([
    {
      workspace_id: workspaceId,
      goal_id: ids.legacy,
      resource_type: "habit",
      resource_id: ids.habit,
    },
    {
      workspace_id: workspaceId,
      goal_id: ids.legacy,
      resource_type: "vision",
      resource_id: ids.vision,
    },
  ]);
});

test("1–2: icon + title headers, no subtitles; Nueva visión beside Nuevo objetivo", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await checkHeaders(page, "light", info);
  await page.goto("/my-elise/goals");
  const goal = page.getByRole("button", { name: "Nuevo objetivo" }).first();
  const vision = page.getByRole("button", { name: "Nueva visión" }).first();
  await expect(goal).toBeVisible();
  await expect(vision).toBeVisible();
  expect(await vision.locator("svg").count()).toBe(1);
  const [gb, vb] = [await goal.boundingBox(), await vision.boundingBox()];
  report.visionAfterGoal = Boolean(gb && vb && vb.x > gb.x);
  await vision.click();
  await expect(page.getByRole("dialog", { name: "Nueva visión" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("3–5: date ranges, durations and shortcuts", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/goals");

  let d = await newGoal(page, "Conseguir 12 clientes");
  await d.getByLabel("Desde").fill("2026-10-14");
  await d.getByLabel("Hasta").fill("2027-01-13");
  await expect(d.getByText("3 meses", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("goal-range.png") });
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  expect(await goalRow("Conseguir 12 clientes")).toMatchObject({
    period_start: "2026-10-14",
    period_end: "2027-01-13",
    target_date: null,
  });

  d = await newGoal(page, "Rango arbitrario");
  await d.getByLabel("Desde").fill("2026-10-14");
  await d.getByLabel("Hasta").fill("2026-11-27");
  await expect(d.getByText("44 días", { exact: true })).toBeVisible();
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  expect(await goalRow("Rango arbitrario")).toMatchObject({
    period_start: "2026-10-14",
    period_end: "2026-11-27",
  });

  d = await newGoal(page, "Desde atajo");
  await d.getByLabel("Atajos").selectOption("next_quarter");
  await expect(d.getByLabel("Desde")).toHaveValue("2027-01-01");
  await expect(d.getByLabel("Hasta")).toHaveValue("2027-03-31");
  await d.getByLabel("Hasta").fill("2027-03-15");
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  expect(await goalRow("Desde atajo")).toMatchObject({
    period_start: "2027-01-01",
    period_end: "2027-03-15",
  });
  await expect(page.getByText(/14 oct → 27 nov 2026 · 44 días/).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("goals-cards.png"), fullPage: true });
});

test("6: optional fields are removable before saving", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/goals");
  const d = await newGoal(page, "Con opcionales quitados");
  await d.getByRole("button", { name: "Hábitos", exact: true }).click();
  await d.getByPlaceholder("Agregar hábito…").click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /Workout/ })
    .click();
  await expect(d.getByText("Workout")).toBeVisible();
  await d.getByRole("button", { name: "Quitar Workout" }).click();
  await d.getByRole("button", { name: "Quitar Hábitos relacionados" }).click();
  await d.getByRole("button", { name: "Descripción", exact: true }).click();
  await d.getByLabel("Descripción", { exact: true }).fill("No debería guardarse");
  await d.getByRole("button", { name: "Área", exact: true }).click();
  await d.getByLabel("Área", { exact: true }).fill("Ventas");
  await d.getByRole("button", { name: "Contribuye a", exact: true }).click();
  await d.getByPlaceholder("Agregar objetivo…").click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: /Objetivo anterior/ })
    .click();
  await expect(d.getByRole("button", { name: "Quitar Objetivo anterior" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("goal-optionals.png") });
  for (const f of ["Descripción", "Área", "Contribuye a"])
    await d.getByRole("button", { name: `Quitar ${f}` }).click();
  await d.getByRole("button", { name: "Crear objetivo" }).click();
  await expect(d).toHaveCount(0);
  const created = await goalRow("Con opcionales quitados");
  expect(created).toMatchObject({ description: null, area: null, parent_goal_id: null });
  const { data: links } = await admin!
    .from("goal_links")
    .select("resource_type")
    .eq("goal_id", created!.id as string);
  expect(links ?? []).toEqual([]);
});

test("7: a goal from before this milestone keeps everything and still edits", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/my-elise/goals?goal=${ids.legacy}`);
  const detail = page.getByRole("region", { name: "Objetivo anterior" });
  await expect(detail.getByText("1 ene → 31 dic 2026 · 1 año")).toBeVisible();
  await expect(detail.getByText("Workout")).toBeVisible();
  await detail.getByRole("button", { name: "Editar" }).click();
  const d = page.getByRole("dialog");
  await expect(d.getByLabel("Desde")).toHaveValue("2026-01-01");
  await expect(d.getByLabel("Fecha límite", { exact: true })).toHaveValue("2026-12-31");
  await d.getByLabel("Nombre").fill("Objetivo anterior editado");
  await d.getByRole("button", { name: "Guardar" }).click();
  await expect(d).toHaveCount(0);
  const g = await goalRow("Objetivo anterior editado");
  expect(g).toMatchObject({
    current_value: 4,
    period_start: "2026-01-01",
    target_date: "2026-12-31",
  });
  const { data: links } = await admin!
    .from("goal_links")
    .select("resource_type")
    .eq("goal_id", ids.legacy!);
  expect((links ?? []).map((l) => l.resource_type).sort()).toEqual(["habit", "vision"]);
  await page.screenshot({ path: info.outputPath("goal-legacy.png"), fullPage: true });
});

test("8: responsive, and dark mode headers", async ({ page }, info) => {
  await signIn(page);
  for (const [name, w, h] of [
    ["desktop", 1440, 900],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-elise/goals");
    await expect(page.getByRole("button", { name: "Nuevo objetivo" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Nueva visión" }).first()).toBeVisible();
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`goals-${name}.png`), fullPage: true });
  }
  await admin!.from("user_profiles").update({ theme: "dark" }).eq("id", userId);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await checkHeaders(page, "dark", info);
});
