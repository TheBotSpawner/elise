import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real latency and false-cut validation of ADR-036 (Continuous Voice, legacy runtime): real
 * STT, real model, real tools, the deployment's speech provider, real Chrome. The microphone is
 * a Web Audio stream the test plays recorded utterances into. Twenty turns: ten clean requests
 * (v0–v9) and ten with a real hesitation in the middle (p0–p9: "first part … rest").
 *
 *   E2E_REAL=1 VOICE10=<dir with v*.wav, p*.wav, p*.json> E2E_CHANNEL=chrome \
 *     npx playwright test voice-latency-validation --project=desktop
 *
 * Timings come from the voice trace (same events before and after ADR-036) and the clips'
 * real end of speech, so two builds are measured the same way.
 */
const real = process.env.E2E_REAL === "1";
const dir = process.env.VOICE10;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !dir || !url || !secret, "On demand: E2E_REAL=1, VOICE10 and Supabase");
test.describe.configure({ mode: "serial", timeout: 2_400_000 });
test.use({
  geolocation: { latitude: -34.5889, longitude: -58.4306, accuracy: 35 },
  permissions: ["geolocation", "microphone"],
});

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  email = `e2e+adr036-${info.project.name}-${Date.now()}@elise.test`;
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
  console.log(`VALIDATION ${JSON.stringify(report)}`);
  if (!userId) return;
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .maybeSingle();
  if (ws) await admin!.from("workspaces").delete().eq("id", ws.id);
  await admin!.auth.admin.deleteUser(userId);
});

/** Seconds from the start of a WAV (16-bit PCM) to its last clearly voiced sample. */
function lastVoice(file: Buffer): number {
  const data = file.indexOf("data") + 8;
  const rate = file.readUInt32LE(24);
  const samples = Math.floor((file.length - data) / 2);
  let peak = 0;
  for (let i = 0; i < samples; i++) peak = Math.max(peak, Math.abs(file.readInt16LE(data + i * 2)));
  for (let i = samples - 1; i >= 0; i--)
    if (Math.abs(file.readInt16LE(data + i * 2)) > peak * 0.05) return i / rate;
  return 0;
}

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
        // When playback starts, on the same clock as the voice trace (performance.now()).
        const startAt = performance.now() + (ctx.currentTime > 0 ? 0 : 0);
        src.start();
        return startAt;
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

test("twenty turns: latency per stage and false cuts", async ({ page }) => {
  const traces: { event: string; at: number }[] = [];
  page.on("console", (m) => {
    const x = /^\[voice\] (\S+) (\{.*\})$/.exec(m.text());
    if (!x || x[1] === "timeline") return;
    try {
      const data = JSON.parse(x[2]!) as { at?: number };
      if (typeof data.at === "number") traces.push({ event: x[1]!, at: data.at });
    } catch {
      // Not a trace line.
    }
  });
  await fakeMicrophone(page);
  await signIn(page);
  await page.goto("/?voice=legacy");
  await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
  await page.waitForTimeout(4_000);
  const userTexts = async (since: string) =>
    (
      await admin!
        .from("messages")
        .select("content, created_at, conversations!inner(user_id)")
        .eq("conversations.user_id", userId)
        .eq("role", "user")
        .gt("created_at", since)
        .order("created_at")
    ).data?.map((m) => String(m.content)) ?? [];
  const turns: Record<string, unknown>[] = [];
  report.turns = turns;
  const files = [
    ...Array.from({ length: 10 }, (_, i) => `v${i}`),
    ...Array.from({ length: 10 }, (_, i) => `p${i}`),
  ];
  const only = process.env.VOICE_TURNS?.split(",");
  for (const name of files) {
    if (only && !only.includes(name)) continue;
    const wav = readFileSync(join(dir!, `${name}.wav`));
    const meta = name.startsWith("p")
      ? (JSON.parse(readFileSync(join(dir!, `${name}.json`), "utf8")) as {
          first: string;
          rest: string;
        })
      : null;
    const since = new Date().toISOString();
    const from = traces.length;
    const startAt = await page.evaluate(
      (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
      wav.toString("base64"),
    );
    const voiceEnd = startAt + lastVoice(wav) * 1000;
    // The turn is over when ELISE has spoken and is listening again (or nothing more happens).
    await expect
      .poll(
        () =>
          traces
            .slice(from)
            .some((t) => t.event === "tts_playback_ended" || t.event === "progress_skipped"),
        { timeout: 180_000, intervals: [1_000] },
      )
      .toBe(true)
      .catch(() => undefined);
    await page.waitForTimeout(4_500); // a late continuation or a second turn shows up here
    const mine = traces.slice(from);
    const first = (event: string) => mine.find((t) => t.event === event && t.at >= startAt)?.at;
    const turnEnd = first("turn_end");
    const transcript = first("transcript");
    const audio = first("tts_playback_started");
    const sent = await userTexts(since);
    const key = meta ? meta.rest.split(" ").slice(-1)[0]!.replace(/[?.!]/g, "") : null;
    turns.push({
      turn: name,
      sent,
      // A false cut: the request ELISE acted on never had the rest of what was said.
      falseCut: key ? !sent.some((t) => t.toLowerCase().includes(key.toLowerCase())) : null,
      splitInTwo: sent.length > 1,
      continuation: mine.some((t) => t.event === "continuation"),
      turnDetectionMs: turnEnd ? Math.round(turnEnd - voiceEnd) : null,
      sttMs: turnEnd && transcript ? Math.round(transcript - turnEnd) : null,
      firstAudioMs: transcript && audio ? Math.round(audio - transcript) : null,
      perceivedMs: audio ? Math.round(audio - voiceEnd) : null,
      ackPrepared: mine.some((t) => t.event === "ack_prepared"),
      events: [...new Set(mine.map((t) => t.event))].filter((e) =>
        /provisional|premature|continuation|ack_|turn_end|transcript/.test(e),
      ),
    });
    console.log(`TURN ${JSON.stringify(turns.at(-1))}`);
    await page.waitForTimeout(1_000);
  }
});
