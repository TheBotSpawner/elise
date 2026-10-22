/**
 * Finds the sounds people call "beeps" in recorded audio (ADR-108), so a report can say *where*
 * one came from instead of guessing:
 *
 * - "tone": a short, steady, pure tone (a chime, a system beep) — one frequency carrying most
 *   of the energy for 60–800 ms. Speech isn't one: its energy spreads over many harmonics.
 * - "hf": a burst of energy above 12 kHz far beyond the recording's own level up there — what a
 *   badly converted chunk of 24 kHz speech sounds like (a short metallic whistle).
 * - "click": a single-sample discontinuity far above the local texture.
 *
 * Pure (no audio APIs): the same function analyzes a system-output recording and ELISE's own
 * generated audio, so the two can be compared.
 */

export interface AudioEvent {
  /** Seconds from the start of the analyzed audio. */
  at: number;
  kind: "tone" | "hf" | "click";
  durationMs: number;
  /** The tone's frequency (Hz). */
  freq?: number;
  /** Level in dBFS. */
  levelDb: number;
}

const FFT = 1024;

function fftPower(frame: Float64Array): Float64Array {
  const n = frame.length;
  const re = Float64Array.from(frame);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len)
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
  }
  const p = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) p[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return p;
}

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

export const BEEP_RULES = {
  /** Share of the 300–5000 Hz energy in one peak for a frame to count as a pure tone. */
  toneShare: 0.7,
  /** A beep sits above the voice's dominant low harmonics (measured on real speech). */
  toneMinHz: 700,
  toneMinMs: 60,
  toneMaxMs: 800,
  /**
   * A burst: above-12-kHz energy at least `hfOverBaseline` times the recording's median there,
   * and at least `hfShare` of the frame — loud up high, not just a quiet moment's noise floor.
   */
  hfShare: 0.02,
  hfOverBaseline: 20,
  /**
   * A click: a second-difference spike this many times the largest one around it (±1 ms) —
   * isolated, unlike a sibilant's dense texture — and at least `clickMin`.
   */
  clickOverNeighbors: 6,
  clickMin: 0.05,
  /** Frames quieter than this (dBFS) are not analyzed for tones. */
  floorDb: -50,
} as const;

export function detectBeeps(x: Float32Array, rate: number): AudioEvent[] {
  const hop = Math.round(rate * 0.02);
  const hann = Float64Array.from(
    { length: FFT },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1)),
  );
  const bin = rate / FFT;
  const k300 = Math.ceil(300 / bin);
  const kTone = Math.ceil(BEEP_RULES.toneMinHz / bin);
  const k5k = Math.floor(5000 / bin);
  const k80 = Math.ceil(80 / bin);
  const k12k = Math.ceil(12_000 / bin);
  const kTop = Math.min(FFT / 2, Math.floor(20_000 / bin));
  const frames: { at: number; rms: number; tone: number | null; hf: number; hfEnergy: number }[] =
    [];
  const frame = new Float64Array(FFT);
  for (let s = 0; s + FFT <= x.length; s += hop) {
    let sum = 0;
    for (let i = 0; i < FFT; i++) {
      frame[i] = x[s + i]! * hann[i]!;
      sum += x[s + i]! * x[s + i]!;
    }
    const rms = Math.sqrt(sum / FFT);
    const p = fftPower(frame);
    let band = 0;
    let peak = k300;
    for (let k = k300; k <= k5k; k++) {
      band += p[k]!;
      if (p[k]! > p[peak]!) peak = k;
    }
    const share = band > 0 ? (p[peak - 1]! + p[peak]! + p[peak + 1]!) / band : 0;
    let all = 0;
    let high = 0;
    for (let k = k80; k < FFT / 2; k++) all += p[k]!;
    for (let k = k12k; k < kTop; k++) high += p[k]!;
    frames.push({
      at: s / rate,
      rms,
      tone:
        db(rms) > BEEP_RULES.floorDb && share >= BEEP_RULES.toneShare && peak >= kTone
          ? peak
          : null,
      hf: all > 0 && k12k < kTop ? high / all : 0,
      hfEnergy: high,
    });
  }
  const events: AudioEvent[] = [];
  const hopMs = (hop / rate) * 1000;

  // Tones: runs of tonal frames on (nearly) the same frequency.
  for (let i = 0; i < frames.length;) {
    const k = frames[i]!.tone;
    if (k === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < frames.length && frames[j]!.tone !== null && Math.abs(frames[j]!.tone! - k) <= 2)
      j++;
    const ms = (j - i) * hopMs;
    if (ms >= BEEP_RULES.toneMinMs && ms <= BEEP_RULES.toneMaxMs)
      events.push({
        at: +frames[i]!.at.toFixed(3),
        kind: "tone",
        durationMs: Math.round(ms),
        freq: Math.round(k * bin),
        levelDb: Math.round(db(Math.max(...frames.slice(i, j).map((f) => f.rms)))),
      });
    i = j;
  }

  // High-frequency bursts, against the recording's own high-frequency level.
  const energies = frames.map((f) => f.hfEnergy).sort((a, b) => a - b);
  const baseline = energies.length ? energies[Math.floor(energies.length / 2)]! : 0;
  const burst = (f: (typeof frames)[number]) =>
    f.hf > BEEP_RULES.hfShare &&
    f.hfEnergy > baseline * BEEP_RULES.hfOverBaseline &&
    db(f.rms) > BEEP_RULES.floorDb;
  for (let i = 0; i < frames.length;) {
    if (!burst(frames[i]!)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < frames.length && burst(frames[j]!)) j++;
    if (j - i >= 2)
      events.push({
        at: +frames[i]!.at.toFixed(3),
        kind: "hf",
        durationMs: Math.round((j - i) * hopMs),
        levelDb: Math.round(db(Math.max(...frames.slice(i, j).map((f) => f.rms)))),
      });
    i = j;
  }

  // Clicks: isolated second-difference spikes, against their own neighborhood.
  const d2 = new Float32Array(x.length);
  for (let i = 2; i < x.length; i++) d2[i] = Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!);
  const near = Math.max(4, Math.round(rate * 0.001));
  let last = -Infinity;
  for (let i = 2; i < x.length; i++) {
    const v = d2[i]!;
    if (v < BEEP_RULES.clickMin || i - last < rate * 0.005) continue;
    let around = 0;
    for (let k = Math.max(2, i - near); k <= Math.min(x.length - 1, i + near); k++)
      if (Math.abs(k - i) > 2 && d2[k]! > around) around = d2[k]!;
    if (v > around * BEEP_RULES.clickOverNeighbors) {
      events.push({
        at: +(i / rate).toFixed(4),
        kind: "click",
        durationMs: 0,
        levelDb: Math.round(db(v)),
      });
      last = i;
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

export type BeepOrigin =
  /** ELISE's own chime (wake, error) at that moment. */
  | "elise_chime"
  /** Already in the voice audio ELISE generated (the speech provider's audio). */
  | "in_generated_voice"
  /** ELISE was speaking and its generated audio was clean there: added on the way out. */
  | "added_after_elise"
  /** Nothing of ELISE at that moment: another app or the system. */
  | "not_elise";

/**
 * Where a beep found in the system's output came from, given what ELISE logged (times in
 * seconds on the same clock): its chimes, and the voice audio it played with each clip's own
 * analysis. `tolerance` absorbs the output and capture latency.
 */
export function classifyBeep(
  e: AudioEvent,
  elise: {
    chimes: number[];
    clips: { start: number; end: number; events: AudioEvent[] }[];
  },
  tolerance = 0.4,
): BeepOrigin {
  if (
    e.kind === "tone" &&
    elise.chimes.some((t) => e.at >= t - tolerance && e.at <= t + 0.6 + tolerance)
  )
    return "elise_chime";
  const clip = elise.clips.find((c) => e.at >= c.start - tolerance && e.at <= c.end + tolerance);
  if (!clip) return "not_elise";
  const inside = clip.events.some(
    (v) => v.kind === e.kind && Math.abs(clip.start + v.at - e.at) <= tolerance,
  );
  return inside ? "in_generated_voice" : "added_after_elise";
}
