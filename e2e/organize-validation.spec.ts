import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real-browser validation for ADR-070: Mi ELISE modules only hide (data and pages stay), and
 * History conversations move between Spaces from "…" and by drag & drop, rename, pin, archive.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test organize-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/adr070";
let email = "";
let userId = "";
let workspaceId = "";
let conversationId = "";
let firbotId = "";
let generalId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+adr070-${info.project.name}-${Date.now()}@elise.test`;
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

const links = async () =>
  (
    await admin!
      .from("interaction_knowledge_links")
      .select("space_id, state, source")
      .eq("conversation_id", conversationId)
  ).data ?? [];
const linkedTo = async () =>
  (await links()).filter((l) => l.state === "linked").map((l) => l.space_id);

test("setup: a goal, two Spaces, a conversation with messages", async ({ page }) => {
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
  const { error: eg } = await admin!
    .from("goals")
    .insert({ workspace_id: workspaceId, title: "Correr 10K", created_by_user_id: userId });
  if (eg) throw eg;
  const { data: spaces } = await admin!
    .from("knowledge_spaces")
    .select("id, name")
    .eq("workspace_id", workspaceId);
  generalId = spaces?.find((s) => s.name === "General")?.id ?? "";
  if (!generalId) {
    const { data } = await admin!
      .from("knowledge_spaces")
      .insert({ workspace_id: workspaceId, name: "General", created_by_user_id: userId })
      .select("id")
      .single();
    generalId = data!.id;
  }
  const { data: firbot } = await admin!
    .from("knowledge_spaces")
    .insert({ workspace_id: workspaceId, name: "Firbot Marketing", created_by_user_id: userId })
    .select("id")
    .single();
  firbotId = firbot!.id;
  const { data: conv } = await admin!
    .from("conversations")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      title: "Ajuste de un timer de cinco minutos",
    })
    .select("id")
    .single();
  conversationId = conv!.id;
  await admin!.from("messages").insert([
    {
      conversation_id: conversationId,
      workspace_id: workspaceId,
      role: "user",
      content: "Poné un timer de cinco minutos",
    },
    {
      conversation_id: conversationId,
      workspace_id: workspaceId,
      role: "assistant",
      content: "Listo, cinco minutos.",
    },
  ]);
});

test("Mi ELISE: hiding Objetivos only hides it; showing brings it back as it was", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/connections");
  const toggle = page.getByRole("switch", { name: "Mostrar Objetivos en Mi ELISE" });
  await toggle.click();
  await expect(page.getByText("Objetivos se ocultó de Mi ELISE.")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: `${OUT}/connections-goals-hidden.png` });
  await page.reload();
  await expect(page.getByRole("switch", { name: "Mostrar Objetivos en Mi ELISE" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page
    .getByRole("button", { name: /Mi ELISE/ })
    .first()
    .click();
  await page.screenshot({ path: `${OUT}/menu-goals-hidden.png` });
  const menuHasGoals = await page.getByRole("menuitem", { name: "Objetivos" }).count();
  report.menuHasGoalsWhenHidden = menuHasGoals;
  expect(menuHasGoals).toBe(0);
  const { data: goals } = await admin!
    .from("goals")
    .select("title")
    .eq("workspace_id", workspaceId);
  expect(goals?.map((g) => g.title)).toEqual(["Correr 10K"]);
  // The page itself still works (bookmarks, links from ELISE).
  await page.goto("/my-elise/goals");
  await expect(page.getByText("Correr 10K").first()).toBeVisible();

  await page.goto("/connections");
  await page.getByRole("switch", { name: "Mostrar Objetivos en Mi ELISE" }).click();
  await expect(page.getByText("Objetivos volvió a Mi ELISE.")).toBeVisible();
  await page
    .getByRole("button", { name: /Mi ELISE/ })
    .first()
    .click();
  await expect(page.getByRole("menuitem", { name: "Objetivos" }).first()).toBeVisible();
  await page.goto("/my-elise/goals");
  await expect(page.getByText("Correr 10K").first()).toBeVisible();
});

test("History: move from …, drag & drop, remove, rename, pin, archive and restore", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/chat");
  const title = "Ajuste de un timer de cinco minutos";
  const row = page.getByRole("listitem").filter({ hasText: title }).first();
  await row.hover();
  await row.getByRole("button", { name: `Opciones de conversación: ${title}` }).click();
  await page.screenshot({ path: `${OUT}/history-menu.png` });
  await page.getByRole("menuitem", { name: "Mover a Espacio" }).click();
  await page.screenshot({ path: `${OUT}/history-move-dialog.png` });
  await page.locator("dialog[open]").getByRole("button", { name: "General" }).click();
  await expect(page.getByText("Conversación movida a General")).toBeVisible();
  await expect.poll(linkedTo).toEqual([generalId]);

  // Drag & drop onto the Firbot Marketing chip.
  await page.reload();
  const dragRow = page.getByRole("listitem").filter({ hasText: title }).first();
  const chip = page.getByRole("link", { name: "Firbot Marketing" }).first();
  await dragRow.dragTo(chip);
  await expect.poll(linkedTo, { timeout: 15_000 }).toEqual([firbotId]);
  await page.screenshot({ path: `${OUT}/history-after-drag.png`, fullPage: true });

  // Remove from the Space, rename, pin.
  await page.reload();
  const r2 = page.getByRole("listitem").filter({ hasText: title }).first();
  await r2.hover();
  await r2.getByRole("button", { name: `Opciones de conversación: ${title}` }).click();
  await page.getByRole("menuitem", { name: "Quitar del Espacio" }).click();
  await expect.poll(linkedTo).toEqual([]);
  await page.reload();
  const r3 = page.getByRole("listitem").filter({ hasText: title }).first();
  await r3.hover();
  await r3.getByRole("button", { name: `Opciones de conversación: ${title}` }).click();
  await page.getByRole("menuitem", { name: "Renombrar" }).click();
  await page.getByRole("textbox", { name: "Nombre" }).fill("Timer de cocina");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Timer de cocina").first()).toBeVisible();
  const r4 = page.getByRole("listitem").filter({ hasText: "Timer de cocina" }).first();
  await r4.hover();
  await r4.getByRole("button", { name: /Opciones de conversación/ }).click();
  await page.getByRole("menuitem", { name: "Fijar" }).click();
  await expect(page.getByText("Conversación fijada")).toBeVisible();
  await page.screenshot({ path: `${OUT}/history-pinned.png`, fullPage: true });

  // Archive, find it in Archivadas, restore.
  const r5 = page.getByRole("listitem").filter({ hasText: "Timer de cocina" }).first();
  await r5.hover();
  await r5.getByRole("button", { name: /Opciones de conversación/ }).click();
  await page.getByRole("menuitem", { name: "Archivar" }).click();
  await expect(page.getByText("Conversación archivada")).toBeVisible();
  // Gone from the normal view at once.
  await expect(page.getByRole("listitem").filter({ hasText: "Timer de cocina" })).toHaveCount(0);
  await page.getByRole("link", { name: "Archivadas" }).first().click();
  await page.waitForURL(/view=archived/);
  await expect(page.getByText("Timer de cocina").first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/history-archived.png` });
  const r6 = page.getByRole("listitem").filter({ hasText: "Timer de cocina" }).first();
  await r6.hover();
  await r6.getByRole("button", { name: /Opciones de conversación/ }).click();
  await page.getByRole("menuitem", { name: "Desarchivar" }).click();
  await expect(page.getByText("Conversación restaurada")).toBeVisible();

  const { data: messages } = await admin!
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId);
  report.messages = messages?.length;
  report.links = await links();
  expect(messages).toHaveLength(2);
});

test("History on a phone: the same actions from the … sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/chat");
  const row = page.getByRole("listitem").filter({ hasText: "Timer de cocina" }).first();
  await row.getByRole("button", { name: /Opciones de conversación/ }).click();
  await page.screenshot({ path: `${OUT}/mobile-sheet.png` });
  await page.getByRole("menuitem", { name: "Mover a Espacio" }).click();
  await page.screenshot({ path: `${OUT}/mobile-move.png` });
  await page.locator("dialog[open]").getByRole("button", { name: "Firbot Marketing" }).click();
  await expect.poll(linkedTo).toEqual([firbotId]);
});
