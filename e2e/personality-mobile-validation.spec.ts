import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-076/077 with a throwaway user: the phone Home gives the Orb the screen
 * (sized by width and height, centered, never overflowing), desktop keeps its sizing, and the
 * personality changed from chat is the one Settings shows — with the same voice.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test personality-mobile-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/personality-mobile";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+persona-${info.project.name}-${Date.now()}@elise.test`;
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

const preference = async (key: string) =>
  (
    await admin!
      .from("user_preferences")
      .select("value_json")
      .eq("workspace_id", workspaceId)
      .eq("key", key)
      .maybeSingle()
  ).data?.value_json ?? null;

test("setup", async ({ page }) => {
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
  // Something for Home's news: an overdue task.
  await admin!.from("tasks").insert({
    workspace_id: workspaceId,
    title: "Pagar la luz",
    due_date: "2026-10-01",
  });
});

const PHONES = [
  [320, 568],
  [375, 667],
  [390, 844],
  [430, 932],
] as const;

test("phone Home: the Orb leads, fits, and grows with the screen", async ({ page }) => {
  await signIn(page);
  const sizes: Record<string, unknown> = {};
  for (const [w, h] of PHONES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_500);
    const m = await page.evaluate(() => {
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const orb = box(document.querySelector("[data-orb-stage] > *"));
      const composer = box(document.querySelector("textarea"));
      const nav = box(
        document.querySelector("nav[aria-label] a[href='/']")?.closest("nav") ?? null,
      );
      return {
        orb: orb && { top: orb.top, bottom: orb.bottom, width: orb.width },
        composerBottom: composer?.bottom ?? null,
        navBottom: nav?.bottom ?? null,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        vh: window.innerHeight,
      };
    });
    await page.screenshot({ path: `${OUT}/home-${w}x${h}.png` });
    sizes[`${w}x${h}`] = m;
    expect(m.overflowX).toBe(false);
    // The box may pass the width (its glow is clipped); the page never scrolls sideways.
    expect(m.orb!.width).toBeLessThanOrEqual(w * 1.2 + 1);
    // Visible without scrolling: the Orb sits inside the viewport.
    expect(m.orb!.top).toBeGreaterThanOrEqual(0);
    expect(m.orb!.bottom).toBeLessThanOrEqual(m.vh);
  }
  report.phones = sizes;
  // The news lives behind the header's bell on phones, not under the Orb.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("¿Qué hacemos ahora?")).toBeVisible();
  await expect(page.locator("[data-ambient]")).toBeHidden();
  const bell = page.getByRole("button", { name: /novedad/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const sheet = page.getByRole("dialog", { name: "Novedades" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/vencida/i).first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/phone-notices.png` });
  const width = (k: string) => (sizes[k] as { orb: { width: number } }).orb.width;
  // Taller and wider phones get a bigger Orb; even the smallest is larger than before (190px).
  expect(width("430x932")).toBeGreaterThan(width("375x667"));
  expect(width("375x667")).toBeGreaterThan(330);
  expect(width("390x844")).toBeGreaterThan(420);
});

test("desktop Home keeps its proportions", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_500);
  const w = await page.evaluate(
    () => document.querySelector("[data-orb-stage] > *")?.getBoundingClientRect().width ?? 0,
  );
  await page.screenshot({ path: `${OUT}/home-desktop.png` });
  report.desktopOrb = w;
  // clamp(250px, min(42vw, 46dvh), 620px) at 1440×900 → 414px, as before.
  expect(Math.round(w)).toBe(414);
});

test("chat changes the personality; Settings shows it; the voice stays", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const voiceBefore = await preference("voice.preferred_voice_key");
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
  const box = page.locator("textarea").first();
  await box.fill("ELISE, cambiá tu personalidad a exigente y directa.");
  await box.press("Enter");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => preference("elise.personality"), { timeout: 20_000 }).toBe("demanding");
  const reply = (await page.locator("body").innerText()).slice(-400);
  await page.goto("/settings/personality");
  await expect(page.getByRole("radio", { name: /Exigente y directa/ })).toBeChecked();
  await page.screenshot({ path: `${OUT}/settings.png` });
  // Back to normal, from chat.
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
  await page.locator("textarea").first().fill("Volvé a tu personalidad normal.");
  await page.locator("textarea").first().press("Enter");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 120_000 });
  await expect.poll(() => preference("elise.personality"), { timeout: 20_000 }).toBe("efficient");
  report.chat = {
    reply: reply.slice(-200),
    voiceUnchanged: (await preference("voice.preferred_voice_key")) === voiceBefore,
  };
  expect(await preference("voice.preferred_voice_key")).toEqual(voiceBefore);
});
