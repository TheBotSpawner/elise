import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of the Study widget (ADR-124): "Pregunta N de M", the arrows paging through
 * the session's questions, and a tap on the status of the question on screen changing its mark.
 * A seeded throwaway user with a session and its Surface. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome npx playwright test study-widget-validation --project=desktop
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
  email = `e2e+study-${info.project.name}-${Date.now()}@elise.test`;
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

const QUESTIONS = [
  "Novación Subjetiva y Novación Objetiva: noción y ejemplos de cada una.",
  "¿Cuál es la diferencia entre el Concurso Preventivo y la Quiebra?",
  "¿Cuál es la función principal del Ingeniero en su rol de Perito?",
  "Indicar las actitudes procesales posibles que tienen las Partes.",
  "¿Qué requisitos se necesitan para promover una acción de amparo?",
];

test("setup: a study session with five questions", async () => {
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
    { conversation_id: conversationId, ...ws, role: "user", content: "Tirame preguntas del EPI." },
    { conversation_id: conversationId, ...ws, role: "assistant", content: "Modo Estudio." },
  ]);
  const marks = ["correct", "wrong", "unanswered", "wrong", "unanswered"] as const;
  const history = QUESTIONS.map((question, i) => ({
    number: i + 1,
    question,
    mark: marks[i],
    source: { itemId: crypto.randomUUID(), title: "100 CONSIGNAS para EPI.pdf", page: 10 + i },
  }));
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const { error } = await admin!.from("live_workspaces").insert({
    ...ws,
    user_id: userId,
    conversation_id: conversationId,
    surfaces: [
      {
        id: `study_question:${sessionId}`,
        handle: "S1",
        type: "study_question",
        title: "",
        state: "ready",
        priority: 96,
        size: "large",
        source: { capability: "study", label: "UTN › Legislación" },
        ref: { resource: "study_session", id: sessionId },
        payload: {
          sessionId,
          contextName: "Legislación",
          mode: "oral_exam",
          number: 5,
          question: QUESTIONS[4],
          conceptLabel: "Amparo",
          options: null,
          hints: [],
          state: "asking",
          assessment: null,
          feedback: null,
          sources: [],
          previous: null,
          feedbackMode: "each",
          scope: "Legislación",
          history,
          source: history[4]!.source,
        },
        actions: [
          { id: "next", kind: "tool" },
          { id: "end_session", kind: "tool" },
          { id: "mark", kind: "tool" },
        ],
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
});

test("the widget pages through the questions and a tap changes a mark", async ({ page }, info) => {
  await signIn(page);
  await page.goto(`/chat/${conversationId}`);
  await expect(page.getByText("Pregunta 5 de 5")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(QUESTIONS[4]!)).toBeVisible();
  await page.screenshot({ path: info.outputPath("study-current.png") });

  // ← goes back to question 4, its own source page.
  await page.getByRole("button", { name: "Pregunta anterior" }).click();
  await expect(page.getByText("Pregunta 4 de 5")).toBeVisible();
  await expect(page.getByText(QUESTIONS[3]!)).toBeVisible();
  await expect(page.getByText("Pág. 13")).toBeVisible();

  // A chip jumps to its question; tapping it again cycles its mark (dot → tick).
  await page.getByRole("button", { name: "Ver la pregunta 3" }).click();
  await expect(page.getByText("Pregunta 3 de 5")).toBeVisible();
  const chip = page.locator('[aria-current="step"]');
  await expect(chip).toHaveAttribute("title", "Sin responder");
  await chip.click();
  await expect(chip).toHaveAttribute("title", "Bien respondida");
  await page.screenshot({ path: info.outputPath("study-marked.png") });
});
