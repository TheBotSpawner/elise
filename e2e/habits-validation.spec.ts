import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation of ADR-053 (Habits workspace v2) on a throwaway account seeded with
 * ten weeks of history: real Chrome, the real database, the real model for the chat steps.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test habits-validation --project=desktop
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
let today = "";
const ids: Record<string, string> = {};
const report: Record<string, unknown> = {};
const errors: string[] = [];

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

test.beforeAll(async ({}, info) => {
  email = `e2e+adr053-${info.project.name}-${Date.now()}@elise.test`;
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

const entry = (habit: string, date: string) =>
  admin!
    .from("habit_entries")
    .select("value")
    .eq("habit_id", ids[habit]!)
    .eq("entry_date", date)
    .maybeSingle()
    .then((r) => r.data);

test("setup: account with ten weeks of habit history", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  const { data: profile } = await admin!
    .from("user_profiles")
    .select("timezone")
    .eq("id", userId)
    .single();
  today = new Intl.DateTimeFormat("en-CA", { timeZone: profile!.timezone }).format(new Date());
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id;
  const start = addDays(today, -70);
  const habits = [
    { key: "workout", name: "Workout", frequency_type: "weekly", target_value: 3, icon: "🏋️" },
    {
      key: "leer",
      name: "Leer",
      frequency_type: "daily",
      target_value: 30,
      unit: "minutos",
      icon: "📚",
    },
    {
      key: "agua",
      name: "Agua",
      frequency_type: "daily",
      target_value: 8,
      unit: "vasos",
      icon: "💧",
    },
    {
      key: "meditar",
      name: "Meditar",
      frequency_type: "specific_days",
      target_value: 1,
      preferred_days: [1, 3, 5],
      icon: "🧘",
    },
    { key: "house", name: "Housekeeping", frequency_type: "weekly", target_value: 2, icon: "🧹" },
  ];
  for (const h of habits) {
    const { data, error } = await admin!
      .from("habits")
      .insert({
        workspace_id: workspaceId,
        name: h.name,
        frequency_type: h.frequency_type,
        target_value: h.target_value,
        unit: h.unit ?? null,
        preferred_days: h.preferred_days ?? [],
        start_date: start,
        metadata: { icon: h.icon },
      })
      .select("id")
      .single();
    if (error) throw error;
    ids[h.key] = data.id;
  }
  const rows: Record<string, unknown>[] = [];
  for (let i = 70; i >= 1; i--) {
    const d = addDays(today, -i);
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    const add = (k: string, value = 1) =>
      rows.push({ workspace_id: workspaceId, habit_id: ids[k], entry_date: d, value });
    if ([1, 3, 5].includes(wd) && i % 9 !== 0) add("workout");
    if (i % 4 !== 0) add("leer", i % 3 === 0 ? 20 : 30);
    add("agua", 5 + (i % 4));
    if ([1, 3, 5].includes(wd) && i % 5 !== 0) add("meditar");
    if ([2, 6].includes(wd) && i % 3 !== 0) add("house");
  }
  const { error } = await admin!.from("habit_entries").insert(rows);
  if (error) throw error;
  report.seeded = { habits: habits.length, entries: rows.length, today };
});

test("week: mark today, mark/unmark a past day, quantity on a past day, navigate", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await signIn(page);
  const t0 = Date.now();
  await page.goto("/my-elise/habits");
  await expect(page.getByRole("radio", { name: "Semana" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Cumplimiento").first()).toBeVisible();
  report.openMs = Date.now() - t0;
  await page.screenshot({ path: info.outputPath("habits-week-wide.png"), fullPage: true });

  const cell = (habit: string, label: RegExp) =>
    page.getByRole("button", { name: new RegExp(`^${habit}, ${label.source}`, "i") });
  const longDay = (d: string) =>
    new Intl.DateTimeFormat("es-AR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${d}T00:00:00Z`));

  // Mark today (binary): the cell answers at once and the check-in is stored.
  const t1 = Date.now();
  const todayCell = cell("Workout", new RegExp(longDay(today)));
  const was = await todayCell.getAttribute("aria-pressed");
  await todayCell.click();
  await expect(todayCell).toHaveAttribute("aria-pressed", was === "true" ? "false" : "true");
  report.optimisticMarkMs = Date.now() - t1;
  await expect
    .poll(async () => Boolean(await entry("workout", today)), { timeout: 20_000 })
    .toBe(was !== "true");

  // A past day: in this week if there is one, else last week.
  let past = addDays(today, -1);
  if (new Date(`${today}T00:00:00Z`).getUTCDay() === 1) {
    await page.getByRole("button", { name: "Período anterior" }).click();
    await expect(page).toHaveURL(/date=/);
  }
  past = addDays(today, -1);
  const pastCell = cell("Meditar", new RegExp(longDay(past)));
  const before = await pastCell.getAttribute("aria-pressed");
  await pastCell.click();
  await expect(pastCell).toHaveAttribute("aria-pressed", before === "true" ? "false" : "true");
  await expect
    .poll(async () => Boolean(await entry("meditar", past)), { timeout: 20_000 })
    .toBe(before !== "true");
  await pastCell.click();
  await expect(pastCell).toHaveAttribute("aria-pressed", before ?? "false");
  await expect
    .poll(async () => Boolean(await entry("meditar", past)), { timeout: 20_000 })
    .toBe(before === "true");

  // Quantity on a past day: compact editor, value stored.
  await cell("Leer", new RegExp(longDay(past))).click();
  const editor = page.getByRole("dialog", { name: /Leer/ });
  await expect(editor).toBeVisible();
  await page.screenshot({ path: info.outputPath("habits-quantity-editor.png") });
  await editor.getByLabel("Valor").fill("25");
  await editor.getByRole("button", { name: "Guardar" }).click();
  await expect(editor).toBeHidden();
  await expect
    .poll(async () => Number((await entry("leer", past))?.value ?? 0), { timeout: 20_000 })
    .toBe(25);

  // Previous / next week.
  const label = page
    .getByRole("button", { name: "Período anterior" })
    .locator("xpath=following-sibling::span[1]");
  const shown = await label.innerText();
  await page.getByRole("button", { name: "Período anterior" }).click();
  await expect(label).not.toHaveText(shown, { timeout: 20_000 });
  await page.getByRole("button", { name: "Período siguiente" }).click();
  await page
    .getByRole("button", { name: "Período siguiente" })
    .click()
    .catch(() => undefined);
  report.week = "ok";
});

test("month and year views, history editing from the month", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/habits");
  await page.getByRole("radio", { name: "Mes" }).click();
  await expect(page).toHaveURL(/view=month/);
  await expect(page.getByText("Constancia diaria")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("habits-month-laptop.png"), fullPage: true });
  // A historical day from the month calendar.
  const d = addDays(today, -3);
  const day = page.getByRole("button", {
    name: new RegExp(
      `^Housekeeping, ${new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`))}`,
      "i",
    ),
  });
  if (d.slice(0, 7) === today.slice(0, 7)) {
    const was = await day.getAttribute("aria-pressed");
    await day.click();
    await expect
      .poll(async () => Boolean(await entry("house", d)), { timeout: 20_000 })
      .toBe(was !== "true");
    report.monthEdit = "ok";
  }
  await page.getByRole("radio", { name: "Año" }).click();
  await expect(page).toHaveURL(/view=year/);
  await expect(page.getByText("Evolución del cumplimiento")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("habits-year.png"), fullPage: true });
});

test("detail, pause/resume and archive from the overflow menu", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/my-elise/habits");
  await page
    .getByRole("button", { name: /^Workout/ })
    .first()
    .click();
  const detail = page.getByRole("region", { name: "Workout" });
  await expect(detail.getByText("Racha actual")).toBeVisible();
  await expect(detail.getByText("Racha más larga")).toBeVisible();
  await expect(detail.getByText("Cargando historial…")).toHaveCount(0, { timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("habits-detail.png"), fullPage: true });
  report.detail = await detail.innerText();

  await page.getByRole("button", { name: "Acciones de Housekeeping" }).click();
  await page.getByRole("menuitem", { name: "Pausar" }).click();
  await expect
    .poll(
      async () =>
        (await admin!.from("habits").select("active").eq("id", ids.house!).single()).data?.active,
      { timeout: 20_000 },
    )
    .toBe(false);
  await page.getByLabel("Activos").selectOption("paused");
  await expect(page.getByRole("button", { name: "Acciones de Housekeeping" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Acciones de Housekeeping" }).click();
  await page.getByRole("menuitem", { name: "Reanudar" }).click();
  await expect
    .poll(
      async () =>
        (await admin!.from("habits").select("active").eq("id", ids.house!).single()).data?.active,
      { timeout: 20_000 },
    )
    .toBe(true);

  await page.getByLabel("Activos").selectOption("active");
  await page.getByRole("button", { name: "Acciones de Housekeeping" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("menuitem", { name: "Archivar" }).click();
  await expect
    .poll(
      async () =>
        (await admin!.from("habits").select("archived_at").eq("id", ids.house!).single()).data
          ?.archived_at,
      { timeout: 20_000 },
    )
    .not.toBeNull();
  await page.getByLabel("Activos").selectOption("archived");
  await expect(page.getByText("Housekeeping")).toBeVisible({ timeout: 20_000 });
  report.lifecycle = "ok";
});

test("chat: monthly habit Surface, then a check-in refreshes it", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill("¿Cómo vengo con mis hábitos este mes?");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByText(/Cumplimiento/).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("habits-chat-surface.png"), fullPage: true });
  const calls = await admin!
    .from("tool_executions")
    .select("tool_name")
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(10);
  report.chatTools = (calls.data ?? []).map((c) => c.tool_name);

  const box2 = page.locator("textarea").first();
  if (!(await box2.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box2.fill("Poné 20 minutos de lectura ayer.");
  await box2.press("Enter");
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 120_000 });
  await expect
    .poll(async () => Number((await entry("leer", addDays(today, -1)))?.value ?? 0), {
      timeout: 30_000,
    })
    .toBe(20);
  await page.screenshot({ path: info.outputPath("habits-chat-after-checkin.png"), fullPage: true });
  report.chat = "ok";
});

test("responsive: laptop, tablet and mobile", async ({ page }, info) => {
  await signIn(page);
  for (const [name, w, h] of [
    ["laptop", 1366, 800],
    ["tablet", 820, 1180],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-elise/habits");
    await expect(page.getByRole("radio", { name: "Semana" })).toBeVisible();
    report[`overflow_${name}`] = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.screenshot({ path: info.outputPath(`habits-${name}.png`), fullPage: true });
  }
});
