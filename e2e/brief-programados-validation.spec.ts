import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import type { ToolDisplay } from "@/core/agents/tools";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import type { EmailMessage } from "@/core/capabilities/email";
import type { EmailTriageGroup } from "@/core/capabilities/email-triage";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { applyOps, emptyWorkspace, type SurfaceDraft } from "@/core/workspace/model";

/**
 * Visual QA for ADR-067: the Morning Brief Canvas (one Communication Surface per account,
 * balanced columns) and the Programados hub with its modal editor. Seeds a throwaway account;
 * screenshots land in test-results/adr067/. On demand:
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 npx playwright test brief-programados --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/adr067";
let email = "";
let userId = "";
let workspaceId = "";
const conversations: Record<string, string> = {};

const NOW = new Date();
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const today = NOW.toISOString().slice(0, 10);

function message(
  connectionId: string,
  source: string,
  account: string,
  id: string,
  subject: string,
  from: string,
  snippet: string,
  hoursAgo: number,
): EmailMessage {
  return {
    id: `ext:${connectionId}:m:${id}`,
    threadId: `ext:${connectionId}:t:${id}`,
    from: { email: from, name: from.split("@")[0]!.replace(/\./g, " ") },
    to: [{ email: account, name: null }],
    cc: [],
    replyTo: [],
    subject,
    snippet,
    date: iso(hoursAgo),
    unread: hoursAgo < 12,
    inInbox: true,
    important: false,
    fromMe: false,
    category: "primary",
    labels: [],
    attachments: [],
    bulk: false,
    body: null,
    rfcMessageId: null,
    references: null,
    url: null,
    provenance: {
      providerKey: account.endsWith("utn.edu.ar") ? "microsoft" : "google",
      connectionId,
      externalId: id,
      source,
      account,
    },
  };
}

const ACCOUNTS = [
  {
    connectionId: "11111111-1111-4111-8111-111111111111",
    providerKey: "google" as const,
    label: "Firbot",
    address: "leo@firbotacademy.com",
    rows: [
      [
        "f1",
        "Cliente Hawesko: pedidos sin procesar",
        "ops@hawesko.de",
        "No podemos procesar 3 pedidos, ¿lo revisás hoy?",
        3,
        "high",
        "needs_reply",
      ],
      [
        "f2",
        "Factura 1043 vence mañana",
        "billing@hosting.com",
        "Recordatorio de pago",
        5,
        "medium",
        "payment",
      ],
      [
        "f3",
        "Confirmación de reunión jueves",
        "ana@cliente.com",
        "Te confirmo el horario",
        20,
        "normal",
        null,
      ],
      [
        "f4",
        "Error en escenario LL",
        "alerts@make.com",
        "El escenario falló a las 03:12",
        8,
        "medium",
        "urgent",
      ],
      [
        "f5",
        "Propuesta RSFA: comentarios",
        "pablo@rsfa.org",
        "Te paso mis notas",
        26,
        "normal",
        null,
      ],
      [
        "f6",
        "Reprogramación de la demo",
        "maria@cliente.com",
        "¿Podemos pasarla al lunes?",
        30,
        "medium",
        "needs_reply",
      ],
      ["f7", "Contrato firmado", "legal@cliente.com", "Adjunto el contrato", 40, "normal", null],
    ],
  },
  {
    connectionId: "22222222-2222-4222-8222-222222222222",
    providerKey: "google" as const,
    label: "Personal",
    address: "leojmelman@gmail.com",
    rows: [
      [
        "p1",
        "Alerta de seguridad: nuevo inicio de sesión",
        "no-reply@accounts.google.com",
        "Nuevo dispositivo Windows",
        2,
        "high",
        "urgent",
      ],
      [
        "p2",
        "Renovación del dominio leo.dev",
        "renew@registrar.com",
        "Vence en 5 días",
        10,
        "medium",
        "payment",
      ],
    ],
  },
  {
    connectionId: "33333333-3333-4333-8333-333333333333",
    providerKey: "microsoft" as const,
    label: "UTN",
    address: "lmelman@frba.utn.edu.ar",
    rows: [
      [
        "u1",
        "Cambio de aula: clase del miércoles",
        "fgonzalez@frba.utn.edu.ar",
        "La clase pasa al aula 302",
        6,
        "medium",
        "urgent",
      ],
      [
        "u2",
        "Entrega TP2: ¿confirmás tu grupo?",
        "catedra@frba.utn.edu.ar",
        "Necesitamos la lista antes del viernes",
        22,
        "medium",
        "needs_reply",
      ],
      [
        "u3",
        "Material de la semana",
        "catedra@frba.utn.edu.ar",
        "Ya está en el campus",
        30,
        "normal",
        null,
      ],
    ],
  },
] as const;

function emailDisplay(accounts: readonly (typeof ACCOUNTS)[number][]): ToolDisplay {
  const messages: EmailMessage[] = [];
  const triage: EmailTriageGroup[] = accounts.map((a) => ({
    account: {
      connectionId: a.connectionId,
      providerKey: a.providerKey,
      label: a.label,
      address: a.address,
    },
    items: a.rows.map(([id, subject, from, snippet, h, level, status]) => {
      const m = message(a.connectionId, a.label, a.address, id, subject, from, snippet, h);
      messages.push(m);
      return { messageId: m.id, level, status, reasons: status ? [status] : [] };
    }),
  }));
  return { kind: "email_list", messages, triage };
}

function event(id: string, title: string, start: string, end: string): CalendarEvent {
  return {
    id,
    calendarId: "c",
    calendarName: "Trabajo",
    title,
    description: null,
    location: null,
    start,
    end,
    allDay: false,
    attendees: [],
    status: "confirmed",
    url: null,
    provenance: { providerKey: "google", connectionId: "c", externalId: id, source: "Firbot" },
  } as CalendarEvent;
}

function canvas(accounts: readonly (typeof ACCOUNTS)[number][]) {
  const at = NOW.toISOString();
  const present = (
    tool: string,
    key: string,
    display: ToolDisplay,
    priority: number,
    args: Record<string, unknown> = {},
  ) =>
    surfacesFromOutcome(
      tool,
      { status: "succeeded", display },
      { key, priority, timezone: "America/Argentina/Buenos_Aires", locale: "es" },
    ).map((d): SurfaceDraft => ({ ...d, priority, query: { tool, args } }));
  const drafts: SurfaceDraft[] = [
    ...present(
      "calendar.listEvents",
      "cal",
      {
        kind: "event_list",
        events: [
          event("e1", "Daily Firbot", `${today}T12:00:00Z`, `${today}T12:30:00Z`),
          event("e2", "Cliente RSFA", `${today}T15:00:00Z`, `${today}T16:00:00Z`),
        ],
        from: today,
        to: today,
      },
      80,
    ),
    ...present(
      "tasks.list",
      "tasks",
      {
        kind: "task_list",
        tasks: ["Video largo RSFA", "Enviar propuesta", "Pagar hosting"].map((title, i) => ({
          id: `t${i}`,
          title,
          description: null,
          notes: null,
          status: "pending",
          priority: i === 0 ? "high" : null,
          category: null,
          dueDate: today,
          completedAt: null,
          createdAt: at,
          updatedAt: at,
          provenance: {
            providerKey: "elise_native",
            connectionId: "n",
            externalId: `t${i}`,
            source: "ELISE",
          },
        })),
      } as ToolDisplay,
      70,
    ),
    ...accounts.flatMap((a, i) =>
      present("email.triage", `mail:${a.label}`, emailDisplay([a]), 72 - i * 3, {
        destination: a.address,
      }),
    ),
  ];
  drafts.push({
    id: "visualization:habits",
    type: "visualization",
    title: "Hábitos de esta semana",
    state: "ready",
    priority: 45,
    size: "medium",
    source: { capability: "habits", label: "ELISE" },
    ref: null,
    payload: {
      spec: {
        type: "hbar",
        title: "Hábitos de esta semana",
        format: { kind: "count" },
        rows: ["Housekeeping", "Planificar el día", "Leer", "Workout", "Levantarse temprano"].map(
          (label, i) => ({ label, value: (i % 3) + 1 }),
        ),
      },
    },
    actions: [],
    intentId: "i1",
  });
  const state = applyOps(emptyWorkspace(), [
    {
      op: "intent",
      intent: { id: "i1", kind: "planning", description: "Morning Brief — QA", startedAt: at },
      at,
    },
    ...drafts.map((surface) => ({ op: "present" as const, surface, at })),
  ]);
  return state;
}

async function seedCanvas(name: string, accounts: readonly (typeof ACCOUNTS)[number][]) {
  const { data: conv, error } = await admin!
    .from("conversations")
    .insert({ workspace_id: workspaceId, user_id: userId, title: `Morning Brief — ${name}` })
    .select("id")
    .single();
  if (error) throw error;
  const state = canvas(accounts);
  const { error: e2 } = await admin!.from("live_workspaces").insert({
    workspace_id: workspaceId,
    user_id: userId,
    conversation_id: conv!.id,
    intent: state.intent,
    surfaces: state.surfaces,
    focus_id: null,
    turn: state.turn,
    next_handle: state.nextHandle,
  });
  if (e2) throw e2;
  conversations[name] = conv!.id as string;
}

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+adr067-${info.project.name}-${Date.now()}@elise.test`;
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

test("setup: account, canvases and schedules", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      {
        timeout: 30_000,
      },
    )
    .toBe(1);
  await admin!.from("user_profiles").update({ onboarding_status: "skipped" }).eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
  await seedCanvas("three", ACCOUNTS);
  await seedCanvas("one", [ACCOUNTS[0]]);
  await seedCanvas("two", [ACCOUNTS[0], ACCOUNTS[2]]);
  const base = {
    workspace_id: workspaceId,
    created_by_user_id: userId,
    timezone: "America/Argentina/Buenos_Aires",
    action_type: "morning_brief",
    schedule_type: "recurring",
    status: "active",
    next_run_at: new Date(NOW.getTime() + 86_400_000).toISOString(),
  };
  const { error } = await admin!.from("schedules").insert([
    {
      ...base,
      name: "Morning Brief",
      schedule_definition: { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "08:00" },
      configuration: {
        preset: "morning_brief",
        blocks: ["calendar", "email", "needs_reply", "tasks", "habits", "goals", "news"],
        newsTopics: "IA, automatización",
      },
      instructions: "Incluí solo mails que requieran mi atención, nada de publicidad.",
    },
    {
      ...base,
      name: "Planificación semanal",
      schedule_definition: { kind: "weekly", days: [0], time: "19:00" },
      configuration: {
        preset: "weekly_planning",
        blocks: ["calendar", "tasks", "goals"],
        horizon: "week",
      },
    },
    {
      ...base,
      name: "Cierre del día",
      status: "paused",
      schedule_definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "18:30" },
      configuration: { preset: "end_of_day", blocks: ["calendar", "tasks", "habits", "email"] },
    },
  ]);
  if (error) throw error;
});

const SIZES = [
  { name: "1920", width: 1920, height: 1040 },
  { name: "1440", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];

for (const size of SIZES)
  test(`Morning Brief canvas: ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);
    for (const name of ["three", "two", "one"]) {
      if (name !== "three" && size.name !== "1440") continue;
      await page.goto(`/chat/${conversations[name]}`);
      await expect(page.getByText("COMUNICACIÓN · FIRBOT", { exact: false }).first()).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${OUT}/brief-${name}-${size.name}.png`, fullPage: true });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow).toBe(false);
    }
  });

for (const size of SIZES)
  test(`Programados: ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page);
    await page.goto("/schedules");
    await expect(page.getByRole("heading", { name: "Programados" })).toBeVisible();
    await page.screenshot({ path: `${OUT}/schedules-${size.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Nueva tarea programada" }).click();
    await expect(page.getByLabel("Nombre")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/schedules-create-${size.name}.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Nombre")).toBeHidden();
    await page.getByRole("button", { name: "Más acciones" }).first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/schedules-menu-${size.name}.png` });
    await page.getByRole("menuitem", { name: "Editar" }).click();
    await expect(page.getByLabel("Nombre")).toHaveValue("Morning Brief");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/schedules-edit-${size.name}.png` });
  });

test("dark mode: brief and Programados", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`/chat/${conversations.three}`);
  await expect(page.getByText("COMUNICACIÓN · FIRBOT", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/brief-three-dark.png`, fullPage: true });
  await page.goto("/schedules");
  await page.getByRole("button", { name: "Nueva tarea programada" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/schedules-create-dark.png` });
});
