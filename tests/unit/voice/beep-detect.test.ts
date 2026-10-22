import { describe, expect, it } from "vitest";

import { classifyBeep, detectBeeps } from "@/core/voice/beep-detect";

/**
 * The output check's analyzer (ADR-108), on synthetic audio: it must find a chime-like beep, a
 * high-frequency burst and a click where they are — and nothing in speech-like audio.
 */

const RATE = 48_000;

/** Speech-like: a gliding 140–220 Hz voice with 1/n harmonics, syllable envelope, a little noise. */
function speechLike(seconds: number, seed = 1): Float32Array {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  let s = seed;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f0 = 180 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
    phase += (2 * Math.PI * f0) / RATE;
    let v = 0;
    for (let h = 1; h <= 25; h++) v += Math.sin(h * phase) / h;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
    s = (s * 1103515245 + 12345) % 2147483648;
    x[i] = 0.08 * env * v + 0.004 * (s / 2147483648 - 0.5);
  }
  return x;
}

function addTone(x: Float32Array, at: number, ms: number, freq: number, amp = 0.1) {
  const a = Math.round(at * RATE);
  const n = Math.round((ms / 1000) * RATE);
  for (let i = 0; i < n && a + i < x.length; i++)
    x[a + i]! +=
      amp * Math.sin((2 * Math.PI * freq * i) / RATE) * Math.min(1, i / 200, (n - i) / 200);
}

describe("beep detection (ADR-108)", () => {
  it("finds nothing in speech-like audio", () => {
    expect(detectBeeps(speechLike(4), RATE)).toEqual([]);
  });

  it("finds a chime-like tone over speech, where and what it is", () => {
    const x = speechLike(4);
    addTone(x, 1.5, 180, 1318.5, 0.2);
    const found = detectBeeps(x, RATE).filter((e) => e.kind === "tone");
    expect(found).toHaveLength(1);
    expect(found[0]!.at).toBeGreaterThan(1.45);
    expect(found[0]!.at).toBeLessThan(1.6);
    expect(Math.abs(found[0]!.freq! - 1318)).toBeLessThan(60);
  });

  it("finds a burst of high-frequency images (a badly converted chunk)", () => {
    const x = speechLike(4);
    addTone(x, 2.0, 200, 15_500, 0.05);
    addTone(x, 2.0, 200, 17_200, 0.04);
    const hf = detectBeeps(x, RATE).filter((e) => e.kind === "hf");
    expect(hf).toHaveLength(1);
    expect(hf[0]!.at).toBeGreaterThan(1.95);
    expect(hf[0]!.at).toBeLessThan(2.1);
  });

  it("finds a click", () => {
    const x = speechLike(2);
    x[RATE]! += 0.6;
    const clicks = detectBeeps(x, RATE).filter((e) => e.kind === "click");
    expect(clicks.map((c) => Math.round(c.at))).toEqual([1]);
  });

  it("says where a beep came from", () => {
    const elise = {
      chimes: [3],
      clips: [
        {
          start: 10,
          end: 14,
          events: [{ at: 1, kind: "hf" as const, durationMs: 60, levelDb: -30 }],
        },
      ],
    };
    const ev = (at: number, kind: "tone" | "hf" | "click" = "tone") => ({
      at,
      kind,
      durationMs: 100,
      levelDb: -20,
    });
    expect(classifyBeep(ev(3.1), elise)).toBe("elise_chime");
    expect(classifyBeep(ev(11.05, "hf"), elise)).toBe("in_generated_voice");
    expect(classifyBeep(ev(12.5, "hf"), elise)).toBe("added_after_elise");
    expect(classifyBeep(ev(20), elise)).toBe("not_elise");
  });
});
