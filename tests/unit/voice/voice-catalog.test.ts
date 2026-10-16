import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { buildContextPackage } from "@/core/agents/context";
import type { ToolRunEnv } from "@/core/agents/tools";
import type { SettingsStore } from "@/core/capabilities/settings";
import { nextVoiceTool, SETTINGS_TOOLS, setVoiceTool } from "@/core/tools/settings";
import {
  DEFAULT_VOICE,
  nextVoice,
  openaiVoiceFor,
  resolveVoice,
  VOICE_CATALOG,
  type VoiceKey,
} from "@/core/voice/catalog";
import { deliveryCommand } from "@/core/voice/delivery";
import type { SpeechOutputProvider, SynthesisRequest } from "@/core/voice/providers";
import { FailoverSpeechOutput } from "@/infrastructure/ai/failover-speech";

import { FakeSupabase } from "../../fixtures/fake-supabase";

vi.mock("server-only", () => ({}));

/** Server env for the voice resolution, changed per test. Fake ids, never real ones. */
const env: Record<string, string | undefined> = {};
vi.mock("@/config/server-env", () => ({ serverEnv: () => env }));

const synthesized: SynthesisRequest[] = [];
vi.mock("@/infrastructure/ai", async (original) => ({
  ...(await original<typeof import("@/infrastructure/ai")>()),
  getSpeechOutputProvider: () => ({
    id: "fake",
    model: "fake",
    format: { encoding: "pcm_s16le", sampleRate: 24_000 },
    voices: [],
    synthesize: async (r: SynthesisRequest) => {
      synthesized.push(r);
      return new ReadableStream({ start: (c) => c.close() });
    },
  }),
}));

const { availableVoiceKeys, elevenVoices } = await import("@/infrastructure/ai/voices");
const { setPreferredVoice } = await import("@/application/settings-service");
const { previewVoice } = await import("@/application/voice-service");

function configure(ids: Partial<Record<"1" | "2" | "3" | "legacy", string>>) {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, {
    SPEECH_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "sk-test",
    ELEVENLABS_VOICE_ID_1: ids["1"],
    ELEVENLABS_VOICE_ID_2: ids["2"],
    ELEVENLABS_VOICE_ID_3: ids["3"],
    ELEVENLABS_VOICE_ID: ids.legacy,
  });
}

const ALL = { "1": "id-one", "2": "id-two", "3": "id-three" };

describe("voice catalog (ADR-030)", () => {
  beforeEach(() => configure(ALL));

  it("ELISE, Martín and Adriana resolve from ELEVENLABS_VOICE_ID_1, _2 and _3", () => {
    expect(elevenVoices()).toEqual({ elise: "id-one", martin: "id-two", adriana: "id-three" });
    expect(availableVoiceKeys()).toEqual(["elise", "martin", "adriana"]);
    expect(VOICE_CATALOG.map((v) => v.name)).toEqual(["ELISE", "Martín", "Adriana"]);
  });

  it("a missing optional voice doesn't break the catalog; ELISE is always there", () => {
    configure({ "1": "id-one", "3": "id-three" });
    expect(availableVoiceKeys()).toEqual(["elise", "adriana"]);
    configure({});
    expect(availableVoiceKeys()).toEqual(["elise"]);
  });

  it("the legacy ELEVENLABS_VOICE_ID gives ELISE her voice only when _1 is unset", () => {
    configure({ legacy: "id-legacy" });
    expect(elevenVoices()).toEqual({ elise: "id-legacy" });
    configure({ "1": "id-one", legacy: "id-legacy" });
    expect(elevenVoices()).toEqual({ elise: "id-one" });
  });

  it("without ElevenLabs only ELISE is offered (spoken by her OpenAI stand-in)", () => {
    env.SPEECH_PROVIDER = "openai";
    expect(availableVoiceKeys()).toEqual(["elise"]);
    expect(openaiVoiceFor("elise")).toBe("marin");
  });

  it("ELISE is the default; no or an unavailable preference resolves to her", () => {
    expect(DEFAULT_VOICE).toBe("elise");
    expect(resolveVoice(undefined, ["elise", "martin"])).toBe("elise");
    expect(resolveVoice("cedar", ["elise", "martin"])).toBe("elise");
    expect(resolveVoice("adriana", ["elise", "martin"])).toBe("elise");
    expect(resolveVoice("martin", ["elise", "martin"])).toBe("martin");
  });
});

describe("the next voice (deterministic)", () => {
  const all: VoiceKey[] = ["elise", "martin", "adriana"];

  it("cycles ELISE → Martín → Adriana → ELISE", () => {
    expect(nextVoice("elise", all)).toBe("martin");
    expect(nextVoice("martin", all)).toBe("adriana");
    expect(nextVoice("adriana", all)).toBe("elise");
  });

  it("skips a voice that isn't available", () => {
    expect(nextVoice("elise", ["elise", "adriana"])).toBe("adriana");
    expect(nextVoice("adriana", ["elise", "adriana"])).toBe("elise");
    expect(nextVoice("elise", ["elise"])).toBeNull();
  });

  it("criteria from the user's words pick the right voice", () => {
    // "Poné una voz masculina"
    expect(nextVoice("elise", all, { gender: "male" })).toBe("martin");
    expect(nextVoice("adriana", all, { gender: "male" })).toBe("martin");
    // "Una mujer, con voz más grave"
    expect(nextVoice("elise", all, { gender: "female", lower: true })).toBe("adriana");
    expect(nextVoice("martin", all, { gender: "female", lower: true })).toBe("adriana");
    // "Poné la otra voz femenina"
    expect(nextVoice("elise", all, { gender: "female" })).toBe("adriana");
    expect(nextVoice("adriana", all, { gender: "female" })).toBe("elise");
    // No male voice configured: nothing invented.
    expect(nextVoice("elise", ["elise", "adriana"], { gender: "male" })).toBeNull();
  });
});

/** The chat's tools against an in-memory store: the same preference Settings writes. */
function toolEnv(available: VoiceKey[] = ["elise", "martin", "adriana"]) {
  const state = { current: "elise" as VoiceKey };
  const store = {
    voices: async () => ({ current: state.current, available }),
    setVoice: async (key: VoiceKey) => (state.current = key),
  } as unknown as SettingsStore;
  const env = { providers: { get: () => store } } as unknown as ToolRunEnv;
  return { state, env };
}

describe("voice tools in chat", () => {
  it("exist as self-control tools, without approval-only operations", () => {
    const names = SETTINGS_TOOLS.map((t) => t.name);
    for (const n of ["voice.getCurrent", "voice.listAvailable", "voice.set", "voice.next"])
      expect(names).toContain(n);
  });

  it('"Cambiá la voz" → voice.next moves to the next voice and says so briefly', async () => {
    const { state, env } = toolEnv();
    const r = await nextVoiceTool.run({}, env);
    expect(state.current).toBe("martin");
    expect(r.output).toEqual({
      voice: { key: "martin", name: "Martín", traits: expect.any(Array) },
      changed: true,
    });
    expect(nextVoiceTool.confirm!(r.output, "es")).toBe("Listo, ahora uso la voz de Martín.");
    expect(r.display).toMatchObject({
      kind: "setting_changed",
      changes: [{ setting: "voice", from: "ELISE", to: "Martín" }],
    });
  });

  it('"Poné una voz masculina" → Martín; "más grave" → Adriana; "tu voz original" → ELISE', async () => {
    const { state, env } = toolEnv();
    await nextVoiceTool.run({ gender: "male" }, env);
    expect(state.current).toBe("martin");
    await nextVoiceTool.run({ gender: "female", lower: true }, env);
    expect(state.current).toBe("adriana");
    await setVoiceTool.run({ voiceKey: "elise" }, env);
    expect(state.current).toBe("elise");
    await setVoiceTool.run({ voiceKey: "martin" }, env);
    expect(state.current).toBe("martin");
  });

  it("asking for the voice already in use changes nothing and says so", async () => {
    const { state, env } = toolEnv();
    state.current = "martin";
    const r = await nextVoiceTool.run({ gender: "male" }, env);
    expect(r.output).toMatchObject({ changed: false });
    expect(nextVoiceTool.confirm!(r.output, "es")).toBe("Ya estoy usando la voz de Martín.");
  });

  it("invalid or unavailable voices are rejected; outputs never carry provider ids", async () => {
    const { state, env } = toolEnv(["elise", "adriana"]);
    await expect(setVoiceTool.run({ voiceKey: "martin" }, env)).rejects.toThrow(
      /Martín isn't available\. Voices available: ELISE, Adriana/,
    );
    await expect(setVoiceTool.run({ voiceKey: "voice-id-123" }, env)).rejects.toThrow();
    await expect(nextVoiceTool.run({ gender: "male" }, env)).rejects.toThrow(/No other voice/);
    expect(state.current).toBe("elise");
    const listed = await SETTINGS_TOOLS.find((t) => t.name === "voice.listAvailable")!.run({}, env);
    expect(JSON.stringify(listed.output)).not.toMatch(/id-|elevenlabs/i);
  });

  it('"Susurrá" is delivery, not identity: the voice tools say so and delivery handles it', () => {
    expect(deliveryCommand("Susurrá")).toBe("whisper");
    expect(deliveryCommand("Hablá más bajo")).toBe("quiet");
    expect(deliveryCommand("Cambiá la voz")).toBeNull();
    for (const t of [setVoiceTool, nextVoiceTool]) expect(t.description).toMatch(/susurrá/);
  });

  it("the turn context lists the voices compactly, never provider details", () => {
    configure(ALL);
    const text = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "UTC" },
      now: new Date("2026-10-16T12:00:00Z"),
      availableCapabilities: ["settings"],
      history: [],
      userMessage: "Cambiá la voz",
      voice: { current: "elise", available: ["elise", "martin", "adriana"] },
    }).instructions;
    expect(text).toContain('"currentVoice":"elise"');
    expect(text).toContain('"name":"Martín"');
    expect(text).not.toMatch(/id-one|id-two|ElevenLabs/);
  });
});

describe("the voice preference", () => {
  const WS = "ws-1";
  const ME = "user-1";
  function auth() {
    const db = new FakeSupabase();
    const a = {
      db,
      workspaceId: WS,
      userId: ME,
      profile: { voice: { voice: "elise" } },
    } as unknown as AuthContext;
    return { db, auth: a };
  }
  const stored = (db: FakeSupabase) =>
    db.rows("user_preferences").filter((r) => r.key === "voice.preferred_voice_key");

  beforeEach(() => configure(ALL));

  it("selecting Martín, then Adriana, stores the stable key for this person only", async () => {
    const { db, auth: a } = auth();
    await setPreferredVoice(a, "martin", "user_ui");
    expect(stored(db)).toEqual([expect.objectContaining({ user_id: ME, value_json: "martin" })]);
    await setPreferredVoice(a, "adriana", "ai");
    expect(stored(db)).toEqual([expect.objectContaining({ user_id: ME, value_json: "adriana" })]);
    // The request already uses it; the next ones read it again.
    expect(a.profile.voice.voice).toBe("adriana");
    expect(db.rows("audit_events").map((e) => e.event_type)).toEqual([
      "settings.voice_changed",
      "settings.voice_changed",
    ]);
    // Never a provider id, and the legacy column is untouched.
    expect(JSON.stringify(db.rows("user_preferences"))).not.toMatch(/id-/);
    expect(db.rows("user_profiles")).toEqual([]);
  });

  it("invalid keys and voices that aren't configured are rejected", async () => {
    configure({ "1": "id-one", "3": "id-three" });
    const { db, auth: a } = auth();
    await expect(setPreferredVoice(a, "martin", "ai")).rejects.toThrow(/isn't available/);
    await expect(setPreferredVoice(a, "cedar" as VoiceKey, "ai")).rejects.toThrow();
    expect(stored(db)).toEqual([]);
  });

  it("preview speaks the requested voice and never changes the preference", async () => {
    const { db, auth: a } = auth();
    synthesized.length = 0;
    await previewVoice(a, "martin", "es");
    expect(synthesized).toEqual([
      expect.objectContaining({
        voice: "martin",
        text: "Hola, soy Martín. Esta es mi voz en ELISE.",
      }),
    ]);
    expect(stored(db)).toEqual([]);
    expect(a.profile.voice.voice).toBe("elise");
  });
});

describe("speech with the chosen voice", () => {
  const provider = (id: string, fn: () => Promise<ReadableStream<Uint8Array>>) =>
    ({
      id,
      model: id,
      format: { encoding: "pcm_s16le", sampleRate: 24_000 },
      voices: [],
      synthesize: vi.fn(fn),
    }) as unknown as SpeechOutputProvider & { synthesize: ReturnType<typeof vi.fn> };

  it("an ElevenLabs failure falls back to the voice's OpenAI stand-in; the choice stays Martín", async () => {
    const primary = provider("elevenlabs", async () => {
      throw new Error("quota_exceeded");
    });
    const fallback = provider(
      "openai",
      async () => new ReadableStream({ start: (c) => c.close() }),
    );
    const f = new FailoverSpeechOutput(primary, fallback, (r) => openaiVoiceFor(r.voice));
    await f.synthesize({ text: "Hola", language: "es", voice: "martin" });
    expect(primary.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "martin" }),
      undefined,
    );
    expect(fallback.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "cedar" }),
      undefined,
    );
    expect(openaiVoiceFor("adriana")).toBe("sage");
  });

  it("voice ids are read only on the server, never in client code", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk("src");
    const readers = files.filter((f) => /ELEVENLABS_VOICE_ID/.test(readFileSync(f, "utf8")));
    for (const f of readers) {
      const src = readFileSync(f, "utf8");
      expect(src.includes('import "server-only"') || f.includes("server-env"), f).toBe(true);
      expect(src).not.toMatch(/NEXT_PUBLIC_ELEVENLABS/);
    }
  });
});
