import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-049 (adaptive voice delivery): real Chrome, real STT, real model, the
 * deployment's real speech provider. The microphone is a Web Audio stream the test plays
 * recorded clips into (so Chrome's AGC/NS are NOT in this path — see the ADR). On demand only:
 *
 *   E2E_REAL=1 VOICE_CLIPS=<dir> E2E_CHANNEL=chrome \
 *     npx playwright test voice-delivery-validation --project=desktop
 *
 * Clips: normal-d0…d8.wav (normal voice), pwhisper-d*.wav (true unvoiced whispers), soft-d4.wav
 * (voiced, much quieter). Sequence: normal, normal, whisper, whisper, quiet, normal, then
 * "susurrame" (explicit), a normal-voiced turn that stays whispered and is talked over, and
 * "ya podés hablar normal".
 */
const real = process.env.E2E_REAL === "1";
const dir = process.env.VOICE_CLIPS;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !dir || !url || !secret, "On demand: E2E_REAL=1, VOICE_CLIPS and Supabase");
test.describe.configure({ mode: "serial", timeout: 1_500_000 });
test.use({ permissions: ["microphone"] });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+adr049-${info.project.name}-${Date.now()}@elise.test`;
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
  if (ws) await admin!.from("workspaces").delete().eq("id", ws.id);
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

test("setup: onboarding, Continuous Voice on", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Empezar", exact: true }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltear por ahora" }).click();
  await page.getByRole("radio", { name: "Facultad" }).click();
  await page.getByLabel("Nombre").fill("Facultad QA");
  await page.getByRole("button", { name: "Crear Espacio" }).click();
  await page.getByRole("button", { name: "Empezar con ELISE" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
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

const TURNS = [
  { clip: "normal-d0", expect: "normal" },
  { clip: "normal-d1", expect: "normal" },
  // A long whispered reply, talked over in a whisper (a library): it must stop like any reply.
  { clip: "pwhisper-d2", expect: "whisper", talkOver: "pwhisper-d1" },
  { clip: "pwhisper-d3", expect: "whisper" },
  { clip: "soft-d4", expect: "whisper" }, // quieter speech keeps the whisper going
  { clip: "normal-d5", expect: "normal", talkOver: "normal-d3" }, // clearly normal: back up at once
  { clip: "normal-d6", expect: "whisper" }, // "Susurrame…": explicit
  { clip: "normal-d8", expect: "whisper" }, // explicit holds over normal-sounding speech
  { clip: "normal-d7", expect: "normal" }, // "Ya podés hablar normal"
] as const;

test("normal → whisper → quiet → normal, explicit requests, barge-in while whispering", async ({
  page,
}, info) => {
  const t0 = Date.now();
  const speak: { t: number; text: string; delivery: string }[] = [];
  const deliveries: { t: number; data: Record<string, unknown> }[] = [];
  const events: { t: number; event: string }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/voice/speak")) {
      const b = r.postDataJSON() as { text: string; delivery?: string };
      speak.push({ t: Date.now() - t0, text: b.text, delivery: b.delivery ?? "normal" });
    }
  });
  page.on("console", (m) => {
    const x = /^\[voice\] (\S+) (.*)$/.exec(m.text());
    if (!x) return;
    events.push({ t: Date.now() - t0, event: x[1]! });
    if (x[1] === "delivery")
      deliveries.push({ t: Date.now() - t0, data: JSON.parse(x[2]!) as Record<string, unknown> });
  });
  await fakeMicrophone(page);
  await signIn(page);
  await page.goto("/?voice=legacy");
  await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
  await page.waitForTimeout(4_000);
  const timingsCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { __eliseVoiceTimings?: unknown[] }).__eliseVoiceTimings?.length ?? 0,
    );
  const say = (clip: string) =>
    page.evaluate(
      (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
      readFileSync(join(dir!, `${clip}.wav`)).toString("base64"),
    );
  const turns: Record<string, unknown>[] = [];
  report.turns = turns;
  for (const turn of TURNS) {
    const before = await timingsCount();
    const start = Date.now() - t0;
    await say(turn.clip);
    if ("talkOver" in turn) {
      await expect
        .poll(() => events.some((e) => e.t > start && e.event === "tts_playback_started"), {
          timeout: 120_000,
        })
        .toBe(true);
      // Past barge-in echo calibration (VOICE_TURN.barge.calibrateMs), as a person would.
      await page.waitForTimeout(1_200);
      await say(turn.talkOver);
    }
    await expect
      .poll(timingsCount, { timeout: 240_000, intervals: [1_000] })
      .toBeGreaterThan(before);
    // A talked-over turn is followed by the talk-over's own turn: let it finish first.
    if ("talkOver" in turn)
      await expect
        .poll(timingsCount, { timeout: 240_000, intervals: [1_000] })
        .toBeGreaterThan(before + 1)
        .catch(() => undefined);
    const marks = await page.evaluate(
      (n) =>
        (window as unknown as { __eliseVoiceTimings: Record<string, number>[] })
          .__eliseVoiceTimings[n],
      before,
    );
    const decided = deliveries.find((d) => d.t >= start);
    const lines = speak.filter((s) => s.t >= start);
    const pill = await page
      .getByText(/^(Susurro|Voz baja)$/)
      .first()
      .isVisible()
      .catch(() => false);
    turns.push({
      clip: turn.clip,
      expected: turn.expect,
      decided: decided?.data,
      requests: lines.map((l) => `${l.delivery}: ${l.text}`),
      pillVisibleAfter: pill,
      marks,
      bargeIn: "talkOver" in turn ? marks.bargeIn !== undefined : undefined,
    });
    await page.waitForTimeout(1_500);
  }
  await page.screenshot({ path: info.outputPath("after-delivery-turns.png") });
  // The trusted tag never reaches the screen.
  const body = (await page.locator("body").textContent()) ?? "";
  report.tagOnScreen = /\[(whisper|softly)/i.test(body);
  expect(report.tagOnScreen).toBe(false);
  for (const t of turns) {
    expect((t.decided as { mode?: string } | undefined)?.mode, String(t.clip)).toBe(t.expected);
  }
  // Every segment of a whispered turn — acknowledgement first — went out whispered.
  // Talking over a whisper interrupts exactly like talking over normal speech.
  for (const t of turns.filter((x) => x.bargeIn !== undefined)) expect(t.bargeIn).toBe(true);
  for (const t of turns.filter((x) => x.expected === "whisper"))
    for (const r of t.requests as string[]) expect(r).toMatch(/^whisper: /);
});
