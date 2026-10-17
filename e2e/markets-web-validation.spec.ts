import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-074 with the real model, FMP and web search: a price is a structured
 * quote (no web), "why did it fall" is quote + fresh news, "recently" rejects old results, and
 * following assets stores resolved symbols.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test markets-web-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and Supabase");
test.describe.configure({ mode: "serial", timeout: 400_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/markets-web";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+markets-${info.project.name}-${Date.now()}@elise.test`;
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

test("'¿Cómo está Alphabet hoy?' → a structured quote, no web search", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const r = await ask(page, "¿Cómo está Alphabet hoy?");
  await page.screenshot({ path: `${OUT}/quote.png` });
  report.quote = {
    tools: r.tools,
    surfaces: r.surfaces.map((s) => `${s.type}:${s.title}`),
    reply: r.reply.slice(-300),
  };
  expect(r.tools).toContain("markets.getQuote");
  expect(r.tools.some((t) => t.startsWith("web."))).toBe(false);
  expect(r.surfaces.some((s) => s.type === "market")).toBe(true);
});

test("'¿Por qué cayó Alphabet hoy?' → quote and fresh news together", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const r = await ask(page, "¿Por qué cayó Alphabet hoy?");
  await page.screenshot({ path: `${OUT}/why.png` });
  report.why = {
    tools: r.tools,
    surfaces: r.surfaces.map((s) => `${s.type}:${s.title}`),
    reply: r.reply.slice(-400),
  };
  expect(r.tools).toContain("markets.getQuote");
  expect(r.tools.some((t) => t.startsWith("web."))).toBe(true);
});

test("'¿Hay algún discurso de Milei recientemente?' → only recent evidence", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const r = await ask(
    page,
    "ELISE, por favor, contame si hay algún discurso de Milei recientemente.",
  );
  await page.screenshot({ path: `${OUT}/recent.png` });
  const results = r.surfaces.flatMap((s) =>
    s.type === "web_results"
      ? ((s.payload.results as { title: string; publishedAt: string | null }[]) ?? []).map(
          (x) => `${x.publishedAt?.slice(0, 10) ?? "—"} ${x.title}`,
        )
      : s.type === "web_news"
        ? (
            (s.payload.events as { items: { title: string; publishedAt: string | null }[] }[]) ?? []
          ).map((e) => `${e.items[0]?.publishedAt?.slice(0, 10) ?? "—"} ${e.items[0]?.title}`)
        : [],
  );
  report.recent = { tools: r.tools, results: results.slice(0, 6), reply: r.reply.slice(-500) };
  expect(r.tools.some((t) => t.startsWith("web."))).toBe(true);
});

test("'Seguí Alphabet, Apple y Microsoft' → resolved symbols are followed", async ({ page }) => {
  await signIn(page);
  const r = await ask(page, "Seguí Alphabet, Apple y Microsoft en mis resúmenes.");
  const { data } = await admin!
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", workspaceId)
    .eq("key", "markets.watchlist")
    .maybeSingle();
  const symbols = ((data?.value_json ?? []) as { symbol: string }[]).map((i) => i.symbol);
  report.watch = { tools: r.tools, symbols, reply: r.reply.slice(-300) };
  expect(symbols.length).toBeGreaterThanOrEqual(3);
  expect(symbols).toEqual(expect.arrayContaining(["AAPL", "MSFT"]));
});
