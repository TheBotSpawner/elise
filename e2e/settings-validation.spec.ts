import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Visual QA for ADR-068 (the Settings hub). Seeds a throwaway account with Memory facts,
 * Knowledge uploads and chat attachments (metadata rows only), then captures every section on
 * desktop and phone, light and dark. Screenshots land in test-results/adr068/. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test settings-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/adr068";
let email = "";
let userId = "";
let workspaceId = "";

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+adr068-${info.project.name}-${Date.now()}@elise.test`;
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

const NOW = new Date().toISOString();

test("setup: account, memory, stored files", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!
    .from("user_profiles")
    .update({ onboarding_status: "skipped", display_name: "Leo", voice_continuous: true })
    .eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;

  const { data: conv } = await admin!
    .from("conversations")
    .insert({ workspace_id: workspaceId, user_id: userId, title: "Plan de estudio" })
    .select("id")
    .single();
  const fact = (
    id: string,
    key: string,
    value: string,
    sources: string[],
    confidence = "stated",
  ) => ({
    id,
    key,
    value,
    confidence,
    sources,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    lastConfirmedAt: NOW,
  });
  const { error: e1 } = await admin!.from("user_preferences").insert({
    workspace_id: workspaceId,
    user_id: userId,
    key: "memory.facts",
    source: "user",
    value_json: [
      fact(crypto.randomUUID(), "trabajo.horario", "Trabajo de 9 a 18; los viernes hasta las 14", [
        conv!.id,
      ]),
      fact(
        crypto.randomUUID(),
        "respuestas.formato",
        "Prefiero respuestas cortas, con viñetas",
        [],
      ),
      fact(
        crypto.randomUUID(),
        "personas.socia",
        "Mi socia en Firbot se llama Ana",
        [conv!.id],
        "inferred",
      ),
    ],
  });
  if (e1) throw e1;

  const { data: space } = await admin!
    .from("knowledge_spaces")
    .insert({ workspace_id: workspaceId, name: "Facultad", created_by_user_id: userId })
    .select("id")
    .single();
  const { data: source } = await admin!
    .from("knowledge_sources")
    .insert({
      workspace_id: workspaceId,
      space_id: space!.id,
      provider_key: "elise_native",
      source_type: "upload",
      display_name: "Apuntes",
      status: "ready",
    })
    .select("id")
    .single();
  for (const [n, title, mime, size] of [
    [1, "Análisis Matemático II — apunte.pdf", "application/pdf", 18_400_000],
    [
      2,
      "Cronograma 2026.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      420_000,
    ],
    [3, "Pizarrón clase 4.jpg", "image/jpeg", 3_100_000],
  ] as const) {
    const { data: item, error } = await admin!
      .from("knowledge_items")
      .insert({
        workspace_id: workspaceId,
        space_id: space!.id,
        source_id: source!.id,
        item_type: "file",
        external_id: `upload-${n}`,
        title,
        mime_type: mime,
        status: "ready",
      })
      .select("id")
      .single();
    if (error) throw error;
    const { error: ev } = await admin!.from("knowledge_versions").insert({
      workspace_id: workspaceId,
      knowledge_item_id: item!.id,
      version_number: 1,
      storage_path: `workspace/${workspaceId}/knowledge/${item!.id}/v1/file`,
      size_bytes: size,
      mime_type: mime,
      status: "ready",
      is_current: true,
    });
    if (ev) throw ev;
  }
  for (const [name, mime, size] of [
    ["captura.png", "image/png", 820_000],
    ["presupuesto.pdf", "application/pdf", 1_250_000],
  ] as const) {
    const { error } = await admin!.from("chat_attachments").insert({
      workspace_id: workspaceId,
      user_id: userId,
      conversation_id: conv!.id,
      name,
      mime_type: mime,
      size_bytes: size,
      storage_path: `workspace/${workspaceId}/chat/${crypto.randomUUID()}/${name}`,
      status: "sent",
      sent_at: NOW,
    });
    if (error) throw error;
  }
});

const SECTIONS = [
  "general",
  "appearance",
  "voice",
  "memory",
  "storage",
  "storage/documents",
  "shortcuts",
  "account",
  "usage",
  "billing",
];

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const [name, width, height] of [
  ["1440", 1440, 900],
  ["1920", 1920, 1040],
] as const)
  test(`desktop ${name}: every section`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signIn(page);
    for (const s of name === "1440" ? SECTIONS : ["general", "storage"]) {
      await page.goto(`/settings/${s}`);
      await expect(page.getByRole("navigation", { name: "Configuración" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${s.replace("/", "-")}.png`, fullPage: true });
      expect(await noOverflow(page)).toBe(true);
    }
    // Search → a setting in another section, highlighted.
    await page.goto("/settings/general");
    await page.getByRole("combobox", { name: "Buscar ajustes" }).fill("idioma");
    await page.screenshot({ path: `${OUT}/${name}-search.png` });
    await page.getByRole("option", { name: /Idioma de voz/ }).click();
    await page.waitForURL(/\/settings\/voice#voice-language$/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-search-target.png` });
  });

test("dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  for (const s of ["appearance", "voice", "memory", "storage", "usage"]) {
    await page.goto(`/settings/${s}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/dark-${s}.png`, fullPage: true });
  }
});

test("phone 390: list, then full-screen sections with Back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/settings");
  await expect(page.getByRole("link", { name: /Voz/ })).toBeVisible();
  await page.screenshot({ path: `${OUT}/mobile-root.png`, fullPage: true });
  expect(await noOverflow(page)).toBe(true);
  for (const s of ["voice", "appearance", "memory", "storage", "storage/images"]) {
    await page.goto(`/settings/${s}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/mobile-${s.replace("/", "-")}.png`, fullPage: true });
    expect(await noOverflow(page)).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings/voice");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/mobile-dark-voice.png`, fullPage: true });
});
