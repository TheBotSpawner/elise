/**
 * Adaptive voice delivery (ADR-049): HOW ELISE speaks — normal, quiet or whisper — independent
 * of the interaction phase (listening, speaking…). Decided from the user's own audio while they
 * speak, never from the transcript, so it is ready the moment the turn ends (no added latency,
 * no extra model call). Pure math on raw PCM: the browser, and later a native app, only feed
 * samples. Nothing here stores audio; a turn keeps a few numbers per frame and drops them.
 */

export const VOICE_DELIVERIES = ["normal", "quiet", "whisper"] as const;
export type VoiceDelivery = (typeof VOICE_DELIVERIES)[number];

export interface DeliveryEstimate {
  mode: VoiceDelivery;
  /** 0..1: how sure the evidence is about `mode`. */
  confidence: number;
  /** "quiet" from loudness alone (no unvoicing): may sustain a softer delivery, never start it. */
  levelOnly?: boolean;
}

/** One utterance's verdict, plus its speech level (the session baseline learns from it). */
export interface UtteranceDelivery extends DeliveryEstimate {
  level: number;
}

/**
 * The capability a voice runtime needs: feed it the user's speech as it arrives, ask for the
 * turn's delivery at the end. The web implementation is `PcmDeliveryDetector`; a native app
 * (or a small specialized model) can provide its own.
 */
export interface VoiceDeliveryDetector {
  /** One frame of microphone PCM (any rate), with the room's noise floor (RMS). */
  frame(samples: Float32Array, sampleRate: number, noiseFloor: number): void;
  /** The turn so far, judged against the user's own normal level (null: not enough speech). */
  analyze(baselineLevel: number | null): UtteranceDelivery | null;
  reset(): void;
}

/**
 * Calibration (ADR-049 §calibration). Measured on the ELISE Spanish voice rendered normal,
 * quiet and whispered, attenuated (far microphone) and mixed with noise; to be retuned with
 * real microphones. Biased to false negatives: an unsure whisper is "quiet", never "whisper".
 */
export const DELIVERY = {
  /** A frame counts as speech above this many times the noise floor (and an absolute minimum). */
  speechOverFloor: 2.5,
  minSpeechRms: 0.003,
  /** Below this much speech (~50 ms frames) a turn says nothing about delivery. */
  minFrames: 8,
  /** A frame is voiced (vocal folds vibrating) at this normalized autocorrelation. */
  voicedPeriodicity: 0.55,
  /** Voiced-frame ratio: at or under `whisperVoiced` fully unvoiced, at `normalVoiced` not at all. */
  whisperVoiced: 0.12,
  normalVoiced: 0.4,
  /**
   * Spectral flatness (0 tonal … 1 noise) where breathy speech starts / fully is. Speech keeps
   * its formants when whispered, so the useful range is low (voiced ~0.01, whispered ~0.02+).
   */
  flatLow: 0.015,
  flatHigh: 0.045,
  /** Level vs. the user's own normal: at `quietRatio` and under fully quiet, at `normalRatio` not. */
  quietRatio: 0.3,
  normalRatio: 0.7,
  /** Confidence needed to whisper back; between `quietFloor` and it, the safer "quiet". */
  whisperAt: 0.72,
  quietFloor: 0.45,
  quietAt: 0.6,
  /** A clearly normal utterance (this confident) ends quiet/whisper at once. */
  exitNormalAt: 0.6,
  /** Quiet speech within this long keeps whisper/quiet going (no need to whisper every line). */
  holdMs: 30_000,
  /** An explicit request ("susurrame", "hablá normal") wins for this long. */
  explicitMs: 10 * 60_000,
  baselineAlpha: 0.3,
} as const;

/** ELISE's own playback gain per delivery, times the user's voice volume (never system volume). */
export const DELIVERY_GAIN: Record<VoiceDelivery, number> = {
  normal: 1,
  quiet: 0.7,
  whisper: 0.45,
};

export const playbackGain = (mode: VoiceDelivery, userVolume = 1) =>
  Math.max(0, Math.min(1, userVolume)) * DELIVERY_GAIN[mode];

/** Music under ELISE (ADR-042 §J): ducked harder for a whisper instead of raising her voice. */
export const DUCK_FACTOR: Record<VoiceDelivery, number> = {
  normal: 0.35,
  quiet: 0.25,
  whisper: 0.15,
};

// ── Per-frame features ───────────────────────────────────────────────────────

export interface DeliveryFrame {
  rms: number;
  /** Max normalized autocorrelation in the 70–400 Hz pitch range: ~0.8+ voiced, low unvoiced. */
  periodicity: number;
  /** Spectral flatness 200–5000 Hz: harmonics are peaky (low), breath is flat (high). */
  flatness: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Features of one frame of raw PCM (decimated to ~16 kHz: pitch and breath live below 8 kHz). */
export function analyzeFrame(samples: Float32Array, sampleRate: number): DeliveryFrame {
  let sum = 0;
  for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  const factor = Math.max(1, Math.round(sampleRate / 16_000));
  const rate = sampleRate / factor;
  const n = Math.floor(samples.length / factor);
  const x = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < factor; j++) acc += samples[i * factor + j]!;
    x[i] = acc / factor;
    mean += x[i]!;
  }
  mean /= Math.max(1, n);
  for (let i = 0; i < n; i++) x[i]! -= mean;
  return { rms, periodicity: periodicity(x, rate), flatness: flatness(x, rate) };
}

function periodicity(x: Float32Array, rate: number): number {
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(Math.ceil(rate / 70), Math.floor(x.length / 2));
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < x.length; i++) {
      const a = x[i]!;
      const b = x[i + lag]!;
      xy += a * b;
      xx += a * a;
      yy += b * b;
    }
    if (xx > 0 && yy > 0) best = Math.max(best, xy / Math.sqrt(xx * yy));
  }
  return clamp01(best);
}

const FFT_SIZE = 512;

function flatness(x: Float32Array, rate: number): number {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const start = Math.max(0, x.length - FFT_SIZE);
  for (let i = 0; i < FFT_SIZE && start + i < x.length; i++)
    re[i] = x[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  fft(re, im);
  const lo = Math.ceil((200 * FFT_SIZE) / rate);
  const hi = Math.min(FFT_SIZE / 2 - 1, Math.floor((5000 * FFT_SIZE) / rate));
  let logSum = 0;
  let linSum = 0;
  for (let k = lo; k <= hi; k++) {
    const p = re[k]! * re[k]! + im[k]! * im[k]! + 1e-12;
    logSum += Math.log(p);
    linSum += p;
  }
  const bins = hi - lo + 1;
  return clamp01(Math.exp(logSum / bins) / (linSum / bins));
}

/** In-place iterative radix-2 FFT (length is a power of two). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
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
        re[a]! += tr;
        im[a]! += ti;
      }
  }
}

// ── One utterance ────────────────────────────────────────────────────────────

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** What the speech frames of one turn add up to. */
export interface UtteranceEvidence {
  frames: number;
  level: number;
  voicedRatio: number;
  flatness: number;
}

/**
 * Deterministic classification. Whisper needs unvoiced speech (no vocal-fold periodicity);
 * loudness relative to the user's own baseline and breathiness only add to it — volume alone
 * never whispers, because AGC, distance and microphones change it. A voiced but much quieter
 * turn is "quiet" (a far microphone lands here at worst, never in "whisper").
 */
export function classifyDelivery(
  e: UtteranceEvidence,
  baselineLevel: number | null,
): DeliveryEstimate | null {
  if (e.frames < DELIVERY.minFrames) return null;
  const d = DELIVERY;
  const unvoiced = clamp01((d.normalVoiced - e.voicedRatio) / (d.normalVoiced - d.whisperVoiced));
  const breathy = clamp01((e.flatness - d.flatLow) / (d.flatHigh - d.flatLow));
  const ratio = baselineLevel ? e.level / baselineLevel : null;
  const quietness =
    ratio === null ? null : clamp01((d.normalRatio - ratio) / (d.normalRatio - d.quietRatio));
  // Unvoicing carries the decision (AGC can make a whisper as loud as normal speech).
  const whisper = unvoiced * (0.75 + 0.25 * Math.max(breathy, quietness ?? 0));
  const round = (v: number) => Math.round(v * 100) / 100;
  if (whisper >= d.whisperAt) return { mode: "whisper", confidence: round(whisper) };
  if (whisper >= d.quietFloor) return { mode: "quiet", confidence: round(whisper) };
  // Voiced but much quieter than usual: soft speech — or a far microphone. Volume alone can
  // keep an ongoing quiet/whisper going, never start one (ELISE must not drop when far away).
  if ((quietness ?? 0) >= d.quietAt)
    return { mode: "quiet", confidence: round(quietness!), levelOnly: true };
  return { mode: "normal", confidence: round(1 - Math.max(whisper, quietness ?? 0)) };
}

/** The web detector: features per frame, a verdict per turn. Only numbers are kept. */
export class PcmDeliveryDetector implements VoiceDeliveryDetector {
  private levels: number[] = [];
  private voiced = 0;
  private flats: number[] = [];

  frame(samples: Float32Array, sampleRate: number, noiseFloor: number) {
    const f = analyzeFrame(samples, sampleRate);
    if (f.rms < Math.max(noiseFloor * DELIVERY.speechOverFloor, DELIVERY.minSpeechRms)) return;
    this.levels.push(f.rms);
    this.flats.push(f.flatness);
    if (f.periodicity >= DELIVERY.voicedPeriodicity) this.voiced++;
  }

  evidence(): UtteranceEvidence {
    const frames = this.levels.length;
    return {
      frames,
      level: median(this.levels),
      voicedRatio: frames ? this.voiced / frames : 0,
      flatness: median(this.flats),
    };
  }

  analyze(baselineLevel: number | null): UtteranceDelivery | null {
    const e = this.evidence();
    const estimate = classifyDelivery(e, baselineLevel);
    return estimate ? { ...estimate, level: e.level } : null;
  }

  reset() {
    this.levels = [];
    this.voiced = 0;
    this.flats = [];
  }
}

// ── The session: baseline, continuity, explicit requests ────────────────────

export type DeliverySource = "auto" | "explicit";

/**
 * Per voice session only (never a permanent profile of the user's voice): the user's normal
 * level, the current delivery with hysteresis, and explicit overrides, which always win.
 */
export class DeliverySession {
  mode: VoiceDelivery = "normal";
  source: DeliverySource | null = null;
  private until = 0;
  private baseline: number | null = null;
  private adaptive: boolean;

  constructor(adaptive = true) {
    this.adaptive = adaptive;
  }

  get baselineLevel() {
    return this.baseline;
  }

  /** A copy to ask "what would this turn decide" without committing it. */
  clone(): DeliverySession {
    return Object.assign(new DeliverySession(this.adaptive), this);
  }

  setAdaptive(on: boolean) {
    this.adaptive = on;
    if (!on && this.source === "auto") this.reset();
  }

  /** The delivery now (an automatic or explicit mode ends when its window runs out). */
  current(now: number): VoiceDelivery {
    if (this.source && now >= this.until) this.reset();
    return this.mode;
  }

  /** ELISE finished answering: an automatic quiet/whisper window restarts from now. */
  extend(now: number) {
    if (this.source === "auto") this.until = Math.max(this.until, now + DELIVERY.holdMs);
  }

  /** The conversation paused (the session slept): an automatic quiet/whisper ends with it. */
  endAuto() {
    if (this.source === "auto") this.reset();
  }

  /** "Susurrame" / "hablá normal": wins over detection for a while (not forever). */
  command(mode: VoiceDelivery, now: number): VoiceDelivery {
    this.mode = mode;
    this.source = "explicit";
    this.until = now + DELIVERY.explicitMs;
    return mode;
  }

  /** One finished user turn's evidence → the delivery for ELISE's reply. */
  observe(u: UtteranceDelivery | null, now: number): VoiceDelivery {
    const current = this.current(now);
    if (!u) return current;
    // Only clearly normal turns teach the baseline: quiet ones would drag it down.
    if (u.mode === "normal" && u.confidence >= DELIVERY.exitNormalAt)
      this.baseline =
        this.baseline === null
          ? u.level
          : this.baseline * (1 - DELIVERY.baselineAlpha) + u.level * DELIVERY.baselineAlpha;
    if (this.source === "explicit" || !this.adaptive) return current;
    if (u.mode === "whisper") return this.enter("whisper", now);
    if (u.mode === "quiet") {
      if (u.levelOnly && current === "normal") return current;
      return this.enter(current === "whisper" ? "whisper" : "quiet", now);
    }
    if (u.confidence >= DELIVERY.exitNormalAt) {
      this.reset();
      return this.mode;
    }
    return current; // a weak "normal" neither exits nor refreshes
  }

  private enter(mode: VoiceDelivery, now: number) {
    this.mode = mode;
    this.source = "auto";
    this.until = now + DELIVERY.holdMs;
    return mode;
  }

  private reset() {
    this.mode = "normal";
    this.source = null;
    this.until = 0;
  }
}

// ── Explicit requests ────────────────────────────────────────────────────────

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const WHISPER_ASK =
  /\b(susurr\w*|whisper\w*|(estoy|estamos) en (una|la) biblioteca|(i'?m|we'?re|i am|we are) in (a|the) library)\b/;
const QUIET_ASK =
  /\b(habl\w* (mas )?(bajito|bajo|despacio y bajo)|(en|con) voz (mas )?baja|baja(me)? (la|el) (voz|volumen de tu voz)|no (me )?hables tan fuerte|mas bajito|speak (more )?(quietly|softly)|talk (more )?(quietly|softly)|lower your voice|keep (your|it) (voice )?down|(don'?t|do not) (talk|speak) so loud)\b/;
const NORMAL_ASK =
  /\b((ya )?(podes|puedes) (volver a )?hablar (normal|fuerte|mas fuerte)|habla(me)? (normal|mas fuerte)|volve a hablar normal|subi la voz|(you can )?speak (normally|up|louder)|talk (normally|louder)|you can talk normally)\b/;

/**
 * A conversational request to change how ELISE speaks (intent, from the words — the delivery
 * of the words themselves is judged from audio). Null when the turn asks nothing of the kind.
 */
export function deliveryCommand(text: string): VoiceDelivery | null {
  const t = fold(text);
  if (NORMAL_ASK.test(t)) return "normal";
  if (WHISPER_ASK.test(t)) return "whisper";
  if (QUIET_ASK.test(t)) return "quiet";
  return null;
}
