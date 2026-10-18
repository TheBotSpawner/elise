import { describe, expect, it } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import type { SettingsStore } from "@/core/capabilities/settings";
import {
  DEFAULT_PERSONALITY,
  PERSONALITIES,
  resolvePersonality,
  type ElisePersonality,
} from "@/core/personality";
import type { VoiceKey } from "@/core/voice/catalog";
import { liveInstructions } from "@/core/voice/live";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * ELISE's base personality (ADR-076): tone only. One preference for Settings, onboarding, chat
 * and voice; never a permission, an approval or a voice.
 */

function setup(initial: ElisePersonality = DEFAULT_PERSONALITY) {
  const state = { personality: initial, voice: "adriana" as VoiceKey, writes: 0 };
  const settings = {
    personality: async () => state.personality,
    async setPersonality(p: ElisePersonality) {
      state.writes++;
      state.personality = p;
      return p;
    },
    voices: async () => ({ current: state.voice, available: ["elise", "adriana"] as VoiceKey[] }),
  } as unknown as SettingsStore;
  const { ports, tasks } = makePorts();
  const native = ports.providers;
  ports.providers = {
    get: ((c: string, b: never) =>
      c === "settings" ? settings : native.get(c as never, b)) as ProviderFactory["get"],
  };
  return { ports, state, tasks };
}

const set = (s: ReturnType<typeof setup>, args: Record<string, unknown>, ctx = makeCtx()) =>
  executeToolCall(s.ports, ctx, { name: "settings.setPersonality", args });

describe("the personality model", () => {
  it("defaults to Servicial y eficiente; anything unknown is the default", () => {
    expect(DEFAULT_PERSONALITY).toBe("efficient");
    expect(resolvePersonality(undefined)).toBe("efficient");
    expect(resolvePersonality("sadica")).toBe("efficient");
    expect(resolvePersonality("demanding")).toBe("demanding");
    expect(PERSONALITIES).toHaveLength(5);
  });
});

describe("settings.setPersonality (chat and voice)", () => {
  it("'ponete exigente' saves the canonical setting and confirms in one line", async () => {
    const s = setup();
    const out = await set(s, { personality: "demanding" });
    expect(out.status).toBe("succeeded");
    expect(s.state.personality).toBe("demanding");
    expect(out.status === "succeeded" && out.display).toMatchObject({
      kind: "setting_changed",
      changes: [
        { setting: "personality", from: "Servicial y eficiente", to: "Exigente y directa" },
      ],
    });
  });

  it("from a voice turn it's the same preference", async () => {
    const s = setup();
    await set(s, { personality: "friendly" }, makeCtx({ modality: "voice" } as never));
    expect(s.state.personality).toBe("friendly");
  });

  it("'volvé a lo normal' returns to Servicial y eficiente", async () => {
    const s = setup("provocative");
    await set(s, { personality: "efficient" });
    expect(s.state.personality).toBe("efficient");
  });

  it("a vague 'cambiá tu personalidad' shows the five choices and changes nothing", async () => {
    const s = setup("motivating");
    const out = await set(s, {});
    expect(out.status === "succeeded" && out.display).toEqual({
      kind: "personality",
      current: "motivating",
    });
    expect(s.state.writes).toBe(0);
  });

  it("an unsupported value is rejected", async () => {
    const s = setup();
    const out = await set(s, { personality: "sadica" });
    expect(out.status).toBe("failed");
    expect(s.state.personality).toBe("efficient");
  });

  it("the voice stays the same", async () => {
    const s = setup();
    await set(s, { personality: "provocative" });
    expect(s.state.voice).toBe("adriana");
  });

  it("never changes what needs approval: the same request takes the same path", async () => {
    const outcomes: string[] = [];
    for (const p of PERSONALITIES) {
      const s = setup();
      await set(s, { personality: p });
      const task = await s.tasks.create({ title: "Pagar luz" });
      const out = await executeToolCall(s.ports, makeCtx(), {
        name: "tasks.delete",
        args: { task: task.id },
      });
      outcomes.push(out.status);
    }
    expect(new Set(outcomes).size).toBe(1);
  });
});

describe("the personality in every prompt", () => {
  const base = {
    user: { displayName: null, locale: "es" as const, timezone: "UTC" },
    now: new Date("2026-10-18T12:00:00Z"),
    availableCapabilities: [],
    history: [],
    userMessage: "hola",
  };

  it("chat: default without a choice; the chosen style otherwise — tone only", () => {
    expect(buildContextPackage(base).cached.instructions).toContain("Servicial y eficiente");
    const demanding = buildContextPackage({ ...base, personality: "demanding" }).cached
      .instructions;
    expect(demanding).toContain("Exigente y directa");
    expect(demanding).toMatch(
      /approvals, confirmations, permissions and safety rules are exactly the same/,
    );
    expect(demanding).not.toContain("Servicial y eficiente (default)");
  });

  it("the provocative one never jokes about sensitive things", () => {
    const text = buildContextPackage({ ...base, personality: "provocative" }).instructions;
    expect(text).toMatch(/never humiliate/);
    expect(text).toMatch(/drop the sarcasm entirely for health, safety/);
  });

  it("live voice speaks in the same personality", () => {
    expect(
      liveInstructions({ locale: "es", displayName: "Leo", personality: "motivating" }),
    ).toContain("Positiva y motivadora");
  });
});
