import { mkdirSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-071 (answer first, source second): a Knowledge question shows the
 * answer, the source documents stay one tap away, and asking for the document shows it.
 *
 *   E2E_REAL=1 E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test answer-first-validation --project=desktop
 */
const real = process.env.E2E_REAL === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 600_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/answer-first";
let email = "";
let userId = "";
let workspaceId = "";
let spaceId = "";
const report: Record<string, unknown> = {};

/** Synthetic material, written like the real competitive analysis (no real customer data). */
const REPORT = `# Firbot Academy — Informe de inteligencia competitiva 2026

## Mapa competitivo

CenteIA es el competidor más cercano de Firbot Academy: comparte audiencia (dueños de pymes y equipos administrativos) y el mismo dolor (tareas repetitivas de oficina). Su programa formativo es más largo que Firbot 10H.

El resto no son competidores directos sino referentes parciales:

- Ivan AlsiGo — referente de casos concretos de automatización de oficina.
- Anders Jensen — referente de claridad práctica, transparencia y enfoque B2B.
- Ben Corde — referente de velocidad, actualidad y demostración visual.

Referentes de contenido y posicionamiento:

- Nick Saraev — content-to-offer y sistemas de adquisición.
- msbintel — hooks SUPER COLD y comunicación de resultado inmediato.
- manuelnocode — referente útil para el rediseño operativo.
`;

const POSITIONING = `# Firbot — Documento de posicionamiento

Firbot Academy enseña automatización con IA para oficinas en 10 horas (Firbot 10H). Promesa: recuperar horas de trabajo administrativo cada semana sin programar.
`;

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+answer-${info.project.name}-${Date.now()}@elise.test`;
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

/** Types into the current conversation (a follow-up stays in the same thread). */
async function say(page: Page, text: string) {
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForTimeout(1_000);
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 180_000 });
  await page.waitForTimeout(1_500);
}

type Stored = { type: string; title: string; payload: Record<string, unknown> };
const canvas = async (): Promise<Stored[]> =>
  ((
    await admin!
      .from("live_workspaces")
      .select("surfaces")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ).data?.surfaces ?? []) as Stored[];

test("setup: Firbot Marketing with two documents, ready", async ({ page }) => {
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
  const { data: space, error } = await admin!
    .from("knowledge_spaces")
    .insert({ workspace_id: workspaceId, name: "Firbot Marketing", created_by_user_id: userId })
    .select("id")
    .single();
  if (error) throw error;
  spaceId = space!.id as string;
  await page.goto(`/knowledge/spaces/${spaceId}`);
  // The Space's own upload (the same input "Sumar fuente › Documentos" opens).
  await page
    .locator('input[type="file"][multiple][accept*=".md"]')
    .first()
    .setInputFiles([
      {
        name: "Firbot Competitive Intelligence Report.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(REPORT),
      },
      {
        name: "Firbot Posicionamiento.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(POSITIONING),
      },
    ]);
  await expect
    .poll(
      async () =>
        (
          await admin!.from("knowledge_items").select("status").eq("workspace_id", workspaceId)
        ).data?.map((r) => r.status),
      { timeout: 180_000, intervals: [2_000] },
    )
    .toEqual(["ready", "ready"]);
});

test("competitors: the answer leads, documents behind 'Fuentes'; then the source on request", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto("/");
  await say(page, "¿Cuáles son los principales competidores de Firbot?");
  const first = await canvas();
  report.competitors = first.map((s) => ({
    type: s.type,
    title: s.title,
    items:
      s.type === "answer"
        ? (s.payload.items as { title: string; badge?: string; sources: number[] }[]).map(
            (i) => `${i.title}${i.badge ? ` [${i.badge}]` : ""} ←${i.sources.join(",")}`,
          )
        : undefined,
    sources: s.type === "answer" ? s.payload.sources : undefined,
  }));
  await page.screenshot({ path: `${OUT}/competitors-desktop.png` });
  const answer = first.find((s) => s.type === "answer");
  expect(answer, JSON.stringify(report.competitors)).toBeTruthy();
  expect(first.some((s) => s.type === "knowledge_result" || s.type === "knowledge_source")).toBe(
    false,
  );
  const items = answer!.payload.items as { title: string; badge?: string }[];
  expect(items.map((i) => i.title).join(" ")).toMatch(/CenteIA/);
  // CenteIA is told apart from the references.
  const centeia = items.find((i) => /CenteIA/.test(i.title))!;
  const others = items.filter((i) => !/CenteIA/.test(i.title));
  expect(others.every((o) => o.badge !== centeia.badge)).toBe(true);
  // The sources are there, collapsed.
  await page
    .getByText(/^Fuentes · \d/)
    .first()
    .click();
  await page.screenshot({ path: `${OUT}/competitors-sources-open.png` });
  await expect(
    page.getByRole("link", { name: /Firbot Competitive Intelligence Report/ }).first(),
  ).toBeVisible();
  report.chat = (await page.locator("main").innerText()).slice(-600);

  await say(page, "Abrime el informe de competidores.");
  const opened = await canvas();
  report.openReport = opened.map((s) => ({ type: s.type, title: s.title }));
  await page.screenshot({ path: `${OUT}/open-report.png` });
  expect(
    opened.some((s) => ["knowledge_source", "knowledge_result", "document"].includes(s.type)),
  ).toBe(true);
});

test("phone: the answer first, provenance collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/");
  await say(page, "¿Quiénes son los competidores de Firbot? Dame una lista rápida.");
  const shown = await canvas();
  report.mobile = shown.map((s) => ({ type: s.type, title: s.title }));
  await page.screenshot({ path: `${OUT}/competitors-mobile.png`, fullPage: true });
  expect(shown.some((s) => s.type === "answer")).toBe(true);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
