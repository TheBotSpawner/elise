import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Continuous Voice continuity in real Chrome (bug: the first follow-up after ELISE speaks was
 * lost). Everything is real — MediaRecorder, the analyser, /api/voice/transcribe (OpenAI STT),
 * the chat turn, /api/voice/speak (TTS) and playback — except the microphone: getUserMedia
 * returns a Web Audio stream into which the test plays recorded user utterances at chosen
 * delays after ELISE finishes speaking. No acoustic echo exists here (headless output), so
 * speaker/echo behavior still needs real hardware.
 *
 * Run: VOICE_FIXTURES=<dir with u0.wav…u6.wav> E2E_CHANNEL=chrome npx playwright test voice
 */
const fixtures = process.env.VOICE_FIXTURES;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!fixtures || !url || !secret, "Needs VOICE_FIXTURES and a Supabase project");
test.skip(({ browserName }) => browserName !== "chromium", "Chrome only");
test.describe.configure({ mode: "serial", timeout: 300_000 });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
let email = "";
let userId = "";

test.beforeAll(async ({}, info) => {
  email = `e2e+voice-${info.project.name}-${Date.now()}@elise.test`;
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Voice QA", preferred_language: "es" },
  });
  if (error) throw error;
  userId = data.user.id;
  await admin!
    .from("user_profiles")
    .update({
      onboarding_status: "completed",
      voice_enabled: true,
      voice_output: true,
      voice_continuous: true,
      voice_barge_in: process.env.VOICE_BARGE_IN !== "0",
      voice_wake_enabled: false,
      voice_language: "es",
    })
    .eq("id", userId);
});

test.afterAll(async () => {
  if (!userId) return;
  await admin!.from("workspaces").delete().eq("owner_user_id", userId).eq("type", "personal");
  await admin!.auth.admin.deleteUser(userId);
});

/** A synthetic microphone: quiet room noise plus whatever the test "says". */
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

interface Trace {
  t: number;
  event: string;
  data: Record<string, unknown>;
}

for (const delayMs of (process.env.VOICE_DELAYS ?? "0,100,250,500,1000").split(",").map(Number))
  test(`every follow-up is understood the first time (speaking ${delayMs} ms after ELISE)`, async ({
    page,
  }) => {
    const traces: Trace[] = [];
    const t0 = Date.now();
    page.on("console", (m) => {
      const match = /^\[voice\] (\S+) (.*)$/.exec(m.text());
      if (match) traces.push({ t: Date.now() - t0, event: match[1]!, data: JSON.parse(match[2]!) });
    });
    const sent: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/chat") && r.method() === "POST") {
        const body = r.postDataJSON() as { message?: string; modality?: string };
        if (body.modality === "voice") sent.push(body.message ?? "");
      }
    });
    await fakeMicrophone(page);
    await page.goto("/login");
    await page.getByLabel("Email").first().fill(email);
    await page.getByLabel("Contraseña").fill(password);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();

    const phaseIs = (to: string, after: number) =>
      expect
        .poll(() => traces.some((x) => x.t > after && x.event === "phase" && x.data.to === to), {
          timeout: 90_000,
          intervals: [25],
        })
        .toBe(true);
    const say = async (i: number) => {
      const b64 = readFileSync(join(fixtures!, `u${i}.wav`)).toString("base64");
      return page.evaluate(
        (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
        b64,
      );
    };

    const dump = () =>
      console.log(
        JSON.stringify(
          {
            delayMs,
            sent,
            trace: traces.map((x) => `${x.t} ${x.event} ${JSON.stringify(x.data)}`),
          },
          null,
          1,
        ),
      );
    const TURNS = Number(process.env.VOICE_TURNS ?? 5);
    try {
      await phaseIs("listening", 0);
      await say(0);
      for (let turn = 1; turn < TURNS; turn++) {
        // Wait for ELISE to answer and finish speaking, then answer back after `delayMs`.
        const before = traces.at(-1)?.t ?? 0;
        await expect
          .poll(() => traces.some((x) => x.t > before && x.event === "tts_playback_ended"), {
            timeout: 120_000,
            intervals: [10],
          })
          .toBe(true);
        await page.waitForTimeout(delayMs);
        await say(turn);
      }
    } catch (error) {
      dump();
      throw error;
    }
    // The last utterance is transcribed and sent too.
    await expect.poll(() => sent.length, { timeout: 60_000 }).toBe(TURNS);
    const discards = traces.filter((x) => x.event === "discard").map((x) => x.data.reason);
    console.log(
      JSON.stringify(
        {
          delayMs,
          sent,
          discards,
          trace: traces.map((x) => `${x.t} ${x.event} ${JSON.stringify(x.data)}`),
        },
        null,
        1,
      ),
    );
    // Exactly one transcript per user turn: nothing lost, nothing duplicated.
    expect(sent).toHaveLength(TURNS);
    expect(discards.filter((r) => r === "empty_final" || r === "echo_rejected")).toEqual([]);
  });
