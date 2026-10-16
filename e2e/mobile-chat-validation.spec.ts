import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of the Live Workspace on a phone (ADR-066): real model, real Chrome at
 * 390×844, a seeded throwaway user. Several Surfaces, the transcript sheet, the dock above the
 * navigation. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test mobile-chat-validation --project=mobile
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = process.env.MATRIX_OUT ?? "test-results/mobile-chat";
let email = "";
let userId = "";
let workspaceId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+mobilechat-${info.project.name}-${Date.now()}@elise.test`;
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

test("phone: Surfaces, transcript sheet, dock above the navigation", async ({ page }) => {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  const ws = { workspace_id: workspaceId };
  const today = new Date().toISOString().slice(0, 10);
  await admin!.from("tasks").insert(
    ["Pagar el hosting", "Llamar a Marcos", "Revisar propuesta"].map((title) => ({
      ...ws,
      title,
      due_date: today,
    })),
  );
  const list = (
    await admin!
      .from("lists")
      .insert({ ...ws, name: "Compras" })
      .select("id")
      .single()
  ).data!;
  await admin!.from("list_items").insert(
    ["Leche", "Yerba", "Pan"].map((content, position) => ({
      ...ws,
      list_id: list.id,
      content,
      position,
    })),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, "1-home.png") });

  // Typing: the composer is a 16px field above the navigation.
  await page.getByRole("button", { name: /Hablá o tocá para escribir/ }).click();
  const box = page.locator("textarea#elise-ask");
  await expect(box).toBeVisible();
  expect(
    await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await box.fill("Mostrame mis tareas de hoy y mi lista de Compras");
  await box.press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 150_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, "2-surfaces.png") });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The dock sits above the bottom navigation, never under it.
  const dock = await page.locator("#elise-ask, form:has(#elise-ask)").first().boundingBox();
  const nav = await page.locator("[data-bottom-nav]").boundingBox();
  if (dock && nav) expect(dock.y + dock.height).toBeLessThanOrEqual(nav.y + 1);

  // The transcript opens as a sheet above everything else.
  const toggle = page.getByRole("button", { name: /Transcript|Transcripción/i }).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, "3-transcript.png") });
  }
});
