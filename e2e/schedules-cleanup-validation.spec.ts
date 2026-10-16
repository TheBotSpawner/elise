import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Visual QA for ADR-069: one "Correos", "Finanzas", the friendly timezone picker (Buenos Aires
 * first) and the weather city picker with real Google Places suggestions. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test schedules-cleanup --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/adr069";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+adr069-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Leo QA", preferred_language: "es" },
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

test("setup: a legacy Morning Brief (both old email options, alias timezone, text city)", async ({
  page,
}) => {
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
  const { error } = await admin!.from("schedules").insert({
    workspace_id: workspaceId,
    created_by_user_id: userId,
    name: "Morning Brief",
    status: "active",
    schedule_type: "recurring",
    timezone: "America/Sao_Paulo",
    action_type: "morning_brief",
    schedule_definition: { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "08:00" },
    configuration: {
      preset: "morning_brief",
      blocks: ["calendar", "email", "needs_reply", "tasks", "habits", "finance", "news", "weather"],
      newsTopics: "IA, automatización",
      weatherLocation: "Buenos Aires",
    },
  });
  if (error) throw error;
});

async function openEditor(page: Page) {
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Más acciones" }).first().click();
  await page.getByRole("menuitem", { name: "Editar" }).click();
  await expect(page.getByLabel("Nombre")).toHaveValue("Morning Brief");
  await page.waitForTimeout(400);
}

for (const scheme of ["light", "dark"] as const)
  test(`desktop ${scheme}: Correos, Finanzas, timezone and Places`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openEditor(page);
    const dialog = page.locator("dialog[open]");
    await expect(dialog.getByRole("checkbox", { name: "Correos" })).toBeChecked();
    await expect(dialog.getByText("Mails importantes")).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: "Finanzas", exact: true })).toBeChecked();
    await dialog.getByText("Qué mira ELISE").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/desktop-${scheme}-blocks.png` });

    // Timezone: Buenos Aires first, friendly labels.
    const tz = dialog.getByLabel("Zona horaria");
    await tz.scrollIntoViewIfNeeded();
    await tz.click();
    const first = dialog.getByRole("option").first();
    await expect(first).toContainText("Buenos Aires, Argentina");
    await page.screenshot({ path: `${OUT}/desktop-${scheme}-timezone-open.png` });
    await tz.fill("argentina");
    await page.screenshot({ path: `${OUT}/desktop-${scheme}-timezone-search.png` });
    await dialog.getByRole("option", { name: /Buenos Aires, Argentina/ }).click();
    await expect(tz).toHaveValue("Buenos Aires, Argentina");

    // Weather city: real Places suggestions.
    const city = dialog.getByLabel("Ubicación del clima");
    await city.scrollIntoViewIfNeeded();
    if (scheme === "light") await expect(dialog.getByText(/Guardada como texto/)).toBeVisible();
    await city.click();
    await city.fill("Buenos");
    const suggestion = dialog.getByRole("option", { name: /Buenos Aires/ }).first();
    const shown = await suggestion
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    report[`places_${scheme}`] = shown ? "suggestions" : "unavailable";
    await page.screenshot({ path: `${OUT}/desktop-${scheme}-places.png` });
    if (shown) {
      await suggestion.click();
      await expect(dialog.getByText(/Guardada como texto/)).toHaveCount(0, { timeout: 10_000 });
      await page.screenshot({ path: `${OUT}/desktop-${scheme}-places-picked.png` });
      if (scheme === "light") {
        await dialog.getByRole("button", { name: "Guardar" }).click();
        await expect(page.getByLabel("Nombre")).toBeHidden();
        const { data } = await admin!
          .from("schedules")
          .select("timezone, configuration")
          .eq("workspace_id", workspaceId)
          .single();
        const config = data!.configuration as Record<string, unknown>;
        report.saved = {
          timezone: data!.timezone,
          blocks: config.blocks,
          weatherPlace: config.weatherPlace,
          weatherLocation: config.weatherLocation,
        };
        expect(data!.timezone).toBe("America/Argentina/Buenos_Aires");
        expect(config.blocks).not.toContain("needs_reply");
        expect((config.weatherPlace as { placeId: string }).placeId).toBeTruthy();
      }
    }
  });

for (const [w, h] of [
  [390, 844],
  [430, 932],
] as const)
  test(`phone ${w}: one column, full-width pickers above the keyboard`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signIn(page);
    await openEditor(page);
    const dialog = page.locator("dialog[open]");
    await dialog.getByText("Qué mira ELISE").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/mobile-${w}-blocks.png` });
    const tz = dialog.getByLabel("Zona horaria");
    await tz.scrollIntoViewIfNeeded();
    await tz.click();
    await page.screenshot({ path: `${OUT}/mobile-${w}-timezone.png` });
    await page.keyboard.press("Escape");
    const city = dialog.getByLabel("Ubicación del clima");
    await city.scrollIntoViewIfNeeded();
    await city.click();
    await city.fill("Córd");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/mobile-${w}-places.png` });
    const box = await dialog.getByRole("listbox").last().boundingBox();
    if (box) expect(box.x + box.width).toBeLessThanOrEqual(w + 1);
  });
