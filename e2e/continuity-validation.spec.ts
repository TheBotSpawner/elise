import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-032 (conversation continuity per tab, New Chat, History Recientes):
 * real model, real Chrome. On demand only:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test continuity-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 240_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};
const UUID = /[0-9a-f-]{36}/;

test.beforeAll(async ({}, info) => {
  email = `e2e+adr032-${info.project.name}-${Date.now()}@elise.test`;
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
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
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

async function say(page: Page, text: string) {
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/, { timeout: 60_000 });
  // The reply finished: the stop button is gone.
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 120_000 });
  return UUID.exec(page.url())![0];
}

const inicio = (page: Page) =>
  page.getByRole("navigation", { name: /principal|main/i }).getByRole("link", { name: "Inicio" });
const conversations = async () =>
  (await admin!.from("conversations").select("id").eq("user_id", userId)).data?.length ?? 0;
const pointer = (page: Page) => page.evaluate(() => sessionStorage.getItem("elise.activeThread"));

test("setup: onboarding", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
});

test("continuity: navigate away and back, reload, bare /, New Chat, History, deleted, two tabs", async ({
  page,
  context,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const before = await conversations();
  expect(before).toBe(0); // visiting Home creates nothing

  // A: a conversation with something on the Canvas.
  const a = await say(page, "Creá la tarea 'Revisar continuidad' para mañana.");
  await expect(inicio(page)).toHaveAttribute("aria-current", "page");
  const surfacesA = await page.locator("article, [data-surface]").count();

  // B: Schedules (and a scheduled result if any), then Inicio → A again, Canvas as it was.
  await page.getByRole("link", { name: "Programados" }).first().click();
  await page.waitForURL(/\/schedules/);
  await expect(inicio(page)).toHaveAttribute("href", `/chat/${a}`);
  await inicio(page).click();
  await page.waitForURL(`**/chat/${a}`);
  await expect(page.getByText("Revisar continuidad").first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("restored-a.png") });

  // Reload keeps it; a bare "/" reopens it.
  await page.reload();
  await expect(page.getByText("Revisar continuidad").first()).toBeVisible();
  await page.goto("/");
  await page.waitForURL(`**/chat/${a}`);

  // New Chat: fresh Home, A untouched, nothing created until the first message.
  await page.getByRole("button", { name: "Nueva conversación" }).first().click();
  await page.waitForURL((u) => u.pathname === "/");
  expect(await pointer(page)).toBeNull();
  await expect(inicio(page)).toHaveAttribute("href", "/");
  expect(await conversations()).toBe(1);
  const { data: aRow } = await admin!
    .from("conversations")
    .select("archived_at")
    .eq("id", a)
    .single();
  expect(aRow!.archived_at).toBeNull();
  const b = await say(page, "Decime solo la palabra hola.");
  expect(b).not.toBe(a);
  expect(JSON.parse((await pointer(page))!)).toEqual({ kind: "conversation", id: b });

  // History: Espacios then Recientes; tag A to the Space to see "Space" on its row.
  const { data: space } = await admin!
    .from("knowledge_spaces")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("name", "Facultad QA")
    .single();
  await admin!.from("interaction_knowledge_links").insert({
    workspace_id: workspaceId,
    user_id: userId,
    conversation_id: a,
    space_id: space!.id,
    source: "manual",
  });
  await page.goto("/chat");
  await expect(inicio(page)).not.toHaveAttribute("aria-current", "page");
  const recents = page.getByRole("region", { name: "Recientes" });
  await expect(page.getByRole("heading", { name: "Espacios" })).toBeVisible();
  await expect(recents).toBeVisible();
  const rows = await recents.getByRole("link").allInnerTexts();
  report.recents = rows;
  expect(rows[0]).toMatch(/hola/i);
  expect(rows[1]).toMatch(/Facultad QA/);
  await page.screenshot({ path: info.outputPath("history-recents.png"), fullPage: true });
  // Filter: only that Space's threads, titled accordingly.
  await page.goto(`/chat?space=${space!.id}`);
  await expect(page.getByRole("heading", { name: "Recientes en Facultad QA" })).toBeVisible();
  expect(
    await page
      .getByRole("region", { name: /Recientes/ })
      .getByRole("link")
      .count(),
  ).toBe(1);
  // Search replaces folders + Recientes with flat results.
  await page.goto("/chat?q=continuidad");
  await expect(page.getByRole("heading", { name: /Recientes/ })).toHaveCount(0);
  await page.goto("/chat");

  // Opening A from Recientes makes it active; elsewhere → Inicio → A.
  await recents.getByRole("link").nth(1).click();
  await page.waitForURL(`**/chat/${a}`);
  await page.goto("/knowledge");
  await inicio(page).click();
  await page.waitForURL(`**/chat/${a}`);

  // Two tabs: a new tab starts fresh and keeps its own.
  const tab2 = await context.newPage();
  await tab2.goto("/");
  expect(await pointer(tab2)).toBeNull();
  await expect(tab2.getByText("Revisar continuidad")).toHaveCount(0);
  const c = await say(tab2, "Decime solo la palabra chau.");
  await tab2.goto("/schedules");
  await inicio(tab2).click();
  await tab2.waitForURL(`**/chat/${c}`);
  await page.goto("/schedules");
  await inicio(page).click();
  await page.waitForURL(`**/chat/${a}`);
  await tab2.close();

  // Deleted elsewhere: Inicio falls back to a fresh Home and forgets it.
  await admin!.from("conversations").update({ archived_at: new Date().toISOString() }).eq("id", a);
  await page.goto("/schedules");
  await inicio(page).click();
  await page.waitForURL((u) => u.pathname === "/" && !u.search, { timeout: 20_000 });
  expect(await pointer(page)).toBeNull();
  report.flow = { a, b, c, surfacesA };
});

test("mobile: compose = New Chat; Recientes compact", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/chat");
  await expect(page.getByRole("region", { name: "Recientes" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile-history.png"), fullPage: true });
  const first = page.getByRole("region", { name: "Recientes" }).getByRole("link").first();
  await first.click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}/);
  await page.screenshot({ path: info.outputPath("mobile-conversation.png") });
  await page.getByRole("button", { name: "Nueva conversación" }).first().click();
  await page.waitForURL((u) => u.pathname === "/");
  expect(await pointer(page)).toBeNull();
});
