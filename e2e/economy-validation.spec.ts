import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-094 with the real model and the real sources (DolarApi, ArgentinaDatos):
 * each question reaches its economy tool (never web search), shows a dated, sourced Surface, and
 * holidays never become calendar events.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test economy-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 400_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/economy";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+economy-${info.project.name}-${Date.now()}@elise.test`;
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

async function ask(page: Page, text: string) {
  const since = new Date().toISOString();
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 180_000 });
  await page.waitForTimeout(1_500);
  const { data: tools } = await admin!
    .from("tool_executions")
    .select("tool_name")
    .eq("workspace_id", workspaceId)
    .gte("started_at", since);
  const { data: ws } = await admin!
    .from("live_workspaces")
    .select("surfaces")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const surfaces = (ws?.surfaces ?? []) as {
    type: string;
    title: string;
    payload: Record<string, unknown>;
  }[];
  const reply = (await page.locator("body").innerText()).slice(-700);
  return { tools: (tools ?? []).map((t) => t.tool_name), surfaces, reply };
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
    .update({ onboarding_status: "skipped", timezone: "America/Argentina/Buenos_Aires" })
    .eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
});

const CASES: { name: string; ask: string; tool: string; mode: string }[] = [
  {
    name: "rates",
    ask: "ELISE, ¿a cuánto está el dólar blue y el oficial?",
    tool: "economy.exchangeRates",
    mode: "rates",
  },
  {
    name: "past-day",
    ask: "¿Cuánto estaba el dólar blue el 14 de marzo de 2025?",
    tool: "economy.exchangeHistory",
    mode: "history",
  },
  {
    name: "inflation",
    ask: "¿Cuál fue la inflación del último mes publicado?",
    tool: "economy.inflation",
    mode: "inflation",
  },
  {
    name: "accumulated",
    ask: "¿Cuánto subieron los precios acumulados en los últimos seis meses?",
    tool: "economy.inflation",
    mode: "inflation",
  },
  {
    name: "holidays",
    ask: "¿Cuándo es el próximo feriado?",
    tool: "calendar.holidays",
    mode: "holidays",
  },
  {
    name: "deposits",
    ask: "Comparame las tasas de plazo fijo disponibles",
    tool: "economy.depositRates",
    mode: "deposits",
  },
];

for (const c of CASES.filter(
  (x) => !process.env.ECONOMY_ONLY || process.env.ECONOMY_ONLY.split(",").includes(x.name),
))
  test(`'${c.ask}' → ${c.tool}, a sourced Surface, no web`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    const r = await ask(page, c.ask);
    await page.screenshot({ path: `${OUT}/${c.name}.png` });
    const surface = r.surfaces.find((s) => s.type === "economy");
    report[c.name] = {
      tools: r.tools,
      surfaces: r.surfaces.map((s) => `${s.type}:${s.title}`),
      reply: r.reply.slice(-350),
    };
    expect(r.tools).toContain(c.tool);
    expect(r.tools.some((t) => t.startsWith("web."))).toBe(false);
    expect(r.tools.some((t) => t === "calendar.createEvent")).toBe(false);
    expect(surface?.payload.mode).toBe(c.mode);
    expect((surface?.payload.sources as unknown[]).length).toBeGreaterThan(0);
  });
