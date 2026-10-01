import { VOICE_LIMITS } from "./providers";

/**
 * Turn taking for continuous voice (ADR-017 §2-3), pure and testable without a microphone.
 * The browser feeds it audio levels; it decides when the user started, paused, finished, or
 * talked over ELISE. Every threshold lives here.
 */

export const VOICE_TURN = {
  tickMs: 50,
  /** The first moments of each utterance calibrate the room's noise floor. */
  calibrateMs: 400,
  minThreshold: 0.012,
  floorFactor: 2.5,
  /** Voiced time before a pause can end the turn. */
  minSpeechMs: 250,
  /** A pause this long starts a speculative transcription of what was said so far. */
  snapshotPauseMs: 600,
  /** Silence that ends a turn that sounds finished… */
  endSilenceMs: 1100,
  /** …and one that sounds unfinished ("y", "pero", "the", a comma). Conservative on purpose. */
  unfinishedSilenceMs: 2400,
  /** Nothing said for this long: the utterance ends empty. */
  noSpeechMs: 8_000,
  maxUtteranceMs: VOICE_LIMITS.maxUtteranceMs,
  /** Listening this long with nobody speaking puts the session to sleep. */
  sleepAfterMs: 30_000,
  barge: {
    /** While ELISE speaks, this long estimates how much of her voice leaks into the mic. */
    calibrateMs: 600,
    /** User speech must last this long over the predicted echo. */
    holdMs: 280,
    margin: 0.02,
    echoFactor: 2.5,
    floorFactor: 3,
  },
} as const;

export type TurnSignal = "speech_start" | "pause" | "resumed" | "end" | "no_speech" | null;

/**
 * One utterance's turn detection. `frame()` takes the input RMS every tick and returns at
 * most one signal. `unfinished(true)` (the speculative transcript sounds cut off) asks for a
 * longer silence before the turn ends.
 */
export class TurnDetector {
  private start = -1;
  private floor = 0;
  private floorN = 0;
  private voicedMs = 0;
  private lastVoice = -1;
  private speaking = false;
  private paused = false;
  private done = false;
  private wantLonger = false;
  private calibrated = false;
  private resumed = false;

  constructor(
    private readonly cfg: typeof VOICE_TURN = VOICE_TURN,
    /**
     * Barge-in: the user is already talking, so the room can't be calibrated now — use the
     * floor measured earlier in the session and count the turn as started.
     */
    resume?: { floor: number },
  ) {
    if (resume) {
      this.calibrated = true;
      this.resumed = true;
      this.floor = resume.floor;
      this.speaking = true;
      this.voicedMs = cfg.minSpeechMs;
    }
  }

  /** The calibrated noise floor (kept for a later barge-in). */
  get noiseFloor() {
    return this.floor;
  }

  get heard() {
    return this.voicedMs >= this.cfg.minSpeechMs;
  }

  unfinished(yes: boolean) {
    this.wantLonger = yes;
  }

  frame(rms: number, now: number): TurnSignal {
    if (this.done) return null;
    if (this.start < 0) {
      this.start = now;
      // A resumed turn is mid-speech: its silence counts from now.
      if (this.resumed) this.lastVoice = now;
    }
    const elapsed = now - this.start;
    if (!this.calibrated) {
      if (elapsed < this.cfg.calibrateMs) {
        this.floor = (this.floor * this.floorN + rms) / ++this.floorN;
        return null;
      }
      this.calibrated = true;
    }
    const threshold = Math.max(this.cfg.minThreshold, this.floor * this.cfg.floorFactor);
    if (rms > threshold) {
      this.voicedMs += this.cfg.tickMs;
      this.lastVoice = now;
      if (!this.speaking && this.voicedMs >= this.cfg.tickMs * 2) {
        this.speaking = true;
        return "speech_start";
      }
      if (this.paused) {
        this.paused = false;
        return "resumed";
      }
      return null;
    }
    if (elapsed >= this.cfg.maxUtteranceMs) return this.finish("end");
    if (!this.heard) return elapsed >= this.cfg.noSpeechMs ? this.finish("no_speech") : null;
    const silence = now - this.lastVoice;
    const needed = this.wantLonger ? this.cfg.unfinishedSilenceMs : this.cfg.endSilenceMs;
    if (silence >= needed) return this.finish("end");
    if (!this.paused && silence >= this.cfg.snapshotPauseMs) {
      this.paused = true;
      return "pause";
    }
    return null;
  }

  private finish(signal: "end" | "no_speech"): TurnSignal {
    this.done = true;
    return signal;
  }
}

const UNFINISHED_WORDS = new Set(
  // Spanish: conjunctions, prepositions, articles, fillers.
  (
    "y e o u ni pero que de del la el los las un una unos unas con para por en a al como porque " +
    "entonces este esta eh em mm mmm o sea si cuando donde mi mis tu tus su sus le les lo me se " +
    "muy mas más tambien también hasta desde sobre entre sin " +
    // English.
    "and or but the a an to of for with in on at because so um uh er like my your his her their " +
    "is are was if when that which who about from into than then also"
  ).split(" "),
);

/**
 * The transcript sounds cut off mid-sentence: it ends on a word that needs a continuation, a
 * comma, or a filler. No psychology — only the last word.
 */
export function looksUnfinished(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/[.!?¿¡]$/.test(t)) return false;
  if (/[,;:…-]$/.test(t) || t.endsWith("...")) return true;
  const last = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-zñ0-9']+/)
    .filter(Boolean)
    .at(-1);
  return last ? UNFINISHED_WORDS.has(last) : false;
}

/**
 * Barge-in while ELISE speaks (ADR-017 §3): the mic hears both her (through the speakers,
 * reduced by echo cancellation) and possibly the user. During calibration it learns how much
 * of her output reaches the mic; afterwards only input clearly above that predicted echo, held
 * for a moment, counts as the user talking. Headphones make the coupling ~0.
 */
export class BargeInDetector {
  private start = -1;
  private coupling = 0;
  private floor = 0;
  private floorN = 0;
  private heldMs = 0;

  constructor(private readonly cfg = VOICE_TURN.barge) {}

  frame(mic: number, out: number, now: number): boolean {
    if (this.start < 0) this.start = now;
    if (now - this.start < this.cfg.calibrateMs) {
      if (out > 0.01) this.coupling = Math.max(this.coupling, mic / out);
      else {
        this.floor = (this.floor * this.floorN + mic) / ++this.floorN;
      }
      return false;
    }
    const predicted = this.coupling * out * this.cfg.echoFactor;
    const threshold = Math.max(this.floor * this.cfg.floorFactor, this.cfg.margin) + predicted;
    this.heldMs = mic > threshold ? this.heldMs + VOICE_TURN.tickMs : 0;
    return this.heldMs >= this.cfg.holdMs;
  }
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 1);

/**
 * A transcript that is mostly what ELISE just said is her own voice leaking back, not the
 * user: dropped instead of being answered.
 */
export function isSelfEcho(transcript: string, spokenRecently: string): boolean {
  const said = words(transcript);
  if (said.length < 2) return false;
  const spoken = new Set(words(spokenRecently));
  if (!spoken.size) return false;
  const overlap = said.filter((w) => spoken.has(w)).length / said.length;
  return overlap >= 0.7;
}
