import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-072: completing a habit day, a task and a goal pops once, sounds once
 * (counted at the Web Audio level), vibrates on touch screens, respects reduced motion, never
 * replays on reload — and the generic copy (a new Vision) on desktop and phone.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test completion-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/completion";
const TZ = "America/Argentina/Buenos_Aires";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+done-${info.project.name}-${Date.now()}@elise.test`;
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

/** Counts what the completion feedback does, without changing it. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const fx = { tones: 0, pops: 0, vibrations: 0 };
    (window as unknown as { __fx: typeof fx }).__fx = fx;
    const osc = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      fx.tones++;
      return osc.call(this);
    };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      fx.pops++;
      return animate.apply(this, args);
    };
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => {
        fx.vibrations++;
        return true;
      },
    });
  });
}
const fx = (page: Page) =>
  page.evaluate(() => ({ ...(window as unknown as { __fx: Record<string, number> }).__fx }));

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

const longDay = (d: string) =>
  new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));

async function seed() {
  const ws = { workspace_id: workspaceId, created_by_user_id: userId };
  await admin!.from("habit_entries").delete().eq("workspace_id", workspaceId);
  await admin!.from("tasks").delete().eq("workspace_id", workspaceId);
  await admin!.from("goals").delete().eq("workspace_id", workspaceId);
  await admin!.from("habits").delete().eq("workspace_id", workspaceId);
  await admin!
    .from("habits")
    .insert({ ...ws, name: "Leer 20 minutos", frequency_type: "daily", target_value: 1 });
  await admin!.from("tasks").insert({ ...ws, title: "Renovar el pasaporte", due_date: today });
  await admin!
    .from("goals")
    .insert({ ...ws, title: "Leer 12 libros este año", progress_type: "binary" });
}

test("setup", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!
    .from("user_profiles")
    .update({ onboarding_status: "skipped", timezone: TZ })
    .eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
});

async function completeAll(page: Page, tag: string) {
  report[`${tag}-steps`] = {};
  const steps = report[`${tag}-steps`] as Record<string, unknown>;
  const errors: string[] = [];
  steps.errors = errors;
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) =>
    errors.push(
      `pageerror @ ${new URL(page.url()).pathname}: ${e.message.slice(0, 120)} ${(e.stack ?? "")
        .split(/\n/)
        .slice(1, 3)
        .join(" | ")
        .slice(0, 300)}`,
    ),
  );
  // Habit day.
  await page.goto("/my-elise/habits");
  await page.waitForLoadState("networkidle");
  const cell = page.getByRole("button", {
    name: new RegExp(`^Leer 20 minutos, ${longDay(today)}`, "i"),
  });
  await cell.first().click();
  steps.afterClick = await fx(page);
  await page.waitForTimeout(800);
  steps.entryInDb = (
    await admin!.from("habit_entries").select("status").eq("workspace_id", workspaceId)
  ).data;
  steps.pressedAfter = await cell.first().getAttribute("aria-pressed");
  await expect(cell.first()).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: `${OUT}/${tag}-habit.png` });
  steps.habitDone = await fx(page);
  // Unchecking is quiet; a re-check within the moment doesn't replay.
  await cell.first().click();
  await expect(cell.first()).toHaveAttribute("aria-pressed", "false");
  steps.habitUndone = await fx(page);
  await cell.first().click();
  steps.habitRedone = await fx(page);
  // Reload: an already-completed day renders quietly (refetch never replays).
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(cell.first()).toHaveAttribute("aria-pressed", "true");
  steps.habitReload = await fx(page);

  // Task.
  await page.goto("/my-elise/tasks");
  await page.waitForLoadState("networkidle");
  const box = page.getByRole("checkbox", { name: "Marcar como hecha: Renovar el pasaporte" });
  await box.click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/${tag}-task.png` });
  steps.task = await fx(page);
  await expect
    .poll(
      async () =>
        (await admin!.from("tasks").select("status").eq("workspace_id", workspaceId)).data?.[0]
          ?.status,
    )
    .toBe("completed");

  // Goal.
  await page.goto("/my-elise/goals");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Leer 12 libros este año", exact: true }).click();
  steps.ringBefore = await page.locator("[data-goal-ring]").count();
  await page
    .getByRole("region", { name: "Leer 12 libros este año" })
    .getByRole("button", { name: "Marcar logrado" })
    .first()
    .click();
  await expect
    .poll(
      async () =>
        (await admin!.from("goals").select("status").eq("workspace_id", workspaceId)).data?.[0]
          ?.status,
    )
    .toBe("completed");
  // Felt when the server's answer reaches the page (shortly after the database has it).
  await expect.poll(async () => (await fx(page)).tones, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/${tag}-goal.png` });
  steps.goal = await fx(page);
  return steps;
}

test("desktop: habit, task and goal each feel finished once", async ({ page }) => {
  await seed();
  await page.setViewportSize({ width: 1440, height: 900 });
  await instrument(page);
  await signIn(page);
  const s = await completeAll(page, "desktop");
  report.desktop = s;
  // Habit: two notes and one pop; undo adds nothing; re-check inside the moment adds nothing.
  expect(s.habitDone).toMatchObject({ tones: 2, pops: 1, vibrations: 0 });
  expect(s.habitUndone).toEqual(s.habitDone);
  // Checked again: a new completion (felt again), unless it lands inside the 1.5 s "same tap"
  // window — timing-dependent here; the unit tests pin the window itself.
  expect([2, 4]).toContain((s.habitRedone as { tones: number }).tones);
  expect(s.habitReload).toMatchObject({ tones: 0, pops: 0 });
  expect(s.task).toMatchObject({ tones: 2, pops: 1 });
  expect(s.goal).toMatchObject({ tones: 3, pops: 1 });
});

test("phone: touch, haptics, reduced motion; the Vision example is generic", async ({
  browser,
}) => {
  await seed();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await instrument(page);
  await signIn(page);
  const s = await completeAll(page, "mobile");
  report.mobile = s;
  // Reduced motion: no pop, the sound and the haptic tap still confirm it.
  expect(s.habitDone).toMatchObject({ tones: 2, pops: 0, vibrations: 1 });
  expect(s.task).toMatchObject({ tones: 2, pops: 0, vibrations: 1 });
  expect(s.goal).toMatchObject({ tones: 3, vibrations: 1 });

  await page.goto("/my-elise/goals");
  await page.getByRole("button", { name: "Nueva visión" }).first().click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByText("Una dirección a largo plazo.")).toBeVisible();
  await expect(dialog.getByPlaceholder("Construir un negocio sostenible")).toBeVisible();
  await page.screenshot({ path: `${OUT}/mobile-vision.png` });
  report.visionCopy = await dialog.innerText();
  await context.close();
});
