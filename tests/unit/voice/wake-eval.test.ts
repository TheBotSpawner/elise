import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WAKE_POLICIES,
  WakeArbiter,
  type WakePolicy,
  type WakeWord,
} from "@/core/voice/wake-arbiter";

/**
 * Wake word evaluation (ADR-108), replayed: what the shipped model (Vosk small Spanish) said on
 * the synthetic corpus under simulated distance, music and meetings
 * (desktop/scripts/wake-eval/simulate.py), run through the decision rules that ship. "v1" is the
 * energy gate and rules before ADR-108, "v2" after. Synthetic voices and rooms: a proxy that
 * guards against regressions, not a promise about every microphone.
 */

interface Trace {
  clip: string;
  kind: "pos" | "neg";
  phrase: string;
  distance: string;
  background: string;
  gate: "v1" | "v2";
  speechAt: number;
  seconds: number;
  fedFrames: number;
  frames: number;
  events: (
    | { f: number; type: "partial"; text: string }
    | { f: number; type: "final"; text: string; words: WakeWord[] }
  )[];
}

const data = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/wake-eval-traces.json"), "utf8"),
) as { tokens: string[]; frameMs: number; traces: Trace[] };

/**
 * v1 kept a fixed 1.6 s before a word confirmed from a partial; v2 keeps the whole utterance
 * from its start, as far back as the 8 s ring allows.
 */
const kept = (policy: WakePolicy) => (policy.name === "v1" ? 13 * 0.128 : 63 * 0.128);

interface Run {
  accepts: { at: number; source: "partial" | "final"; guarded: boolean }[];
}

function replay(trace: Trace, arbiter: WakeArbiter, offset = 0): Run {
  const accepts: Run["accepts"] = [];
  for (const e of trace.events) {
    const at = offset + e.f * data.frameMs;
    const d =
      e.type === "partial"
        ? arbiter.signal({ kind: "partial", text: e.text, at })
        : arbiter.signal({ kind: "final", text: e.text, words: e.words, at });
    if (d?.accept) accepts.push({ at, source: d.source, guarded: d.guarded });
  }
  return { accepts };
}

function measure(policy: WakePolicy) {
  const traces = data.traces.filter((t) => t.gate === policy.name);
  const pos = traces.filter((t) => t.kind === "pos");
  const byCondition = new Map<string, { hit: number; n: number }>();
  const latencies: number[] = [];
  let preserved = 0;
  let hits = 0;
  for (const t of pos) {
    const r = replay(t, new WakeArbiter(data.tokens, policy));
    const key = `${t.distance}/${t.background}`;
    const c = byCondition.get(key) ?? { hit: 0, n: 0 };
    c.n++;
    const first = r.accepts[0];
    if (first) {
      c.hit++;
      hits++;
      const sinceSpeech = first.at / 1000 - t.speechAt;
      latencies.push(sinceSpeech);
      if (first.source === "final" || sinceSpeech <= kept(policy)) preserved++;
    }
    byCondition.set(key, c);
  }
  // Negatives in a row, one arbiter, continuous time: a meeting, not isolated clips.
  const neg = traces.filter((t) => t.kind === "neg");
  const arbiter = new WakeArbiter(data.tokens, policy);
  let clock = 0;
  let candidates = 0;
  let audible = 0;
  for (const t of neg) {
    const r = replay(t, arbiter, clock);
    for (const a of r.accepts) {
      candidates++;
      // v1 chimed on every candidate; v2 chimes when it accepts unguarded.
      if (policy.name === "v1" || !a.guarded) audible++;
      // The transcription of a negative never opens with the name: rejected.
      arbiter.rejected(a.at);
    }
    clock += t.seconds * 1000;
  }
  const hours = clock / 3_600_000;
  latencies.sort((a, b) => a - b);
  const q = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] ?? NaN;
  return {
    recall: hits / pos.length,
    byCondition: Object.fromEntries([...byCondition].map(([k, v]) => [k, `${v.hit}/${v.n}`])),
    preserved: hits ? preserved / hits : 0,
    latencyP50: q(0.5),
    latencyP95: q(0.95),
    negativeMinutes: clock / 60_000,
    candidatesPerHour: candidates / hours,
    audiblePerHour: audible / hours,
    decodedShare:
      traces.reduce((s, t) => s + t.fedFrames, 0) / traces.reduce((s, t) => s + t.frames, 0),
  };
}

describe("wake word evaluation (synthetic corpus, real model)", () => {
  const v1 = measure(WAKE_POLICIES.v1);
  const v2 = measure(WAKE_POLICIES.v2);

  it("prints the before/after report", () => {
    console.info(JSON.stringify({ v1, v2 }, null, 1));
    expect(data.traces.length).toBeGreaterThan(0);
  });

  it("v2 hears at least as many real calls as v1 overall, and more from 3 m", () => {
    expect(v2.recall).toBeGreaterThanOrEqual(v1.recall);
    const far = (m: ReturnType<typeof measure>) =>
      Object.entries(m.byCondition)
        .filter(([k]) => k.startsWith("d300"))
        .reduce((s, [, v]) => s + Number(v.split("/")[0]), 0);
    expect(far(v2)).toBeGreaterThanOrEqual(far(v1));
  });

  it("v2 makes no more false candidates than v1, and no more audible ones", () => {
    expect(v2.candidatesPerHour).toBeLessThanOrEqual(v1.candidatesPerHour);
    expect(v2.audiblePerHour).toBeLessThanOrEqual(v1.audiblePerHour);
  });

  it("v2 is no slower to wake than v1", () => {
    expect(v2.latencyP50).toBeLessThanOrEqual(v1.latencyP50 + 0.05);
    expect(v2.latencyP95).toBeLessThanOrEqual(v1.latencyP95 + 0.05);
  });

  it("v2 keeps the beginning of the request", () => {
    expect(v2.preserved).toBe(1);
  });
});
