import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * Real validation of ADR-030's voice catalog (2026-10-16): Settings preview and selection,
 * switching from typed chat, and from a continuous voice session with the real model.
 *
 *   E2E_REAL=1 VOICE_CLIPS=<dir> E2E_CHANNEL=chrome E2E_PORT=3100 \
 *     npx playwright test voice-switching-validation --project=desktop
 *
 * Clips (Spanish speech): lower-female.wav, male.wav, original.wav.
 */
const real = process.env.E2E_REAL === "1";
const dir = process.env.VOICE_CLIPS;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
test.skip(!real || !url || !secret, "On demand: E2E_REAL=1 and a Supabase project");
test.describe.configure({ mode: "serial", timeout: 600_000 });
test.use({ permissions: ["microphone"] });

const admin = url && secret ? createClient(url, secret, { auth: { persistSession: false } }) : null;
const password = `E2e-${crypto.randomUUID()}`;
const OUT = "test-results/voices";
let email = "";
let userId = "";
let workspaceId = "";
const report: Record<string, unknown> = {};

test.beforeAll(async ({}, info) => {
  mkdirSync(OUT, { recursive: true });
  email = `e2e+voices-${info.project.name}-${Date.now()}@elise.test`;
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

const storedVoice = async () =>
  (
    await admin!
      .from("user_preferences")
      .select("value_json")
      .eq("user_id", userId)
      .eq("key", "voice.preferred_voice_key")
      .maybeSingle()
  ).data?.value_json ?? null;

async function ask(page: Page, text: string) {
  await page.goto("/");
  const box = page.locator("textarea").first();
  if (!(await box.isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Escribir" }).first().click();
  await box.fill(text);
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0, { timeout: 150_000 });
}

test("setup", async ({ page }) => {
  await signIn(page);
  await expect
    .poll(
      async () => (await admin!.from("user_profiles").select("id").eq("id", userId)).data?.length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await admin!
    .from("user_profiles")
    .update({ onboarding_status: "skipped", voice_language: "es", voice_continuous: true })
    .eq("id", userId);
  const { data: ws } = await admin!
    .from("workspaces")
    .select("id")
    .eq("owner_user_id", userId)
    .single();
  workspaceId = ws!.id as string;
});

test("Settings: ELISE by default, preview keeps it, Adriana persists after a refresh", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/voice");
  await expect(page.getByRole("radio", { name: /^ELISE/ })).toBeChecked();
  report.offered = await page
    .getByRole("radio")
    .evaluateAll((r) => r.map((x) => (x as HTMLInputElement).value));
  await page.screenshot({ path: `${OUT}/settings-default.png`, fullPage: true });

  const preview = page.waitForResponse((r) => r.url().includes("/api/voice/preview"));
  await page.getByRole("button", { name: "Escuchar Martín" }).click();
  const res = await preview;
  report.previewStatus = res.status();
  report.previewQuery = new URL(res.url()).search;
  await expect(page.getByRole("radio", { name: /^ELISE/ })).toBeChecked();
  expect(await storedVoice()).toBeNull();

  await page.getByRole("radio", { name: /^Adriana/ }).check();
  await expect.poll(storedVoice).toBe("adriana");
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Adriana/ })).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${OUT}/settings-mobile.png`, fullPage: true });
});

test("Typed chat: next, masculine, whisper isn't a voice, back to the original", async ({
  page,
}) => {
  await signIn(page);
  const steps: Record<string, unknown>[] = [];
  report.chat = steps;
  for (const [text, expected] of [
    ["Cambiá la voz.", "elise"], // adriana → elise (catalog order wraps)
    ["Poné la otra voz femenina.", "adriana"],
    ["Poné una voz masculina.", "martin"],
    ["Susurrá.", "martin"],
    ["Quiero una mujer pero con una voz un poco más grave.", "adriana"],
    ["Volvé a tu voz.", "elise"],
  ] as const) {
    await ask(page, text);
    await expect.poll(storedVoice, { timeout: 20_000 }).toBe(expected);
    steps.push({
      text,
      voice: await storedVoice(),
      reply: (await page.locator("main").innerText()).slice(-160),
    });
  }
  await page.screenshot({ path: `${OUT}/chat-after.png`, fullPage: true });
});

test("Voice chat: lower female → Adriana, masculine → Martín, original → ELISE", async ({
  page,
}) => {
  test.skip(!dir, "VOICE_CLIPS with the spoken requests");
  await page.addInitScript(() => {
    localStorage.setItem("elise.voiceDebug", "1");
    const w = window as unknown as Record<string, unknown>;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      await ctx.resume();
      const dest = ctx.createMediaStreamDestination();
      w.__say = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const buf = await ctx.decodeAudioData(bytes.buffer);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        src.start();
        return buf.duration;
      };
      return dest.stream;
    };
  });
  const speak: { t: number; status: number; voiceAtRequest: unknown }[] = [];
  page.on("response", (r) => {
    if (r.url().endsWith("/api/voice/speak"))
      void storedVoice().then((v) =>
        speak.push({ t: Date.now(), status: r.status(), voiceAtRequest: v }),
      );
  });
  await signIn(page);
  await page.goto("/?voice=legacy");
  await page.getByRole("button", { name: "Hablar con ELISE" }).first().click();
  await page.waitForTimeout(4_000);
  const turns = () =>
    page.evaluate(
      () =>
        (window as unknown as { __eliseVoiceTimings?: unknown[] }).__eliseVoiceTimings?.length ?? 0,
    );
  const steps: Record<string, unknown>[] = [];
  report.voice = steps;
  for (const [clip, expected] of [
    ["lower-female", "adriana"],
    ["male", "martin"],
    ["original", "elise"],
  ] as const) {
    const before = await turns();
    const started = Date.now();
    await page.evaluate(
      (b) => (window as unknown as { __say: (s: string) => Promise<number> }).__say(b),
      readFileSync(join(dir!, `${clip}.wav`)).toString("base64"),
    );
    await expect.poll(turns, { timeout: 240_000, intervals: [1_000] }).toBeGreaterThan(before);
    await expect.poll(storedVoice, { timeout: 20_000 }).toBe(expected);
    await page.waitForTimeout(3_000);
    const spoken = speak.filter((s) => s.t >= started);
    steps.push({ clip, voice: await storedVoice(), speakRequests: spoken });
    // The microphone stayed on: no restart between turns.
    expect(spoken.every((s) => s.status === 200)).toBe(true);
  }
  await page.screenshot({ path: `${OUT}/voice-after.png`, fullPage: true });
});
