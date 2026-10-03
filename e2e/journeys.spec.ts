import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Golden journeys (docs/engineering/22-mvp-readiness.md) against a real Supabase project with
 * a throwaway user. The model is mocked at /api/chat (a recorded NDJSON stream), so these check
 * ELISE's UI, data and permissions — not model quality. Skipped without Supabase credentials.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(
  !url || !secret,
  "Needs a Supabase project (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)",
);
// One account walks through the journeys in order; the mobile project repeats them.
test.describe.configure({ mode: "serial" });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "E2E Tester", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
});

test.afterAll(async () => {
  if (!userId) return;
  // Uploaded originals live in Storage, outside the database cascade: remove them first.
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ws) {
    const bucket = admin!.storage.from("knowledge-originals");
    const files: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      const { data } = await bucket.list(prefix, { limit: 1000 });
      for (const e of data ?? [])
        if (e.id === null) await walk(`${prefix}/${e.name}`);
        else files.push(`${prefix}/${e.name}`);
    };
    await walk(`workspace/${ws.id}`);
    if (files.length) await bucket.remove(files);
    // Before migration 22 the workspace blocked deleting its owner; deleting it first works
    // either way, and the cascade removes everything in it.
    await admin!.from("workspaces").delete().eq("id", ws.id);
  }
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** A recorded chat turn: the browser renders it exactly as a real streamed one. */
function mockChat(page: Page, events: object[]) {
  return page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    }),
  );
}

const conversation = () => ({
  type: "conversation",
  thread: { kind: "conversation", id: crypto.randomUUID() },
  runId: crypto.randomUUID(),
});

test("signup → onboarding → first Space → Home with a first prompt", async ({ page }, info) => {
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
  await signIn(page);
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByRole("heading", { name: "Hola, soy ELISE." })).toBeVisible();
  await page.getByRole("button", { name: "Empezar", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Un poco sobre vos" })).toBeVisible();
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByRole("heading", { name: "Conectá tus herramientas" })).toBeVisible();
  await expect(page.getByText("Vos elegís a qué accede ELISE.", { exact: false })).toBeVisible();
  await shot("onboarding-connect");
  await page.getByRole("button", { name: "Saltear por ahora" }).click();

  await expect(page.getByRole("heading", { name: "Creá tu primer Espacio" })).toBeVisible();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await expect(page.getByText("una Sección para cada materia", { exact: false })).toBeVisible();
  await page.getByLabel("Nombre").fill("University E2E");
  await shot("onboarding-space");
  await page.getByRole("button", { name: "Crear Espacio" }).click();

  await expect(page.getByRole("heading", { name: "ELISE está lista" })).toBeVisible();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Probá con")).toBeVisible();
  await shot("home-first-prompts");
  await expect(
    page.getByRole("button", { name: "Creá una sección para mi materia de Matemática." }),
  ).toBeVisible();

  // Onboarding is shown once.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/$/);
});

test("a Space gets its first Section — name, look, description; no type", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/knowledge");
  await page
    .getByRole("link", { name: /University E2E/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Crear primera sección" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Una parte de este Espacio", { exact: false })).toBeVisible();
  // Sections are untyped (ADR-020): nothing asks what it is "for".
  for (const gone of ["Estudio", "Cliente", "Proyecto", "General"])
    await expect(dialog.getByRole("radio", { name: new RegExp(`^${gone}`) })).toHaveCount(0);
  await dialog.getByLabel("Nombre").fill("Matemática");
  await page.screenshot({ path: info.outputPath("section-dialog.png") });
  await dialog.getByRole("button", { name: "Crear sección" }).click();
  await expect(page.getByText("Matemática").first()).toBeVisible();
});

test("History offers Space filters and grouping", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/chat");
  await expect(page.getByRole("navigation", { name: "Espacio" })).toBeVisible();
  await expect(page.getByRole("link", { name: "University E2E" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sin Espacio" })).toBeVisible();
  await page.getByRole("link", { name: "University E2E" }).click();
  await expect(page).toHaveURL(/space=/);
  await expect(page.getByRole("navigation", { name: "Sección" })).toBeVisible();
  await page.getByLabel("Agrupar por").selectOption("section");
  await expect(page).toHaveURL(/group=section/);
  await page.screenshot({ path: info.outputPath("history.png") });
});

test("a document uploaded to Knowledge shows its state", async ({ page }) => {
  await signIn(page);
  await page.goto("/knowledge");
  await page
    .getByRole("link", { name: /University E2E/ })
    .first()
    .click();
  // The same file input "Sumar fuente › Subir archivos" opens.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "programa.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(["# Programa", "", "Unidad 1: Administración general."].join("\n")),
    });
  // It is listed at once with an honest state (processing, failed with retry…), never hidden.
  await expect(page.getByText(/^programa(\.md)?$/).first()).toBeVisible();
});

test("a task added in My Elise appears in the list", async ({ page }) => {
  await signIn(page);
  await page.goto("/my-elise/tasks");
  await page.getByLabel("¿Qué hay que hacer?").fill("Llamar al banco E2E");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Llamar al banco E2E")).toBeVisible();
});

test("Connections explains access and offers Google and Notion", async ({ page }) => {
  await signIn(page);
  await page.goto("/connections");
  await expect(page.getByText("Vos elegís a qué accede ELISE.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Google" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Notion" })).toBeVisible();
});

test("a chat turn streams, and an action that needs approval says so", async ({ page }) => {
  await signIn(page);
  await mockChat(page, [
    conversation(),
    { type: "status", state: "thinking" },
    { type: "tool_started", callId: "c1", name: "email.sendDraft" },
    {
      type: "tool_finished",
      callId: "c1",
      name: "email.sendDraft",
      durationMs: 120,
      outcome: {
        status: "approval_required",
        approvalId: crypto.randomUUID(),
        summary: "Enviar el correo a ana@example.com",
        reason: "external_communication",
      },
    },
    { type: "text", delta: "Te dejé el correo listo. ¿Lo envío?" },
    { type: "done", messageId: null },
  ]);
  await page.goto("/");
  await page
    .getByLabel(/Preguntale|Pedile|Escrib/)
    .first()
    .fill("Mandale el resumen a Ana");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Te dejé el correo listo. ¿Lo envío?")).toBeVisible();
  await expect(page.getByText("Enviar el correo a ana@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Aprobar" }).first()).toBeVisible();
});

test("a failed turn gives the typed text back", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "AI_PROVIDER_ERROR",
          message: "x",
          retryable: true,
          recovery: "retry",
          referenceId: "ERR-E2E",
        },
      }),
    }),
  );
  await page.goto("/");
  const box = page.getByLabel(/Preguntale|Pedile|Escrib/).first();
  await box.fill("Planifiquemos mi día");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("Planifiquemos mi día");
});

test("a Shortcut reads as “when I say… ELISE will…”", async ({ page }) => {
  await signIn(page);
  await page.goto("/my-elise/shortcuts");
  await expect(page.getByText("Tus propias frases para ELISE")).toBeVisible();
  await page.getByRole("button", { name: "Nuevo atajo" }).first().click();
  await page.getByLabel("Nombre").fill("Arranque E2E");
  await page.getByLabel("Frases").fill("Arrancamos E2E");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Arranque E2E")).toBeVisible();
});

test("signing in again lands on Home, not onboarding", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/$/);
});
