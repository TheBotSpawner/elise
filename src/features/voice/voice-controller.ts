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
import { SentenceChunker } from "@/core/voice/speech-text";
import {
  BargeInDetector,
  calibrateFloor,
  isSelfEcho,
  looksUnfinished,
  TurnDetector,
  VOICE_TURN,
} from "@/core/voice/turn";
import type { WakePhrase } from "@/core/voice/wake";

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
  speak(text: string, language: VoiceLanguage | null): void;
  stop(): void;
  close(): void;
  rms(): number;
  level(): number;
  chime?(): void;
  readonly speaking: boolean;
  onStart: (() => void) | null;
  onIdle: (() => void) | null;
  onError: (() => void) | null;
}

export type Transcriber = (
  audio: Blob,
  onPartial: (text: string) => void,
  signal: AbortSignal,
) => Promise<{ text: string; language: VoiceLanguage | null } | null>;

export type StreamEvent =
  | { type: "conversation" }
  | { type: "tool_started" }
  | { type: "tool_finished"; outcome?: { status: string } }
  | { type: "workspace" }
  | { type: "text"; delta: string }
  | { type: "spoken"; delta: string }
  | { type: "finished"; failed: boolean }
  | { type: string };

export type VoiceMarks = Partial<
  Record<
    | "wake"
    | "listening"
    | "speechStart"
    | "speechEnd"
    | "turnDetected"
    | "transcriptFinal"
    | "speculative"
    | "runtimeStart"
    | "firstTool"
    | "firstSurface"
    | "firstText"
    | "audioStart"
    | "bargeIn"
    | "audioStopped"
    | "turnComplete",
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
}

interface Snapshot {
  version: number;
  abort: AbortController;
  promise: Promise<{ text: string; language: VoiceLanguage | null } | null>;
}

/** Fired when voice preferences change without a reload (Settings, or ELISE herself). */
export const VOICE_PREFS_EVENT = "elise:voice-prefs";

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
  private lastSpoken = "";
  private hidden = false;
  private finishing = false;

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
          this.detector?.unfinished(looksUnfinished(r.text));
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
    this.detector?.unfinished(false);
  }

  /** The turn is over: the speculative transcript if nothing was said since, else a new one. */
  private async finishTurn() {
    const mic = this.mic;
    if (!mic || !isHearing(this.state)) return;
    const capture = this.capture;
    this.finishing = true;
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
    this.act({ type: "transcript", text });
    if (!text) {
      if ((this.state.phase as VoicePhase) === "sleeping") this.afterSleep();
      else this.listen();
      return;
    }
    this.stopTicker();
    this.lastActivity = this.now;
    this.beginTurn(text, result.language, utterance.durationMs);
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
    };
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
    const since = () => Math.round(this.now - turn.t0);
    switch (event.type) {
      case "conversation":
        turn.marks.runtimeStart ??= since();
        break;
      case "tool_started":
        turn.marks.firstTool ??= since();
        this.act({ type: "tool_started" });
        break;
      case "tool_finished":
        if ((event as { outcome?: { status: string } }).outcome?.status === "approval_required")
          turn.awaitingApproval = true;
        this.act({ type: "tool_finished" });
        break;
      case "workspace":
        turn.marks.firstSurface ??= since();
        break;
      case "spoken":
        if ("delta" in event) {
          turn.marks.firstText ??= since();
          turn.spokenChunker ??= new SentenceChunker();
          for (const sentence of turn.spokenChunker.push(event.delta)) this.say(turn, sentence);
        }
        break;
      case "text":
        // Fallback for a reply without a spoken part: speak the answer itself, capped.
        if ("delta" in event && !turn.spokenChunker) {
          turn.marks.firstText ??= since();
          for (const sentence of turn.chunker.push(event.delta)) this.say(turn, sentence);
        }
        break;
      case "finished":
        for (const sentence of (turn.spokenChunker ?? turn.chunker).flush())
          this.say(turn, sentence);
        turn.textDone = true;
        if (!this.player?.speaking) this.complete();
        break;
    }
  }

  private say(turn: SpokenTurn, sentence: string) {
    if (turn.capped || !this.player) return;
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
