import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-028 (presentation intelligence) — real model, real Web search, real
 * Maps, real STT/TTS, real Chrome. Not a regression test: model answers vary, and it costs API
 * usage, so it only runs on demand:
 *
 *   E2E_REAL=1 VOICE_FIXTURES=<dir with u0.wav u1.wav u2.wav> E2E_CHANNEL=chrome \
 *     npx playwright test milestone-validation --project=desktop
 *
 * Fixtures (any voice): u0 "Buscame cinco publicaciones de Toyota Corolla usados en Mercado
 * Libre.", u1 "Buscá el cronograma de la materia.", u2 "¿Cuánto tardo hasta el Obelisco?".
 * Knowledge runs inline: start the server without TRIGGER_SECRET_KEY. The course document is
 * synthetic (no real institution). Results and screenshots land in test-results/.
 */
const real = process.env.E2E_REAL === "1";
const fixtures = process.env.VOICE_FIXTURES;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 240_000 });

// Palermo, Buenos Aires: the device position the browser reports.
test.use({
  geolocation: { latitude: -34.5889, longitude: -58.4306, accuracy: 35 },
  permissions: ["geolocation"],
});

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";

const SYLLABUS = [
  "# Materia Ficticia 101 — Cronograma 2026",
  "",
  "Cátedra de prueba. Documento sintético para validar ELISE.",
  "",
  "## Primer cuatrimestre",
  "- Inicio de clases: 9 de marzo de 2026.",
  "- Primer parcial: 27 de abril de 2026.",
  "- Feriado sin clases: 25 de mayo de 2026.",
  "- Segundo parcial: 22 de junio de 2026.",
  "- Recuperatorios: 6 y 7 de julio de 2026.",
  "",
  "## Segundo cuatrimestre",
  "- Inicio del segundo cuatrimestre: 10 de agosto de 2026.",
  "- Entrega del trabajo práctico final: 26 de octubre de 2026.",
  "- Mesa de examen final: 30 de noviembre de 2026.",
].join("\n");

interface Turn {
  events: {
    type: string;
    name?: string;
    ops?: {
      op: string;
      surface?: { type: string; payload?: { spec?: { type: string; view?: string } } };
    }[];
  }[];
}

test.beforeAll(async ({}, info) => {
  email = `e2e+real-${info.project.name}-${Date.now()}@elise.test`;
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
  if (!userId) return;
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ws) {
    const bucket = admin!.storage.from("knowledge-originals");
    const { data: dirs } = await bucket.list(`workspace/${ws.id}`, { limit: 1000 });
    for (const d of dirs ?? []) {
      const { data: files } = await bucket.list(`workspace/${ws.id}/${d.name}`, { limit: 1000 });
      if (files?.length)
        await bucket.remove(files.map((f) => `workspace/${ws.id}/${d.name}/${f.name}`));
    }
    await admin!.from("workspaces").delete().eq("id", ws.id);
  }
  await admin!.auth.admin.deleteUser(userId);
});

async function signIn(page: Page) {
  await captureTurns(page);
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

/** Tees every chat stream in the page (streaming is untouched) so a turn can be read back. */
async function captureTurns(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __turns: string[]; fetch: typeof fetch };
    w.__turns = [];
    const original = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await original(...args);
      const u =
        typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (/\/api\/(chat|voice\/live\/delegate)$/.test(u)) {
        const i = w.__turns.push("") - 1;
        void res
          .clone()
          .text()
          .then((t) => (w.__turns[i] = `${t}\n#done`));
      }
      return res;
    };
  });
}

/** Types a message on Home and collects that turn's stream events. */
async function ask(page: Page, text: string): Promise<Turn> {
  const before = await page.evaluate(
    () => (window as unknown as { __turns: string[] }).__turns.length,
  );
  const box = page.locator("textarea").first();
  // With voice on, Home's dock shows the Orb: typing is one tap away.
  await box
    .or(page.getByRole("button", { name: "Escribir" }))
    .first()
    .waitFor({ timeout: 30_000 });
  if (!(await box.isVisible().catch(() => false))) {
    const type = page.getByRole("button", { name: "Escribir" }).first();
    if (await type.isVisible().catch(() => false)) await type.click();
  }
  await box.fill(text);
  await box.press("Enter");
  const body = await expect
    .poll(
      () =>
        page.evaluate((n) => (window as unknown as { __turns: string[] }).__turns[n] ?? "", before),
      { timeout: 180_000, intervals: [1_000] },
    )
    .toContain("#done")
    .then(() =>
      page.evaluate((n) => (window as unknown as { __turns: string[] }).__turns[n]!, before),
    );
  return {
    events: body
      .split("\n")
      .filter((l) => l && l !== "#done")
      .map((l) => JSON.parse(l) as Turn["events"][number]),
  };
}

const tools = (t: Turn) => t.events.filter((e) => e.type === "tool_started").map((e) => e.name);
const presented = (t: Turn) =>
  t.events
    .flatMap((e) => (e.type === "workspace" ? (e.ops ?? []) : []))
    .filter((o) => o.op === "present");
const specs = (t: Turn) =>
  presented(t)
    .map((o) => o.surface?.payload?.spec)
    .filter((s): s is { type: string; view?: string } => Boolean(s));

/** Desktop and phone, light and dark (ELISE's theme is the profile's, not the OS's). */
async function shots(page: Page, name: string, outputPath: (n: string) => string) {
  const theme = (t: "light" | "dark") =>
    admin!.from("user_profiles").update({ theme: t }).eq("id", userId);
  await page.waitForTimeout(800);
  for (const mode of ["light", "dark"] as const) {
    await theme(mode);
    await page.reload();
    await page.waitForTimeout(1_500);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: outputPath(`${name}-desktop-${mode}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: outputPath(`${name}-mobile-${mode}.png`), fullPage: true });
  }
  await theme("light");
  await page.setViewportSize({ width: 1440, height: 900 });
}

const report: Record<string, unknown> = {};
test.afterAll(async ({}, info) => {
  console.log(`VALIDATION ${JSON.stringify(report, null, 1)}`);
  void info;
});

test("setup: onboarding, a Space, the synthetic syllabus ingested", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await page.goto("/knowledge");
  const space = page.getByText("Facultad QA").first();
  await space.waitFor({ timeout: 20_000 }).catch(async () => {
    console.log(
      "KNOWLEDGE PAGE",
      page.url(),
      (await page.locator("main").innerText()).slice(0, 1500),
    );
    throw new Error("Space not listed");
  });
  await space.click();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: "cronograma-materia-ficticia.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(SYLLABUS),
    });
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  await expect
    .poll(
      async () =>
        (await admin!.from("knowledge_items").select("status").eq("workspace_id", ws!.id)).data?.[0]
          ?.status,
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe("ready");
  await admin!
    .from("user_profiles")
    .update({
      voice_enabled: true,
      voice_output: true,
      voice_continuous: false,
      voice_language: "es",
    })
    .eq("id", userId);
});

test("TEST 1 — a course schedule from Knowledge becomes a timeline in the same turn", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const t = await ask(page, "¿Cuál es el cronograma de la Materia Ficticia 101?");
  const temporal = specs(t).filter((s) => s.type === "temporal");
  report.test1 = { tools: tools(t), temporal: temporal.map((s) => s.view) };
  await shots(page, "t1-schedule", (n) => info.outputPath(n));
  expect(tools(t)).toContain("knowledge.search");
  expect(tools(t)).toContain("ui.timeline");
  expect(temporal.length).toBeGreaterThan(0);
});

test("TEST 1b — follow-up narrows the same schedule", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/");
  await ask(page, "¿Cuál es el cronograma de la Materia Ficticia 101?");
  const t = await ask(page, "Mostrame solo los parciales.");
  const temporal = specs(t).filter((s) => s.type === "temporal");
  report.test1b = { tools: tools(t), temporal: temporal.map((s) => s.view) };
  await page.screenshot({ path: info.outputPath("t1b-only-exams.png") });
  expect(tools(t)).toContain("ui.timeline");
});

test("TEST 2 — comparable forecasts → a comparison, never a line", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/");
  const t = await ask(
    page,
    "¿Qué proyecciones publicaron los bancos para el S&P 500 a fin de 2026? Compará los objetivos.",
  );
  const charts = specs(t).filter((s) => s.type !== "temporal");
  report.test2 = { tools: tools(t), charts: charts.map((s) => s.type) };
  await shots(page, "t2-forecasts", (n) => info.outputPath(n));
  expect(charts.length).toBeGreaterThan(0);
  expect(charts.some((s) => s.type === "line")).toBe(false);
});

test("TEST 3 — a time series → a line", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/");
  const t = await ask(page, "¿Cómo evolucionó la inflación anual de Argentina entre 2019 y 2024?");
  const charts = specs(t);
  report.test3 = { tools: tools(t), charts: charts.map((s) => s.type) };
  await page.screenshot({ path: info.outputPath("t3-series.png") });
  expect(charts.some((s) => s.type === "line" || s.type === "bar")).toBe(true);
});

test("TEST 4 — device location is the origin: no origin question", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/settings");
  await page.getByRole("switch", { name: "Usar mi ubicación actual" }).click();
  await expect(page.getByText(/Permitida/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("t4-settings.png") });
  await page.goto("/");
  const request = page.waitForRequest((r) => r.url().endsWith("/api/chat"));
  const t = await ask(page, "¿Cuánto tardo hasta el Obelisco?");
  const body = (await request).postDataJSON() as { here?: unknown };
  const map = presented(t).find((o) => o.surface?.type === "map");
  report.test4 = {
    here: Boolean(body.here),
    tools: tools(t),
    mapMode: (map?.surface?.payload as { mode?: string })?.mode,
  };
  await shots(page, "t4-route", (n) => info.outputPath(n));
  expect(body.here).toBeTruthy();
  expect((map?.surface?.payload as { mode?: string })?.mode).toBe("route");
});

test("TEST 5 — an address without a city resolves near the named origin, first attempt", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const t = await ask(page, "¿Cuánto tardo en auto desde Palermo hasta Avenida Rivadavia 5000?");
  const map = presented(t).find((o) => o.surface?.type === "map");
  const route = (map?.surface?.payload as { route?: { distanceMeters: number } } | undefined)
    ?.route;
  report.test5 = { tools: tools(t), km: route ? route.distanceMeters / 1000 : null };
  await page.screenshot({ path: info.outputPath("t5-address.png") });
  expect(route).toBeTruthy();
  expect(route!.distanceMeters).toBeLessThan(25_000);
});

test("TEST 6 — marketplace discovery: concrete items or a precise limitation", async ({
  page,
}, info) => {
  await signIn(page);
  await page.goto("/");
  const t = await ask(
    page,
    "Buscame 6 publicaciones de Toyota Corolla usados en Mercado Libre Argentina.",
  );
  const collection = presented(t)
    .filter((o) => o.surface?.type === "web_collection")
    .at(-1);
  const p = collection?.surface?.payload as
    | {
        items: { title: string; price: number | null; fromIndex: boolean }[];
        limitations: unknown[];
        status: string;
      }
    | undefined;
  report.test6 = {
    tools: tools(t),
    status: p?.status,
    items: p?.items.length,
    read: p?.items.filter((i) => !i.fromIndex).length,
    priced: p?.items.filter((i) => i.price !== null).length,
    limitations: p?.limitations,
    progressive: presented(t).filter((o) => o.surface?.type === "web_collection").length,
  };
  await shots(page, "t6-marketplace", (n) => info.outputPath(n));
  expect(tools(t)).toContain("web.discover");
  expect((p?.items.length ?? 0) > 0 || (p?.limitations.length ?? 0) > 0).toBe(true);
});

// ── Voice (legacy pipeline, real STT/TTS) ───────────────────────────────────

async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("elise.voiceDebug", "1");
    localStorage.setItem("elise.location.device", "1");
    const w = window as unknown as Record<string, unknown>;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const ch = noise.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.004;
      const n = ctx.createBufferSource();
      n.buffer = noise;
      n.loop = true;
      n.connect(dest);
      n.start();
      w.__say = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const buf = await ctx.decodeAudioData(bytes.buffer);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = 0.6;
        src.connect(gain).connect(dest);
        src.start();
        return buf.duration;
      };
      return dest.stream;
    };
  });
}

for (const [i, name] of [
  [0, "TEST 7 — voice + web"],
  [1, "TEST 8 — voice + knowledge"],
  [2, "TEST 9 — voice + map"],
] as const)
  test(`${name}: acknowledgement while working, no stale speech after results`, async ({
    page,
  }, info) => {
    test.skip(!fixtures, "Needs VOICE_FIXTURES");
    const t0 = Date.now();
    const speech: { t: number; text: string }[] = [];
    const timelines: string[] = [];
    const dropped: number[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/voice/speak"))
        speech.push({ t: Date.now() - t0, text: (r.postDataJSON() as { text: string }).text });
    });
    page.on("console", (m) => {
      if (m.text().startsWith("[voice] timeline")) timelines.push(m.text());
      if (m.text().startsWith("[voice] progress_dropped")) dropped.push(Date.now() - t0);
    });
    await fakeMicrophone(page);
    await signIn(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
    await page.waitForTimeout(2_500);
    const b64 = readFileSync(join(fixtures!, `u${i}.wav`)).toString("base64");
    await page.evaluate(
      (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
      b64,
    );
    await expect
      .poll(() => timelines.length, { timeout: 200_000, intervals: [500] })
      .toBeGreaterThan(0);
    const marks = Object.fromEntries(
      [...timelines[0]!.matchAll(/(\w+) (\d+)ms/g)].map((m) => [m[1]!, Number(m[2])]),
    );
    report[`voice${i}`] = { speech, marks, dropped };
    await page.screenshot({ path: info.outputPath(`voice-${i}.png`) });
    // The acknowledgement (or the model's own line) starts while the work still runs…
    if (marks.ackTts !== undefined && marks.toolsDone !== undefined)
      expect(marks.ackTts).toBeLessThanOrEqual(marks.toolsDone);
    // …and nothing announces future work after the result started being said.
    const firstResult = speech.findIndex(
      (s) => !/^(lo busco|calculo la ruta|reviso el material|busco)/i.test(s.text),
    );
    expect(
      speech
        .slice(Math.max(0, firstResult))
        .some((s) => /voy a (buscar|revisar|calcular)/i.test(s.text)),
    ).toBe(false);
  });
