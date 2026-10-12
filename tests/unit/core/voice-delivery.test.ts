import { describe, expect, it } from "vitest";

import {
  analyzeFrame,
  classifyDelivery,
  DELIVERY,
  DeliverySession,
  deliveryCommand,
  DUCK_FACTOR,
  PcmDeliveryDetector,
  playbackGain,
  type UtteranceDelivery,
} from "@/core/voice/delivery";

const RATE = 48_000;
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

/** A voiced frame: harmonics of a 140 Hz pitch, falling off like a vowel. */
function voiced(amp: number, n = 2048, f0 = 140) {
  const x = new Float32Array(n);
  for (let h = 1; h * f0 < 4000; h++)
    for (let i = 0; i < n; i++) x[i]! += (amp / h) * Math.sin((2 * Math.PI * h * f0 * i) / RATE);
  return x;
}

/** An unvoiced (whispered) frame: coloured noise, no pitch. */
function breath(amp: number, n = 2048) {
  let lp = 0;
  return new Float32Array(n).map(() => (lp = lp * 0.5 + rnd() * 0.5) * amp);
}

function utterance(make: () => Float32Array, frames = 30) {
  const d = new PcmDeliveryDetector();
  for (let i = 0; i < frames; i++) d.frame(make(), RATE, 0.001);
  return d;
}

describe("delivery features (ADR-049)", () => {
  it("separates voiced speech from breath by periodicity, not by level", () => {
    const loudBreath = analyzeFrame(breath(0.3), RATE);
    const softVoice = analyzeFrame(voiced(0.01), RATE);
    expect(softVoice.periodicity).toBeGreaterThan(0.8);
    expect(loudBreath.periodicity).toBeLessThan(DELIVERY.voicedPeriodicity);
    expect(loudBreath.flatness).toBeGreaterThan(softVoice.flatness);
    expect(loudBreath.rms).toBeGreaterThan(softVoice.rms);
  });

  it("ignores frames at the noise floor and says nothing on too little speech", () => {
    const d = new PcmDeliveryDetector();
    for (let i = 0; i < 40; i++) d.frame(breath(0.001), RATE, 0.002);
    expect(d.analyze(0.05)).toBeNull();
    expect(utterance(() => voiced(0.05), DELIVERY.minFrames - 1).analyze(null)).toBeNull();
  });
});

describe("delivery classification", () => {
  const baseline = utterance(() => voiced(0.05)).analyze(null)!.level;

  it("normal speech is normal", () => {
    expect(utterance(() => voiced(0.05)).analyze(baseline)).toMatchObject({ mode: "normal" });
  });

  it("whispered speech is a whisper, even as loud as normal speech (AGC)", () => {
    const quietWhisper = utterance(() => breath(0.02)).analyze(baseline)!;
    expect(quietWhisper.mode).toBe("whisper");
    const agcWhisper = utterance(() => breath(0.12)).analyze(baseline)!;
    expect(agcWhisper.mode).toBe("whisper");
    expect(quietWhisper.confidence).toBeGreaterThanOrEqual(agcWhisper.confidence);
  });

  it("quiet is relative to the user's own baseline", () => {
    const soft = utterance(() => voiced(0.012));
    expect(soft.analyze(baseline)).toMatchObject({ mode: "quiet", levelOnly: true });
    // The same level is this user's normal when their baseline is that low.
    expect(soft.analyze(soft.analyze(null)!.level)).toMatchObject({ mode: "normal" });
  });

  it("a far microphone (quiet but voiced) is never a whisper", () => {
    const far = utterance(() => voiced(0.006)).analyze(baseline)!;
    expect(far.mode).not.toBe("whisper");
    expect(far.levelOnly).toBe(true);
  });

  it("ambiguous evidence lands on quiet, not whisper", () => {
    const e = { frames: 30, level: 0.03, voicedRatio: 0.2, flatness: 0.01 };
    expect(classifyDelivery(e, 0.03)).toMatchObject({ mode: "quiet" });
    expect(classifyDelivery({ ...e, voicedRatio: 0.05 }, 0.03)?.mode).toBe("whisper");
  });

  it("only numbers are kept: no audio is retained by the detector", () => {
    const d = utterance(() => breath(0.02));
    const kept = Object.values(d as unknown as Record<string, unknown>);
    expect(kept.some((v) => v instanceof Float32Array)).toBe(false);
    d.reset();
    expect(d.analyze(baseline)).toBeNull();
  });
});

describe("delivery session: baseline, hysteresis, explicit requests", () => {
  const u = (mode: UtteranceDelivery["mode"], confidence = 0.9, level = 0.05, levelOnly = false) =>
    ({ mode, confidence, level, ...(levelOnly ? { levelOnly } : {}) }) as UtteranceDelivery;

  it("normal, normal, whisper, whisper, quiet, normal: down, then back up, no oscillation", () => {
    const s = new DeliverySession();
    let t = 0;
    expect(s.observe(u("normal"), (t += 5000))).toBe("normal");
    expect(s.observe(u("normal"), (t += 5000))).toBe("normal");
    expect(s.baselineLevel).toBeCloseTo(0.05);
    expect(s.observe(u("whisper", 0.8, 0.01), (t += 5000))).toBe("whisper");
    expect(s.observe(u("whisper", 0.8, 0.01), (t += 5000))).toBe("whisper");
    // Quieter speech keeps the whisper going: no need to whisper every sentence.
    expect(s.observe(u("quiet", 0.7, 0.02, true), (t += 5000))).toBe("whisper");
    expect(s.observe(null, (t += 5000))).toBe("whisper");
    // A weak "normal" neither exits nor flips.
    expect(s.observe(u("normal", 0.4), (t += 5000))).toBe("whisper");
    // A clearly normal turn comes back up at once.
    expect(s.observe(u("normal", 0.95), (t += 5000))).toBe("normal");
  });

  it("whisper fades back to normal after the hold window without quiet speech", () => {
    const s = new DeliverySession();
    s.observe(u("whisper", 0.8), 0);
    expect(s.current(DELIVERY.holdMs - 1)).toBe("whisper");
    expect(s.current(DELIVERY.holdMs)).toBe("normal");
  });

  it("loudness alone never starts a quieter delivery (far microphone)", () => {
    const s = new DeliverySession();
    s.observe(u("normal"), 0);
    expect(s.observe(u("quiet", 0.9, 0.01, true), 1000)).toBe("normal");
    expect(s.observe(u("quiet", 0.6, 0.02), 2000)).toBe("quiet");
  });

  it("quiet turns don't drag the baseline down", () => {
    const s = new DeliverySession();
    s.observe(u("normal", 0.9, 0.05), 0);
    s.observe(u("quiet", 0.9, 0.01, true), 1000);
    s.observe(u("whisper", 0.9, 0.005), 2000);
    expect(s.baselineLevel).toBeCloseTo(0.05);
  });

  it("an explicit whisper request wins over detection, for a while", () => {
    const s = new DeliverySession();
    expect(s.command("whisper", 0)).toBe("whisper");
    expect(s.observe(u("normal", 1), 1000)).toBe("whisper");
    expect(s.source).toBe("explicit");
    expect(s.current(DELIVERY.explicitMs)).toBe("normal");
  });

  it("an explicit normal request wins over a detected whisper", () => {
    const s = new DeliverySession();
    s.observe(u("whisper", 0.9), 0);
    expect(s.command("normal", 1000)).toBe("normal");
    expect(s.observe(u("whisper", 0.9), 2000)).toBe("normal");
  });

  it("adaptive off: normal unless asked; explicit requests still work", () => {
    const s = new DeliverySession(false);
    expect(s.observe(u("whisper", 0.95), 0)).toBe("normal");
    expect(s.command("whisper", 1)).toBe("whisper");
    const on = new DeliverySession();
    on.observe(u("whisper", 0.95), 0);
    on.setAdaptive(false);
    expect(on.current(1)).toBe("normal");
  });
});

describe("explicit delivery requests (intent from words)", () => {
  it.each([
    ["Susurrame.", "whisper"],
    ["Estoy en una biblioteca", "whisper"],
    ["Hablá bajito, porfa", "quiet"],
    ["No hables tan fuerte", "quiet"],
    ["Podés hablar normal", "normal"],
    ["Ya podés hablar fuerte", "normal"],
    ["Please whisper", "whisper"],
    ["You can speak normally now", "normal"],
    ["¿Qué reuniones tengo mañana?", null],
    ["Bajá el volumen de la música", null],
  ])("%s → %s", (text, mode) => {
    expect(deliveryCommand(text)).toBe(mode);
  });
});

describe("playback gain and music ducking", () => {
  it("lowers ELISE's own gain, on top of the user's volume", () => {
    expect(playbackGain("normal")).toBe(1);
    expect(playbackGain("quiet")).toBeGreaterThanOrEqual(0.6);
    expect(playbackGain("quiet")).toBeLessThanOrEqual(0.75);
    expect(playbackGain("whisper")).toBeGreaterThanOrEqual(0.3);
    expect(playbackGain("whisper")).toBeLessThanOrEqual(0.5);
    expect(playbackGain("whisper", 0.5)).toBeCloseTo(0.5 * playbackGain("whisper"));
  });

  it("ducks music harder for a whisper instead of raising her voice", () => {
    expect(DUCK_FACTOR.whisper).toBeLessThan(DUCK_FACTOR.quiet);
    expect(DUCK_FACTOR.quiet).toBeLessThan(DUCK_FACTOR.normal);
  });
});
