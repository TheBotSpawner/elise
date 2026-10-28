import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of the progress widget (ADR-126): "N de M capítulos", the bar, the steps.
 * A seeded throwaway user with the Surface. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test progress-widget-validation --project=desktop
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
let conversationId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+progress-${info.project.name}-${Date.now()}@elise.test`;
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

test("the progress widget shows how far the goal is", async ({ page }, info) => {
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "completed" }).eq("id", userId);
  workspaceId = (await admin!.from("workspaces").select("id").eq("owner_user_id", userId).single())
    .data!.id as string;
  const ws = { workspace_id: workspaceId };
  const { data: conv } = await admin!
    .from("conversations")
    .insert({ ...ws, user_id: userId, title: "Repaso de legislación" })
    .select("id")
    .single();
  conversationId = conv!.id as string;
  await admin!.from("messages").insert([
    {
      conversation_id: conversationId,
      ...ws,
      role: "user",
      content: "Repasemos capítulo por capítulo.",
    },
    { conversation_id: conversationId, ...ws, role: "assistant", content: "Arrancamos." },
  ]);
  const now = new Date().toISOString();
  const steps = [
    "El Derecho",
    "Las personas",
    "Los bienes",
    "Los hechos y actos jurídicos",
    "Los contratos",
  ];
  const { error } = await admin!.from("live_workspaces").insert({
    ...ws,
    user_id: userId,
    conversation_id: conversationId,
    surfaces: [
      {
        id: "progress:qa",
        handle: "S1",
        type: "progress",
        title: "Repaso de Legislación",
        state: "ready",
        priority: 70,
        size: "medium",
        source: { capability: "workspace", label: "ELISE" },
        ref: null,
        payload: {
          done: 2,
          total: 5,
          unit: "capítulos",
          current: "Los bienes",
          steps: steps.map((label, i) => ({
            label,
            state: i < 2 ? "done" : i === 2 ? "current" : "pending",
          })),
          note: null,
        },
        actions: [],
        intentId: null,
        turn: 1,
        createdAt: now,
        updatedAt: now,
      },
    ],
    turn: 1,
    next_handle: 2,
    version: 1,
  });
  if (error) throw error;
  await signIn(page);
  await page.goto(`/chat/${conversationId}`);
  await expect(page.getByText("2 de 5 capítulos")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  await page.screenshot({ path: info.outputPath("progress.png") });
});
