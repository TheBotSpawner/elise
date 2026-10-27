import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of the phone composer while typing: the text gets the whole first row, the
 * buttons wrap under it (they once squeezed it to a letter wide). On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test mobile-composer-validation --project=mobile
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ timeout: 180_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+composer-${info.project.name}-${Date.now()}@elise.test`;
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
  if (!userId) return;
  const ws = await admin!.from("workspaces").select("id").eq("owner_user_id", userId);
  for (const w of ws.data ?? []) await admin!.from("workspaces").delete().eq("id", w.id);
  await admin!.auth.admin.deleteUser(userId);
});

test("phone: typing keeps the text field wide", async ({ page }) => {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);

  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));

  const field = page.locator("#elise-ask");
  if (!(await field.isVisible().catch(() => false)))
    await page.getByLabel("Escribir").first().click();
  await field.click();
  await field.fill("Agregame a la lista de regalos un cucharón para Cande");
  await page.screenshot({ path: "test-results/mobile-composer.png" });
  const box = (await field.boundingBox())!;
  const viewport = page.viewportSize()!;
  // The field spans the dock's width, not a sliver beside six buttons.
  expect(box.width).toBeGreaterThan(viewport.width * 0.7);
  expect(box.height).toBeLessThan(200);
});
