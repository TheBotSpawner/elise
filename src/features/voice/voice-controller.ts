import type { VoiceTurnMeta } from "@/core/interaction";
import type { WakeEngine } from "@/core/voice/device";
import type { VoiceLanguage } from "@/core/voice/providers";
import {
  initialVoice,
  isHearing,
  voiceReducer,
  type SleepReason,
  type VoiceEvent,
  type VoicePhase,
  type VoiceState,
  type WakeStatus,
} from "@/core/voice/session";
import {
  ackIntent,
  pickAcknowledgement,
  predictIntent,
  progressLine,
  PROGRESS_AFTER_MS,
  stillSayable,
  type AckIntent,
  type SpeechCategory,
  type SpeechState,
} from "@/core/voice/speech-plan";
import { SentenceChunker } from "@/core/voice/speech-text";
import {
  BargeInDetector,
  calibrateFloor,
  endVerdict,
  isSelfEcho,
  TurnDetector,
  VOICE_TURN,
} from "@/core/voice/turn";
import type { WakePhrase } from "@/core/voice/wake";

import type { SegmentStats, SpeakOptions } from "./speech-player";

/**
 * One continuous voice session (ADR-014, ADR-017), framework-free so it is tested with fake
 * audio and a manual clock. It listens, decides when the user finished (energy + a speculative
 * transcript), sends the same chat turn as typing (modality "voice"), speaks the streamed
 * reply sentence by sentence, notices when the user talks over ELISE, sleeps when nobody
 * speaks, and wakes on a tap or the on-device wake phrase. It decides nothing about the
 * request itself: Shortcuts, approvals and tools all happen on the server, in the same turn.
 */

export interface MicPort {
  open(): Promise<void>;
  begin(): void;
  snapshot(): Blob | null;
  finish(): Promise<{ blob: Blob; durationMs: number }>;
  discard(): void;
  close(): void;
  rms(): number;
  level(): number;
  readonly recording: boolean;
}

export interface PlayerPort {
  speak(text: string, language: VoiceLanguage | null, options?: SpeakOptions): void;
  stop(): void;
  close(): void;
  rms(): number;
  level(): number;
  chime?(): void;
  /**
   * Fetches a line's audio ahead without playing it: the acknowledgement chosen from the
   * provisional transcript is ready by the time the turn ends (ADR-036). Preparation only.
   */
  prepare?(text: string, language: VoiceLanguage | null): void;
  readonly speaking: boolean;
  onStart: (() => void) | null;
  onIdle: (() => void) | null;
  onError: (() => void) | null;
  /** Per spoken segment: size, silence before it, time to first audio (diagnostics). */
  onSegment?: ((s: SegmentStats) => void) | null;
}

export type Transcriber = (
  audio: Blob,
  onPartial: (text: string) => void,
  signal: AbortSignal,
) => Promise<{ text: string; language: VoiceLanguage | null } | null>;

export type StreamEvent =
  | { type: "conversation" }
  | { type: "tool_started"; name?: string }
  | { type: "tool_finished"; outcome?: { status: string } }
  | { type: "workspace" }
  | { type: "text"; delta: string }
  | { type: "spoken"; delta: string }
  | { type: "finished"; failed: boolean }
  /** The chat started a request: only after its own start does a turn take stream events. */
  | { type: "turn_started"; text: string }
  | { type: string };

export type VoiceMarks = Partial<
  Record<
    | "wake"
    | "listening"
    | "speechStart"
    | "lastVoice"
    | "speechEnd"
    | "turnDetected"
    | "transcriptFinal"
    | "speculative"
    | "runtimeStart"
    | "firstTool"
    | "firstSurface"
    | "firstText"
    | "ackReady"
    | "ackTts"
    | "progressTts"
    | "toolsDone"
    | "resultSpeech"
    | "audioStart"
    | "segments"
    | "avgSegmentChars"
    | "maxGapMs"
    | "firstAudioMs"
    | "bargeIn"
    | "audioStopped"
    | "turnComplete"
    /** How the turn's end was decided: 1 complete phrase, 2 unfinished, 0 no verdict. */
    | "endVerdict"
    /** 1: this turn continued one that was cut too early (its text was carried over). */
    | "continuation",
    number
  >
>;

export interface VoicePrefs {
  speak: boolean;
  bargeIn: boolean;
  continuous: boolean;
  wakeEnabled: boolean;
  wakePhrase: WakePhrase;
  language: "es" | "en";
}

export interface VoiceDeps {
  createMic: () => MicPort;
  /** Called from the user's tap, so the browser allows playback. */
  createPlayer: () => PlayerPort;
  transcribe: Transcriber;
  send: (text: string, options: { modality: "voice"; voice: VoiceTurnMeta }) => void;
  onState: (state: VoiceState) => void;
  onTimings?: (marks: VoiceMarks) => void;
  now?: () => number;
  /** Repeats `fn` every `ms` until cancelled (a manual clock in tests). */
  every?: (ms: number, fn: () => void) => () => void;
  /** Runs `fn` once after `ms` (a manual clock in tests). */
  later?: (ms: number, fn: () => void) => void;
  /** Cancels the chat request in flight (a turn cut too early is replaced by the whole one). */
  cancel?: () => void;
  /** Synthesizes the acknowledgement lines ahead for this voice (fire and forget). */
  warmAcknowledgements?: (language: "es" | "en") => void;
  micProblem?: (error: unknown) => "permission_denied" | "no_microphone" | "not_supported";
  wake?: WakeEngine | null;
  online?: () => boolean;
  /** Development diagnostics: lifecycle events with timings, never audio or full text. */
  trace?: (event: string, data?: Record<string, unknown>) => void;
}

interface SpokenTurn {
  language: VoiceLanguage | null;
  chunker: SentenceChunker;
  /** The model's spoken synthesis (ADR-019). Once it arrives, only it is spoken. */
  spokenChunker: SentenceChunker | null;
  t0: number;
  marks: VoiceMarks;
  textDone: boolean;
  /** Characters spoken so far: past the limit the rest stays on screen. */
  spokenChars: number;
  spoken: string;
  capped: boolean;
  awaitingApproval: boolean;
  /** The turn's activity, shared with what is said (ADR-028). */
  speech: SpeechState;
  acked: boolean;
  /** What the user said (the request this turn waits for). */
  text: string;
  /**
   * Taking stream events. False after a barge-in or interruption until this turn's own request
   * starts: the abandoned request's late words must never be spoken as this turn's (ADR-034).
   */
  open: boolean;
  /** What kind of work the acknowledgement announced (ADR-034); null: none was said. */
  intent: AckIntent | null;
  /** A tool of this turn failed: no more progress talk. */
  failed: boolean;
  progressed: boolean;
}

interface Snapshot {
  version: number;
  abort: AbortController;
  promise: Promise<{ text: string; language: VoiceLanguage | null } | null>;
}

/** Fired when voice preferences change without a reload (Settings, or ELISE herself). */
export const VOICE_PREFS_EVENT = "elise:voice-prefs";

/**
 * Talking over ELISE this soon after a turn ended, before any result was spoken, means the turn
 * was cut too early: what is said next continues it instead of replacing it (ADR-036).
 */
const CONTINUATION_MS = 4_000;

/** Longest wait for a transcript before the turn is treated as not understood. */
const TRANSCRIBE_TIMEOUT_MS = 25_000;

/** Voice carries the synthesis; a long answer is spoken up to here, the rest is on screen. */
export const SPOKEN_LIMIT = 420;
const REST_ON_SCREEN = {
  es: "El resto te lo dejo en pantalla.",
  en: "The rest is on screen.",
} as const;

export class VoiceController {
  state: VoiceState;
  private mic: MicPort | null = null;
  private player: PlayerPort | null = null;
  private turn: SpokenTurn | null = null;
  private detector: TurnDetector | null = null;
  private barge: BargeInDetector | null = null;
  private cancelTick: (() => void) | null = null;
  private snap: Snapshot | null = null;
  /** Bumped whenever the user speaks again after a pause: a snapshot older than this is stale. */
  private voiceVersion = 0;
  private floor = 0;
  /** The room has been measured this session (once, while arming). */
  private calibrated = false;
  /** Calibration frames while arming (null when not calibrating). */
  private calibration: number[] | null = null;
  private calibrationStart = 0;
  /**
   * Monotonic capture generation: every utterance gets a new one, and async work (snapshot,
   * transcription) that finishes after a newer utterance started is ignored.
   */
  private capture = 0;
  private t0 = 0;
  private marks: VoiceMarks = {};
  private lastActivity = 0;
  private bargeTurn = false;
  /** Acknowledgements said recently in this session, so the next one varies (ADR-034). */
  private ackHistory: string[] = [];
  /** The previous turn was talked over or interrupted while its request may still stream. */
  private superseded = false;
  private warmed = false;
  private lastSpoken = "";
  private hidden = false;
  private finishing = false;
  /** The acknowledgement chosen from the provisional transcript, its audio being prepared. */
  private preparedAck: { version: number; intent: AckIntent; line: string } | null = null;
  /** A turn cut too early: its words lead the next utterance (premature-close recovery). */
  private carry: string | null = null;
  private tailUntil = 0;

  constructor(
    private deps: VoiceDeps,
    private prefs: VoicePrefs,
  ) {
    this.state = {
      ...initialVoice,
      speak: prefs.speak,
      bargeIn: prefs.bargeIn,
      continuous: prefs.continuous,
      wake: prefs.wakeEnabled ? "ready" : "off",
    };
  }

  /** The send function changes identity with React renders. */
  update(deps: Partial<VoiceDeps>) {
    this.deps = { ...this.deps, ...deps };
  }

  /** Preferences changed (Settings, or ELISE changed her wake phrase). */
  setPrefs(prefs: Partial<VoicePrefs>) {
    this.prefs = { ...this.prefs, ...prefs };
    this.state = {
      ...this.state,
      speak: this.prefs.speak,
      bargeIn: this.prefs.bargeIn,
      continuous: this.prefs.continuous,
    };
    if (!this.prefs.wakeEnabled) {
      this.deps.wake?.stop();
      this.act({ type: "wake_status", status: "off" });
    } else if (this.state.wake === "off") this.act({ type: "wake_status", status: "ready" });
    if (this.state.phase === "sleeping") this.startWake();
    else this.deps.onState(this.state);
  }

  /** What this browser can do for the wake phrase (checked by the hook). */
  setWakeStatus(status: WakeStatus) {
    this.act({ type: "wake_status", status: this.prefs.wakeEnabled ? status : "off" });
    if (this.state.phase === "sleeping") this.startWake();
  }

  private get now() {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private act(event: VoiceEvent) {
    const from = this.state.phase;
    this.state = voiceReducer(this.state, event);
    if (this.state.phase !== from)
      this.trace("phase", { from, to: this.state.phase, via: event.type });
    this.deps.onState(this.state);
  }

  private trace(event: string, data: Record<string, unknown> = {}) {
    this.deps.trace?.(event, { at: Math.round(this.now), ...data });
  }

  private mark(key: keyof VoiceMarks) {
    const at = Math.round(this.now - this.t0);
    if (this.turn) this.turn.marks[key] ??= at;
    else this.marks[key] ??= at;
  }

  // ── Session ────────────────────────────────────────────────────────────────

  async start() {
    const phase = this.state.phase;
    if (phase !== "idle" && phase !== "error" && phase !== "sleeping") return;
    this.deps.wake?.stop();
    this.ensurePlayer();
    // The acknowledgements in this voice are synthesized ahead, once: they play at once later.
    if (this.prefs.speak && !this.warmed) {
      this.warmed = true;
      this.deps.warmAcknowledgements?.(this.prefs.language);
    }
    this.act({
      type: "start",
      speak: this.prefs.speak,
      bargeIn: this.prefs.bargeIn,
      continuous: this.prefs.continuous,
    });
    await this.openMic();
  }

  private ensurePlayer() {
    if (!this.prefs.speak || this.player) return;
    const p = this.deps.createPlayer();
    p.onStart = () => this.onAudioStart();
    p.onIdle = () => {
      if (this.turn?.textDone) this.complete();
    };
    p.onError = () => this.act({ type: "speech_failed" });
    p.onSegment = (seg) => {
      const turn = this.turn;
      this.trace("segment", { chars: seg.chars, gapMs: seg.gapMs, firstAudioMs: seg.firstAudioMs });
      if (!turn) return;
      const m = turn.marks;
      const n = (m.segments ?? 0) + 1;
      m.avgSegmentChars = Math.round(((m.avgSegmentChars ?? 0) * (n - 1) + seg.chars) / n);
      m.segments = n;
      m.maxGapMs = Math.max(m.maxGapMs ?? 0, seg.gapMs);
      m.firstAudioMs ??= seg.firstAudioMs;
    };
    this.player = p;
  }

  private async openMic() {
    const mic = (this.mic ??= this.deps.createMic());
    try {
      await mic.open();
      if (this.state.phase !== "arming") return;
      if (this.calibrated) return this.ready();
      // Still "arming": measure the room first, so "listening" is never a half-deaf promise.
      this.calibration = [];
      this.calibrationStart = this.now;
      this.trace("calibration_started");
      this.startTicker();
    } catch (error) {
      mic.close();
      this.act({ type: "mic_failed", problem: this.deps.micProblem?.(error) ?? "not_supported" });
    }
  }

  private ready() {
    this.act({ type: "mic_ready" });
    this.lastActivity = this.now;
    this.listen();
  }

  /** A fresh utterance: recorder on, turn detection from zero (the room is calibrated). */
  private listen() {
    const mic = this.mic;
    if (!mic || !isHearing(this.state)) return;
    this.dropSnapshot();
    this.carry = null;
    mic.discard();
    mic.begin();
    this.capture++;
    // A new utterance: any speculative transcript of an earlier one is stale.
    this.voiceVersion++;
    this.detector = new TurnDetector(VOICE_TURN, { floor: this.floor });
    this.bargeTurn = false;
    this.finishing = false;
    this.t0 = this.now;
    this.marks = { listening: 0 };
    this.trace("listen", { floor: this.floor, capture: this.capture });
    this.startTicker();
  }

  private startTicker() {
    if (this.cancelTick) return;
    const every =
      this.deps.every ??
      ((ms, fn) => {
        const id = setInterval(fn, ms);
        return () => clearInterval(id);
      });
    this.cancelTick = every(VOICE_TURN.tickMs, () => this.tick());
  }

  private stopTicker() {
    this.cancelTick?.();
    this.cancelTick = null;
  }

  /** Every 50 ms: who is talking, and is the turn over? */
  tick() {
    const now = this.now;
    const mic = this.mic;
    if (!mic) return;
    if (this.state.phase === "speaking" && this.barge && this.player) {
      if (this.barge.frame(mic.rms(), this.player.rms(), now)) this.bargeIn();
      return;
    }
    if (this.calibration && this.state.phase === "arming") {
      this.calibration.push(mic.rms());
      if (now - this.calibrationStart < VOICE_TURN.calibrateMs) return;
      this.floor = calibrateFloor(this.calibration, VOICE_TURN);
      this.calibration = null;
      this.calibrated = true;
      this.trace("calibrated", { floor: this.floor });
      return this.ready();
    }
    if (this.state.tail) return this.tailFrame(mic.rms(), now);
    if (!isHearing(this.state) || !this.detector || this.finishing) return;
    const signal = this.detector.frame(mic.rms(), now);
    if (this.detector.noiseFloor) this.floor = this.detector.noiseFloor;
    switch (signal) {
      case "speech_start":
        this.trace("speech_start", { sinceListen: Math.round(now - this.t0), floor: this.floor });
        this.lastActivity = now;
        this.mark("speechStart");
        this.act({ type: "speech_start" });
        break;
      case "pause":
        this.trace("pause", { sinceListen: Math.round(now - this.t0) });
        this.takeSnapshot();
        break;
      case "resumed":
        this.lastActivity = now;
        this.voiceVersion++;
        this.dropSnapshot();
        break;
      case "end":
        this.trace("turn_end", { sinceListen: Math.round(now - this.t0) });
        void this.finishTurn();
        break;
      case "no_speech":
        this.trace("discard", { reason: "no_speech" });
        // Nobody spoke: keep listening, or sleep once it has been long enough.
        if (now - this.lastActivity >= VOICE_TURN.sleepAfterMs) this.sleep("inactivity");
        else {
          mic.discard();
          mic.begin();
          this.capture++;
          this.voiceVersion++;
          this.detector = new TurnDetector(VOICE_TURN, { floor: this.floor });
        }
        break;
    }
  }

  /** At a pause: transcribe what was said so far, while the user may still continue. */
  private takeSnapshot() {
    const blob = this.mic?.snapshot();
    if (!blob || !blob.size) return;
    const abort = new AbortController();
    const version = this.voiceVersion;
    const promise = this.deps
      .transcribe(blob, () => {}, abort.signal)
      .then((r) => {
        if (this.snap?.version === version && r) {
          const verdict = endVerdict(r.text);
          this.detector?.verdict(verdict);
          this.trace("provisional", { verdict, chars: r.text.length });
          this.prepareAck(r.text, r.language, version);
          if (this.state.phase === "user_speaking") this.act({ type: "partial", text: r.text });
        }
        return r;
      })
      .catch(() => null);
    this.snap = { version, abort, promise };
  }

  private dropSnapshot() {
    this.snap?.abort.abort();
    this.snap = null;
    this.detector?.verdict(null);
    this.preparedAck = null;
  }

  /**
   * A stable provisional transcript that is clearly a lookup: choose its acknowledgement now
   * and fetch its audio, so it plays the moment the turn ends. Preparation only — nothing is
   * said or sent, and actions are never predicted (predictIntent refuses them).
   */
  private prepareAck(text: string, language: VoiceLanguage | null, version: number) {
    if (!this.prefs.speak || !this.player?.prepare) return;
    const intent = predictIntent(text);
    if (!intent) return;
    const lang = language ?? this.prefs.language;
    const line = pickAcknowledgement(intent, lang, this.ackHistory);
    this.preparedAck = { version, intent, line };
    this.player.prepare(line, language);
    this.trace("ack_prepared", { intent });
  }

  /** The turn is over: the speculative transcript if nothing was said since, else a new one. */
  private async finishTurn() {
    const mic = this.mic;
    if (!mic || !isHearing(this.state)) return;
    const capture = this.capture;
    this.finishing = true;
    const detector = this.detector;
    if (detector && detector.lastVoiceAt >= 0)
      this.marks.lastVoice ??= Math.max(0, Math.round(detector.lastVoiceAt - this.t0));
    this.marks.endVerdict =
      detector?.endVerdict === "complete" ? 1 : detector?.endVerdict === "unfinished" ? 2 : 0;
    this.mark("speechEnd");
    this.mark("turnDetected");
    this.act({ type: "speech_end" });
    const snap = this.snap?.version === this.voiceVersion ? this.snap : null;
    this.snap = null;
    const utterance = await mic.finish();
    // Transcription is bounded: a hung request ends as "didn't catch that", never a session
    // stuck in finalizing_input (the server gives up at 20 s).
    this.trace("finalize", { snapshot: Boolean(snap) });
    let result = snap
      ? await Promise.race([
          snap.promise,
          new Promise<null>((done) => setTimeout(() => done(null), TRANSCRIBE_TIMEOUT_MS)),
        ])
      : null;
    // An empty speculative transcript is not evidence that nothing was said: transcribe all.
    if (result && !result.text.trim()) {
      this.trace("discard", { reason: "empty_speculative" });
      result = null;
    }
    const speculative = Boolean(result);
    if (result) this.mark("speculative");
    if (!result && utterance.blob.size) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);
      result = await this.deps
        .transcribe(utterance.blob, (text) => this.act({ type: "partial", text }), abort.signal)
        .finally(() => clearTimeout(timer));
      // The provider failed (not "nothing said"): one retry of the same audio, never more.
      if (!result && !abort.signal.aborted && (!this.deps.online || this.deps.online())) {
        this.trace("discard", { reason: "stt_failed_retrying" });
        result = await this.deps
          .transcribe(utterance.blob, () => {}, AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS))
          .catch(() => null);
      }
    }
    if (capture !== this.capture) return this.trace("discard", { reason: "session_mismatch" });
    if (this.state.phase !== "finalizing_input") return; // ended meanwhile
    // A continuation that can't be read never loses the request it continued: that goes again.
    if (!result && this.carry) result = { text: "", language: null };
    if (!result) {
      if (this.deps.online && !this.deps.online()) return this.network(false);
      // Never invent what the user said: say so and listen again.
      this.act({ type: "transcription_failed" });
      this.listen();
      return;
    }
    let text = result.text.trim();
    this.trace("transcript", { chars: text.length, speculative });
    // Her own voice leaking back after a barge-in is not the user talking.
    if (text && this.bargeTurn && isSelfEcho(text, this.lastSpoken)) {
      this.trace("discard", { reason: "echo_rejected" });
      text = "";
    }
    if (!text) this.trace("discard", { reason: "empty_final", speculative });
    // The previous turn was cut too early and this is its continuation: one request, whole.
    if (this.carry) {
      text = text ? `${this.carry} ${text}` : this.carry;
      this.marks.continuation = 1;
      this.trace("continuation", { chars: text.length });
    }
    this.carry = null;
    this.act({ type: "transcript", text });
    if (!text) {
      if ((this.state.phase as VoicePhase) === "sleeping") this.afterSleep();
      else this.listen();
      return;
    }
    this.lastActivity = this.now;
    this.beginTurn(text, result.language, utterance.durationMs);
    this.startTail();
  }

  private beginTurn(text: string, language: VoiceLanguage | null, durationMs: number) {
    this.mark("transcriptFinal");
    this.turn = {
      language,
      chunker: new SentenceChunker(),
      spokenChunker: null,
      t0: this.t0,
      marks: { ...this.marks },
      textDone: false,
      spokenChars: 0,
      spoken: "",
      capped: false,
      awaitingApproval: false,
      speech: { running: 0, started: false, resultQueued: false },
      acked: false,
      intent: null,
      failed: false,
      progressed: false,
      text,
      open: !this.superseded,
    };
    this.superseded = false;
    // A plain lookup is clear from the words alone: acknowledge now, while the request goes out,
    // instead of after the model picks its tool (ADR-034). Never for actions.
    const predicted = predictIntent(text);
    const prepared = this.preparedAck;
    this.preparedAck = null;
    if (predicted) {
      this.turn.acked = true;
      this.trace("ack_predicted", { intent: predicted, prepared: prepared?.intent === predicted });
      // The line whose audio was fetched at the pause, when the final words agree.
      this.acknowledge(
        this.turn,
        predicted,
        language ?? this.prefs.language,
        prepared?.intent === predicted ? prepared.line : undefined,
      );
    }
    this.deps.send(text, {
      modality: "voice",
      voice: { durationMs, language, wake: this.state.wake },
    });
  }

  // ── The reply ──────────────────────────────────────────────────────────────

  /** The chat stream of the spoken turn: its text is spoken as it arrives. */
  onStream(event: StreamEvent) {
    const turn = this.turn;
    if (!turn) return;
    if (event.type === "turn_started") {
      if (!turn.open && (event as { text?: string }).text?.trim() === turn.text.trim()) {
        turn.open = true;
        this.trace("stream_opened");
      }
      return;
    }
    // Events of the abandoned request (still streaming ahead of this one): never this turn's.
    if (!turn.open) return;
    const since = () => Math.round(this.now - turn.t0);
    switch (event.type) {
      case "conversation":
        turn.marks.runtimeStart ??= since();
        break;
      case "tool_started": {
        // One progress line, only if the work itself is still running after a real wait
        // (counted from when it started, not from an early acknowledgement).
        if (!turn.speech.started) this.later(PROGRESS_AFTER_MS, () => this.progress(turn));
        turn.marks.firstTool ??= since();
        turn.speech.started = true;
        turn.speech.running++;
        if (!turn.acked) {
          // ACTIVITY_STARTED: speak now, while the work runs — never after its results.
          turn.acked = true;
          // A "what I'm checking" line the model wrote is held for a trailing space that
          // would only come after the tools: it goes out now, as progress.
          const held = (turn.spokenChunker ?? turn.chunker).flush();
          for (const sentence of held) this.say(turn, sentence, "progress");
          // The model already said what it's checking: no second acknowledgement.
          const intent = ackIntent((event as { name?: string }).name ?? "");
          const lang = turn.language ?? this.prefs.language;
          if (turn.spokenChars || held.length || !intent) {
            this.trace("ack_skipped", { reason: intent ? "model_said_it" : "instant" });
          } else this.acknowledge(turn, intent, lang);
        }
        this.act({ type: "tool_started" });
        break;
      }
      case "tool_finished":
        if ((event as { outcome?: { status: string } }).outcome?.status === "approval_required")
          turn.awaitingApproval = true;
        if ((event as { outcome?: { status: string } }).outcome?.status === "failed")
          turn.failed = true;
        turn.speech.running = Math.max(0, turn.speech.running - 1);
        if (!turn.speech.running) turn.marks.toolsDone = since();
        this.act({ type: "tool_finished" });
        break;
      case "workspace":
        turn.marks.firstSurface ??= since();
        break;
      case "spoken":
        if ("delta" in event) {
          turn.marks.firstText ??= since();
          turn.spokenChunker ??= new SentenceChunker();
          for (const sentence of turn.spokenChunker.push(event.delta))
            this.say(turn, sentence, turn.speech.started ? "result" : "conversational");
        }
        break;
      case "text":
        // Fallback for a reply without a spoken part: speak the answer itself, capped.
        if ("delta" in event && !turn.spokenChunker) {
          turn.marks.firstText ??= since();
          for (const sentence of turn.chunker.push(event.delta))
            this.say(turn, sentence, turn.speech.started ? "result" : "conversational");
        }
        break;
      case "finished":
        for (const sentence of (turn.spokenChunker ?? turn.chunker).flush())
          this.say(turn, sentence, turn.speech.started ? "result" : "conversational");
        turn.textDone = true;
        if (!this.player?.speaking) this.complete();
        break;
    }
  }

  /** A short, varied line for the work that's starting, and one later progress check. */
  private acknowledge(turn: SpokenTurn, intent: AckIntent, lang: "es" | "en", line?: string) {
    // Varied, deterministic: not the line said a moment ago (ADR-034).
    const ack = line ?? pickAcknowledgement(intent, lang, this.ackHistory);
    this.ackHistory = [...this.ackHistory, ack].slice(-6);
    turn.intent = intent;
    turn.marks.ackReady ??= Math.round(this.now - turn.t0);
    this.say(turn, ack, "progress");
  }

  /** The single progress update of a long turn — never after a result, a failure or the end. */
  private progress(turn: SpokenTurn) {
    const line = turn.intent
      ? progressLine(turn.intent, turn.language ?? this.prefs.language)
      : null;
    if (
      this.turn !== turn ||
      !line ||
      turn.progressed ||
      turn.failed ||
      turn.speech.resultQueued ||
      turn.speech.running === 0
    ) {
      this.trace("progress_skipped", { ms: Math.round(this.now - turn.t0) });
      return;
    }
    turn.progressed = true;
    this.trace("progress_emitted", { ms: Math.round(this.now - turn.t0) });
    this.say(turn, line, "progress", true);
  }

  private later(ms: number, fn: () => void) {
    if (this.deps.later) this.deps.later(ms, fn);
    else setTimeout(fn, ms);
  }

  private say(turn: SpokenTurn, sentence: string, category: SpeechCategory, isProgress = false) {
    if (turn.capped || !this.player) return;
    if (category === "progress") {
      // Ephemeral: dropped if, by its turn to play, the work finished or the result is coming.
      const line = { category, createdAt: this.now };
      let dropped = false;
      turn.spoken += ` ${sentence}`;
      this.player.speak(sentence, turn.language, {
        valid: () => {
          const ok = this.turn === turn && stillSayable(line, turn.speech, this.now);
          if (!ok && !dropped) {
            dropped = true;
            // Stale: the work finished, the result is coming, or a new turn began.
            this.trace(isProgress ? "progress_dropped" : "ack_dropped_stale", {
              ms: Math.round(this.now - turn.t0),
            });
          }
          return ok;
        },
        onBegin: () => {
          if (isProgress) turn.marks.progressTts ??= Math.round(this.now - turn.t0);
          else turn.marks.ackTts ??= Math.round(this.now - turn.t0);
          this.trace(isProgress ? "progress_tts_started" : "ack_tts_started");
        },
      });
      return;
    }
    if ((category === "result" || category === "conversational") && !turn.speech.resultQueued) {
      // RESULT: from here on, nothing announces work that's already done.
      turn.speech.resultQueued = true;
      turn.marks.resultSpeech ??= Math.round(this.now - turn.t0);
    }
    if (turn.spokenChars > 0 && turn.spokenChars + sentence.length > SPOKEN_LIMIT) {
      turn.capped = true;
      // The model's own synthesis already points to the screen; only a fallback reply says so.
      if (!turn.spokenChunker)
        this.player.speak(REST_ON_SCREEN[turn.language ?? this.prefs.language], turn.language);
      return;
    }
    turn.spokenChars += sentence.length;
    turn.spoken += ` ${sentence}`;
    this.player.speak(sentence, turn.language);
  }

  private onAudioStart() {
    this.endTail();
    this.trace("tts_playback_started");
    if (this.turn) this.turn.marks.audioStart ??= Math.round(this.now - this.turn.t0);
    this.act({ type: "speaking" });
    // Barge-in: the mic keeps listening while she speaks, the recorder already on.
    if (this.state.bargeIn && this.mic && this.state.phase === "speaking") {
      if (!this.mic.recording) this.mic.begin();
      this.barge ??= new BargeInDetector();
      this.startTicker();
    }
  }

  private complete() {
    const turn = this.turn;
    if (!turn) return;
    this.trace("tts_playback_ended");
    turn.marks.turnComplete = Math.round(this.now - turn.t0);
    this.turn = null;
    this.barge = null;
    this.deps.onTimings?.(turn.marks);
    this.lastActivity = this.now;
    this.act({ type: "reply_done", awaitingApproval: turn.awaitingApproval });
    if (this.state.phase === "sleeping") this.afterSleep();
    else this.listen();
  }

  // ── Tail: a turn that ended too early (ADR-036) ─────────────────────────────

  /**
   * Right after the turn is sent, the mic keeps listening for a few seconds. Speech in that
   * window, before any answer is spoken, means the user hadn't finished: the request is
   * cancelled and what they say next is added to what they said (one turn, whole).
   */
  private startTail() {
    const mic = this.mic;
    if (!mic || !this.state.bargeIn || !this.turn) return this.stopTicker();
    mic.begin();
    this.tailUntil = this.now + CONTINUATION_MS;
    this.detector = new TurnDetector(VOICE_TURN, { floor: this.floor });
    this.act({ type: "tail", on: true });
    this.startTicker();
  }

  private endTail() {
    if (!this.state.tail) return;
    this.act({ type: "tail", on: false });
    this.mic?.discard();
    this.detector = null;
    if (this.state.phase !== "speaking") this.stopTicker();
  }

  private tailFrame(rms: number, now: number) {
    const turn = this.turn;
    if (!turn || turn.speech.resultQueued || now >= this.tailUntil) return this.endTail();
    // Real speech (a quarter second of voice), not a cough or a chair, continues the turn.
    this.detector?.frame(rms, now);
    if (!this.detector?.heard) return;
    this.trace("premature_close", { sinceEnd: Math.round(now - turn.t0) });
    this.carry = turn.text;
    this.deps.cancel?.();
    this.player?.stop();
    this.superseded = true;
    this.turn = null;
    this.act({ type: "tail", on: false });
    this.act({ type: "barge_in" });
    this.act({ type: "speech_start" });
    // The recorder has been on since the turn ended: this utterance starts with their words.
    this.dropSnapshot();
    this.capture++;
    this.voiceVersion++;
    this.detector = new TurnDetector(VOICE_TURN, { floor: this.floor, resumed: true });
    this.bargeTurn = false;
    this.finishing = false;
    this.t0 = now;
    this.marks = { speechStart: 0 };
    this.lastActivity = now;
  }

  /** The user talked over ELISE: stop her now and take what they're saying as the next turn. */
  private bargeIn() {
    const turn = this.turn;
    this.player?.stop();
    if (turn) {
      turn.marks.bargeIn = Math.round(this.now - turn.t0);
      turn.marks.audioStopped = turn.marks.bargeIn;
      turn.marks.turnComplete = turn.marks.bargeIn;
      this.deps.onTimings?.(turn.marks);
    }
    this.lastSpoken = turn?.spoken ?? "";
    this.superseded = Boolean(turn && !turn.textDone);
    // Talking over the acknowledgement right after the turn ended, before any answer: the user
    // hadn't finished. Their words continue that request instead of replacing it.
    const cutEarly =
      turn &&
      !turn.speech.resultQueued &&
      turn.marks.transcriptFinal !== undefined &&
      this.now - (turn.t0 + turn.marks.transcriptFinal) <= CONTINUATION_MS;
    this.carry = cutEarly ? turn.text : null;
    if (cutEarly) this.trace("premature_close", { sinceEnd: Math.round(this.now - turn.t0) });
    this.turn = null;
    this.barge = null;
    this.act({ type: "barge_in" });
    this.act({ type: "speech_start" });
    this.dropSnapshot();
    this.capture++;
    this.voiceVersion++;
    this.detector = new TurnDetector(VOICE_TURN, { floor: this.floor, resumed: true });
    this.bargeTurn = true;
    this.finishing = false;
    this.t0 = this.now;
    this.marks = { speechStart: 0 };
    this.lastActivity = this.now;
    this.startTicker();
  }

  /** Tap while ELISE speaks or thinks: stop her and listen; the reply so far stays on screen. */
  interrupt() {
    const phase = this.state.phase;
    if (phase !== "speaking" && phase !== "thinking" && phase !== "executing") return;
    this.player?.stop();
    if (this.turn)
      this.deps.onTimings?.({
        ...this.turn.marks,
        audioStopped: Math.round(this.now - this.turn.t0),
        turnComplete: Math.round(this.now - this.turn.t0),
      });
    this.superseded = Boolean(this.turn && !this.turn.textDone);
    this.turn = null;
    this.barge = null;
    this.act({ type: "interrupt" });
    this.listen();
  }

  /** Tap while listening: that's all I wanted to say. */
  finishNow() {
    if (this.state.phase === "listening" || this.state.phase === "user_speaking")
      void this.finishTurn();
  }

  toggleMute() {
    if (this.state.phase === "muted") {
      this.act({ type: "unmute" });
      this.listen();
    } else if (isHearing(this.state)) {
      this.stopTicker();
      this.dropSnapshot();
      this.mic?.discard();
      this.act({ type: "mute" });
    }
  }

  // ── Sleep, wake, visibility, network ───────────────────────────────────────

  /** Nobody is talking: stop capturing. The wake phrase (if available) or a tap wakes it. */
  sleep(reason: SleepReason) {
    if (this.state.phase === "idle" || this.state.phase === "offline") return;
    this.act({ type: "sleep", reason });
    this.afterSleep();
  }

  private afterSleep() {
    this.stopTicker();
    this.dropSnapshot();
    this.player?.stop();
    this.turn = null;
    this.barge = null;
    this.mic?.close();
    this.startWake();
  }

  private startWake() {
    const wake = this.deps.wake;
    if (
      !wake ||
      !this.prefs.wakeEnabled ||
      this.hidden ||
      this.state.phase !== "sleeping" ||
      (this.state.wake !== "ready" && this.state.wake !== "listening")
    )
      return;
    if (wake.running) return;
    wake.start({
      phrase: this.prefs.wakePhrase,
      language: this.prefs.language,
      onWake: (remainder) => void this.wakeUp(remainder),
      onError: (reason) =>
        this.act({
          type: "wake_status",
          status: reason === "unavailable" ? "unsupported" : "failed",
        }),
    });
    this.act({ type: "wake_status", status: "listening" });
  }

  /** The wake phrase was heard: listen — or, if more was said ("Elise, Morning Brief"), go. */
  async wakeUp(remainder = "") {
    if (this.state.phase !== "sleeping") return;
    this.deps.wake?.stop();
    this.t0 = this.now;
    this.marks = { wake: 0 };
    this.player?.chime?.();
    this.act({ type: "wake_status", status: "ready" });
    this.act({ type: "wake" });
    await this.openMic();
    const text = remainder.trim();
    if (text && isHearing(this.state)) {
      this.stopTicker();
      this.mic?.discard();
      this.act({ type: "speech_start" });
      this.act({ type: "speech_end" });
      this.act({ type: "transcript", text });
      this.beginTurn(text, this.prefs.language, 0);
    }
  }

  /** The page was hidden or shown: never listen in the background, say so when back. */
  visibility(hidden: boolean) {
    this.hidden = hidden;
    if (hidden) {
      this.deps.wake?.stop();
      if (
        this.state.phase !== "idle" &&
        this.state.phase !== "sleeping" &&
        this.state.phase !== "offline"
      )
        this.sleep("hidden");
      else if (this.state.wake === "listening") this.act({ type: "wake_status", status: "ready" });
    } else if (this.state.phase === "sleeping") this.startWake();
  }

  /** The network dropped or came back: never pretend to listen remotely. */
  network(online: boolean) {
    if (!online) {
      if (this.state.phase === "idle") return;
      this.stopTicker();
      this.dropSnapshot();
      this.player?.stop();
      this.turn = null;
      this.mic?.close();
      this.deps.wake?.stop();
      this.act({ type: "offline" });
    } else if (this.state.phase === "offline") {
      this.act({ type: "online" });
      this.startWake();
    }
  }

  /** Ends the session: the microphone is released at once, the wake engine stops. */
  end() {
    this.stopTicker();
    this.dropSnapshot();
    // A new session measures the room again (it may be another room, another device).
    this.calibrated = false;
    this.calibration = null;
    this.mic?.close();
    this.deps.wake?.stop();
    this.player?.stop();
    this.turn = null;
    this.barge = null;
    this.act({ type: "end" });
  }

  dispose() {
    this.end();
    this.player?.close();
    this.player = null;
    this.mic = null;
  }

  /** Real amplitude for the Orb: the microphone while hearing, ELISE while speaking. */
  level(): number {
    if (isHearing(this.state)) return this.mic?.level() ?? 0;
    if (this.state.phase === "speaking") return this.player?.level() ?? 0;
    return -1;
  }
}
