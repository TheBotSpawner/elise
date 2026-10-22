import { describe, expect, it } from "vitest";

import { StreamResampler } from "@/core/voice/resample";
import { WAKE_POLICIES, WakeArbiter, type WakeWord } from "@/core/voice/wake-arbiter";
import { wakeGate } from "@/core/voice/wake-detector";

const TOKENS = ["elise", "elis"];
const word = (w: string, start: number, conf = 0.9): WakeWord => ({
  word: w,
  conf,
  start,
  end: start + 0.4,
});
const partial = (text: string, at: number) => ({ kind: "partial" as const, text, at });
const final = (words: WakeWord[], at: number) => ({
  kind: "final" as const,
  text: words.map((w) => w.word).join(" "),
  words,
  at,
});

describe("wake arbiter (ADR-108)", () => {
  it("the word opening what is said wakes, with or without a courtesy word first", () => {
    expect(new WakeArbiter(TOKENS).signal(partial("elise", 0))).toMatchObject({ accept: true });
    expect(new WakeArbiter(TOKENS).signal(partial("che elise qué", 0))).toMatchObject({
      accept: true,
    });
  });

  it("the name in the middle of a sentence doesn't (v1 did)", () => {
    expect(new WakeArbiter(TOKENS).signal(partial("le dije a elise", 0))).toEqual({
      accept: false,
      reason: "mid_sentence",
    });
    expect(
      new WakeArbiter(TOKENS, WAKE_POLICIES.v1).signal(partial("le dije a elise", 0)),
    ).toMatchObject({ accept: true });
  });

  it("in a final result, a real pause before the word counts as opening; a weak word doesn't wake", () => {
    const a = new WakeArbiter(TOKENS);
    expect(
      a.signal(final([word("bueno", 0), word("listo", 0.5), word("elise", 1.6)], 0)),
    ).toMatchObject({
      accept: true,
      source: "final",
      wordStart: 1.6,
    });
    expect(new WakeArbiter(TOKENS).signal(final([word("la", 0), word("elise", 0.45)], 0))).toEqual({
      accept: false,
      reason: "mid_sentence",
    });
    expect(new WakeArbiter(TOKENS).signal(final([word("elise", 0, 0.3)], 0))).toEqual({
      accept: false,
      reason: "low_confidence",
    });
  });

  it("one utterance is one activation (refractory)", () => {
    const a = new WakeArbiter(TOKENS);
    expect(a.signal(partial("elise", 0))).toMatchObject({ accept: true });
    expect(a.signal(final([word("elise", 0)], 400))).toEqual({
      accept: false,
      reason: "refractory",
    });
  });

  it("after a false alarm, partials don't count and finals need more confidence (guarded)", () => {
    const a = new WakeArbiter(TOKENS);
    a.rejected(0);
    expect(a.signal(partial("elise", 5_000))).toEqual({ accept: false, reason: "guarded_partial" });
    expect(a.signal(final([word("elise", 0, 0.7)], 5_000))).toEqual({
      accept: false,
      reason: "low_confidence",
    });
    expect(a.signal(final([word("elise", 0, 0.9)], 5_100))).toMatchObject({
      accept: true,
      guarded: true,
    });
  });

  it("a burst of false alarms pauses detection briefly; a real call lifts the guard", () => {
    const a = new WakeArbiter(TOKENS);
    a.rejected(0);
    a.rejected(10_000);
    expect(a.signal(final([word("elise", 0, 0.99)], 15_000))).toEqual({
      accept: false,
      reason: "cooldown",
    });
    expect(a.signal(final([word("elise", 0, 0.99)], 31_000))).toMatchObject({ accept: true });
    a.confirmed();
    expect(a.signal(partial("elise", 40_000))).toMatchObject({ accept: true, guarded: false });
  });

  it("with ELISE's music playing, partial guesses don't count", () => {
    expect(new WakeArbiter(TOKENS).signal(partial("elise", 0), { music: true })).toEqual({
      accept: false,
      reason: "guarded_partial",
    });
  });

  it("ignores everything that doesn't involve the word", () => {
    expect(new WakeArbiter(TOKENS).signal(partial("hola qué tal", 0))).toBeNull();
  });
});

describe("wake gate (ADR-108)", () => {
  it("lets a quiet, far voice reach the recognizer (v1 needed -38 dBFS and 3x the room)", () => {
    const farVoice = 10 ** (-42 / 20);
    const room = 10 ** (-58 / 20);
    expect(wakeGate(farVoice, room)).toBe(true);
    expect(farVoice > Math.max(room * 3, 0.012)).toBe(false);
    expect(wakeGate(room * 1.5, room)).toBe(false);
  });
});

describe("stream resampler (ADR-108)", () => {
  const sine = (f: number, rate: number, n: number) =>
    Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / rate));
  const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

  it("48 kHz → 16 kHz keeps speech-band tones and their length", () => {
    const r = new StreamResampler(48_000, 16_000);
    const out = r.push(sine(1000, 48_000, 48_000));
    expect(out.length).toBeGreaterThanOrEqual(15_999);
    expect(out.length).toBeLessThanOrEqual(16_001);
    // Past the filter's start-up, the tone's level is kept.
    expect(rms(out.slice(200))).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it("removes what 16 kHz can't represent (no aliasing into the speech band)", () => {
    const out = new StreamResampler(48_000, 16_000).push(sine(12_000, 48_000, 48_000));
    expect(rms(out.slice(200))).toBeLessThan(0.02);
  });

  it("chunk boundaries change nothing (no clicks)", () => {
    const x = sine(700, 44_100, 44_100);
    const whole = new StreamResampler(44_100, 16_000).push(x);
    const r = new StreamResampler(44_100, 16_000);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 441) parts.push(...r.push(x.slice(i, i + 441)));
    expect(parts.length).toBe(whole.length);
    let maxDiff = 0;
    for (let i = 0; i < whole.length; i++)
      maxDiff = Math.max(maxDiff, Math.abs(whole[i]! - parts[i]!));
    expect(maxDiff).toBeLessThan(1e-5);
  });
});
