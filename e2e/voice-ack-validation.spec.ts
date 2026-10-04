import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real Continuous Voice validation of ADR-034 (acknowledgements): real STT, real model, real
 * tools, the deployment's real speech provider (ElevenLabs here), real Chrome. The microphone is
 * a Web Audio stream the test plays recorded utterances into. On demand only:
 *
 *   E2E_REAL=1 VOICE10=<dir with v0.wav … v9.wav> E2E_CHANNEL=chrome \
 *     npx playwright test voice-ack-validation --project=desktop
 *
 * v0 web news · v1 calendar · v2 Knowledge · v3 direct answer · v4 task (mutation) · v5 tasks ·
 * v6 Recall · v7 route · v8 ambiguous request · v9 long research.
 */
const real = process.env.E2E_REAL === "1";
const dir = process.env.VOICE10;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !dir || !url || !secret, "On demand: E2E_REAL=1, VOICE10 and Supabase");
test.describe.configure({ mode: "serial", timeout: 1_500_000 });
test.use({
  geolocation: { latitude: -34.5889, longitude: -58.4306, accuracy: 35 },
  permissions: ["geolocation", "microphone"],
});

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
const report: Record<string, unknown> = {};

const SYLLABUS = [
  "# Materia Ficticia 101 — Cronograma 2026",
  "",
  "- Primer parcial: 27 de abril de 2026.",
  "- Segundo parcial: 22 de junio de 2026.",
  "- Mesa de examen final: 30 de noviembre de 2026.",
].join("\n");

test.beforeAll(async ({}, info) => {
  email = `e2e+adr034-${info.project.name}-${Date.now()}@elise.test`;
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
  if (!userId) return;
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ws) {
    const bucket = admin!.storage.from("knowledge-originals");
    const { data: dirs } = await bucket.list(`workspace/${ws.id}/knowledge`, { limit: 100 });
    for (const d of dirs ?? []) {
      const { data: vs } = await bucket.list(`workspace/${ws.id}/knowledge/${d.name}`);
      for (const v of vs ?? []) {
        const { data: files } = await bucket.list(
          `workspace/${ws.id}/knowledge/${d.name}/${v.name}`,
        );
        if (files?.length)
          await bucket.remove(
            files.map((f) => `workspace/${ws.id}/knowledge/${d.name}/${v.name}/${f.name}`),
          );
      }
    }
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

test("setup: onboarding, a Space with a syllabus, Continuous Voice on", async ({ page }) => {
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
  await page.getByText("Facultad QA").first().click();
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
      voice_continuous: true,
      voice_barge_in: true,
      voice_language: "es",
    })
    .eq("id", userId);
});

test("ten mixed Continuous Voice turns: acknowledged, varied, never stale", async ({
  page,
}, info) => {
  const t0 = Date.now();
  const speech: { t: number; text: string }[] = [];
  const traces: { t: number; event: string }[] = [];
  const log: string[] = [];
  report.log = log;
  const only = process.env.VOICE_TURNS?.split(",").map(Number);
  page.on("request", (r) => {
    if (r.url().endsWith("/api/voice/speak"))
      speech.push({ t: Date.now() - t0, text: (r.postDataJSON() as { text: string }).text });
  });
  page.on("console", (m) => {
    const x = /^\[voice\] (\S+)/.exec(m.text());
    if (x && x[1] !== "timeline") traces.push({ t: Date.now() - t0, event: x[1]! });
    if (x) log.push(`${Date.now() - t0} ${m.text().slice(0, 200)}`);
  });
  await fakeMicrophone(page);
  await signIn(page);
  await page.goto("/?voice=legacy");
  await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
  await page.waitForTimeout(4_000); // calibration, and the acknowledgements warm up
  const timings = () =>
    page.evaluate(
      () =>
        (window as unknown as { __eliseVoiceTimings?: unknown[] }).__eliseVoiceTimings?.length ?? 0,
    );
  const turns: Record<string, unknown>[] = [];
  report.turns = turns; // filled as it goes: kept even if a later turn fails
  // Ten turns, then an eleventh (web news again) that is talked over while acknowledging.
  for (let i = 0; i < 11; i++) {
    if (only && !only.includes(i)) continue;
    const before = await timings();
    const start = Date.now() - t0;
    const file = i === 10 ? "v0.wav" : `v${i}.wav`;
    const b64 = readFileSync(join(dir!, file)).toString("base64");
    await page.evaluate(
      (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
      b64,
    );
    if (i === 10) {
      await expect
        .poll(() => traces.some((x) => x.t > start && x.event === "ack_tts_started"), {
          timeout: 60_000,
        })
        .toBe(true);
      await page.waitForTimeout(150);
      const over = readFileSync(join(dir!, "v3.wav")).toString("base64");
      await page.evaluate(
        (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
        over,
      );
      await expect
        .poll(timings, { timeout: 240_000, intervals: [1_000] })
        .toBeGreaterThan(before + 1)
        .catch(() => undefined);
      report.bargeIn = {
        timings: await page.evaluate(
          (n) =>
            (
              window as unknown as { __eliseVoiceTimings: Record<string, number>[] }
            ).__eliseVoiceTimings.slice(n),
          before,
        ),
        events: traces.filter((x) => x.t >= start).map((x) => x.event),
        lines: speech.filter((x) => x.t >= start).map((x) => x.text),
      };
      break;
    }
    await expect
      .poll(timings, { timeout: i === 9 ? 420_000 : 180_000, intervals: [1_000] })
      .toBeGreaterThan(before);
    const marks = await page.evaluate(
      (n) =>
        (window as unknown as { __eliseVoiceTimings: Record<string, number>[] })
          .__eliseVoiceTimings[n],
      before,
    );
    const lines = speech.filter((s) => s.t >= start).map((s) => s.text);
    const events = traces.filter((x) => x.t >= start).map((x) => x.event);
    turns.push({
      turn: `v${i}`,
      marks,
      lines,
      events: [...new Set(events)].filter((e) => /ack|progress/.test(e)),
    });
    await page.waitForTimeout(1_500);
  }
  await page.screenshot({ path: info.outputPath("after-ten-turns.png") });
  report.turns = turns;
  const acks = turns
    .map((t) =>
      (t.events as string[]).includes("ack_tts_started") ? (t.lines as string[])[0] : null,
    )
    .filter(Boolean);
  report.distinctAcks = [...new Set(acks)];
  // Direct answers and clarifications get no acknowledgement; work does, before its result.
  const byTurn = Object.fromEntries(turns.map((t) => [t.turn, t]));
  const m = (k: string) => (byTurn[k]?.marks as Record<string, number> | undefined) ?? {};
  expect(m("v3").ackReady).toBeUndefined();
  // Talked over: the interrupted request's answer is never spoken in the next turn.
  const barge = report.bargeIn as { lines?: string[] } | undefined;
  if (barge?.lines) expect(barge.lines.some((l) => /noticia/i.test(l))).toBe(false);
  for (const k of ["v0", "v2", "v7"])
    if (m(k).ackTts !== undefined && m(k).resultSpeech !== undefined)
      expect(m(k).ackTts).toBeLessThanOrEqual(m(k).resultSpeech!);
  // Never a "voy a buscarlo" after the result started being said.
  for (const t of turns) {
    const lines = t.lines as string[];
    const firstResult = lines.findIndex(
      (l) =>
        !/^(lo busco|ya lo busco|voy a buscarlo|déjame|reviso|ya miro|calculo|busco|sigo|lo hago|claro|sí,|preparo|voy con|lo veo|ya lo miro)/i.test(
          l,
        ),
    );
    if (firstResult >= 0)
      expect(
        lines.slice(firstResult + 1).some((l) => /^(voy a buscar|lo busco|ya lo busco)/i.test(l)),
      ).toBe(false);
  }
});
