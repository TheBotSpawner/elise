/**
 * Which recognizer hints are a real "ELISE" (ADR-108). The local recognizer (Vosk, ADR-095)
 * reports partial guesses while someone speaks and a final result with word times and
 * confidences when they pause. Before ADR-108 any guess that contained the word woke ELISE
 * ("v1"): a fast but jumpy rule that chimed on the name in the middle of a meeting sentence and
 * on unstable partials. "v2" separates a *candidate* from an *activation*:
 *
 * - the word must open what is being said (or follow a real pause): "le dije a Elise que…" is
 *   not a call;
 * - a final result must be confident (a partial counts at once: waiting for it to hold was
 *   measured to cost calls and latency without removing any false activation);
 * - after the transcription says a candidate wasn't a call, the next ones need more evidence
 *   for a while (guarded), and a burst of them pauses detection briefly — a meeting can't chain
 *   activations;
 * - with music playing, partial guesses don't count (they wander with the music).
 *
 * Pure and deterministic: the detector feeds it, recorded traces replay through it
 * (tests/unit/voice/wake-eval.test.ts). Times are monotonic milliseconds.
 */

export interface WakeWord {
  word: string;
  /** Recognizer confidence, 0–1. */
  conf: number;
  /** Seconds since the recognizer started. */
  start: number;
  end: number;
}

export type WakeSignal =
  | { kind: "partial"; text: string; at: number }
  | { kind: "final"; text: string; words: readonly WakeWord[]; at: number };

export interface WakePolicy {
  name: "v1" | "v2";
  /** v2: the word must open the utterance, or follow a pause at least this long (s). */
  pauseBefore: number;
  /** v2: a partial counts once it held the word this long (ms). */
  stableMs: number;
  /** v2: minimum confidence of the word in a final result. */
  minConf: number;
  /** v2: guarded (after a rejection, or with music): minimum confidence; partials don't count. */
  guardedConf: number;
  /** v2: how long a rejection keeps detection guarded (ms). */
  guardMs: number;
  /** v2: this many rejections within `burstMs` pause detection for `cooldownMs`. */
  burst: number;
  burstMs: number;
  cooldownMs: number;
  /** After an activation, the same words can't fire again (ms). */
  refractoryMs: number;
}

export const WAKE_POLICIES: Record<WakePolicy["name"], WakePolicy> = {
  v1: {
    name: "v1",
    pauseBefore: 0,
    stableMs: 120,
    minConf: 0,
    guardedConf: 0,
    guardMs: 0,
    burst: Infinity,
    burstMs: 0,
    cooldownMs: 0,
    refractoryMs: 1500,
  },
  v2: {
    name: "v2",
    pauseBefore: 0.35,
    // Measured (wake-eval): waiting for a partial to hold cost detections and latency and
    // removed no false activation — the opening-word rule and the transcription do that.
    stableMs: 0,
    minConf: 0.55,
    guardedConf: 0.8,
    guardMs: 3 * 60_000,
    burst: 2,
    burstMs: 60_000,
    cooldownMs: 20_000,
    refractoryMs: 1500,
  },
};

/** Courtesy words that may come before the name ("che, Elise", "ok Elise"). */
const SOFT_LEAD = new Set(["che", "ey", "hey", "ok", "okay", "oye", "hola", "bueno", "dale"]);

export type WakeDecision =
  | {
      accept: true;
      source: "partial" | "final";
      /** Where the word started (seconds since the recognizer started), when known. */
      wordStart: number | null;
      confidence: number | null;
      /** Detection was guarded: confirm with the transcription before any sound. */
      guarded: boolean;
    }
  | {
      accept: false;
      reason:
        | "mid_sentence"
        | "unstable"
        | "low_confidence"
        | "guarded_partial"
        | "cooldown"
        | "refractory";
    };

export class WakeArbiter {
  private lastAccept = -Infinity;
  private rejections: number[] = [];
  /** When a partial opening with the word was first seen (this utterance). */
  private partialSince: number | null = null;

  constructor(
    private readonly tokens: readonly string[],
    readonly policy: WakePolicy = WAKE_POLICIES.v2,
  ) {}

  private isWord = (w: string) => this.tokens.includes(w);

  /** Whether detection is guarded now (recent rejections), and whether it's paused. */
  guard(now: number): { guarded: boolean; cooling: boolean } {
    const p = this.policy;
    this.rejections = this.rejections.filter((t) => now - t < Math.max(p.guardMs, p.burstMs));
    const recent = this.rejections.filter((t) => now - t < p.burstMs);
    const cooling = recent.length >= p.burst && now - this.rejections.at(-1)! < p.cooldownMs;
    return { guarded: this.rejections.some((t) => now - t < p.guardMs), cooling };
  }

  /** A recognizer hint; null when it doesn't involve the word at all. */
  signal(s: WakeSignal, ctx: { music?: boolean } = {}): WakeDecision | null {
    const words =
      s.kind === "partial" ? s.text.split(/\s+/).filter(Boolean) : s.words.map((w) => w.word);
    if (!words.some(this.isWord)) {
      if (s.kind === "final" || !s.text) this.partialSince = null;
      return null;
    }
    const p = this.policy;
    const reject = (reason: Extract<WakeDecision, { accept: false }>["reason"]) => {
      if (s.kind === "final") this.partialSince = null;
      return { accept: false as const, reason };
    };
    if (s.at - this.lastAccept < p.refractoryMs) return reject("refractory");

    if (p.name === "v1") {
      const w = s.kind === "final" ? s.words.find((x) => this.isWord(x.word)) : undefined;
      return this.accept(s, w ?? null, false);
    }

    const { guarded: recent, cooling } = this.guard(s.at);
    if (cooling) return reject("cooldown");
    const guarded = recent || Boolean(ctx.music);

    if (s.kind === "partial") {
      // The word opens what is being said (after at most one courtesy word).
      const at = words.findIndex(this.isWord);
      const opens = at === 0 || (at === 1 && SOFT_LEAD.has(words[0]!));
      if (!opens) {
        this.partialSince = null;
        return reject("mid_sentence");
      }
      if (guarded) return reject("guarded_partial");
      this.partialSince ??= s.at;
      if (s.at - this.partialSince < p.stableMs) return reject("unstable");
      return this.accept(s, null, false);
    }

    // Final: the word's place and confidence are known.
    const i = s.words.findIndex((w) => this.isWord(w.word));
    const w = s.words[i]!;
    const prev = s.words[i - 1];
    const lead = i === 1 && SOFT_LEAD.has(prev!.word);
    const opens = i === 0 || lead || (prev !== undefined && w.start - prev.end >= p.pauseBefore);
    if (!opens) return reject("mid_sentence");
    if (w.conf < (guarded ? p.guardedConf : p.minConf)) return reject("low_confidence");
    return this.accept(s, w, guarded);
  }

  private accept(s: WakeSignal, w: WakeWord | null, guarded: boolean): WakeDecision {
    this.lastAccept = s.at;
    this.partialSince = null;
    return {
      accept: true,
      source: s.kind,
      wordStart: w ? w.start : null,
      confidence: w ? w.conf : null,
      guarded,
    };
  }

  /** The transcription said the candidate wasn't a call ("ELISE" didn't open it). */
  rejected(now: number) {
    this.rejections.push(now);
  }

  /** A real activation: the guard is lifted. */
  confirmed() {
    this.rejections = [];
  }

  /** A new recognizer (after a conversation): half-heard partials don't carry over. */
  reset() {
    this.partialSince = null;
  }
}
