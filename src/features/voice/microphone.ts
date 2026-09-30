"use client";

import { VOICE_LIMITS } from "@/core/voice/providers";

/**
 * Browser microphone for one voice session (ADR-014). Opened only by an explicit user action;
 * records one utterance at a time and ends it on sustained silence (energy-based end of turn).
 * The level it reports is the real input amplitude (the Orb reacts to it). Audio stays in
 * memory until it is uploaded for transcription, then it is dropped.
 */

export type MicProblem = "permission_denied" | "no_microphone" | "not_supported";

export interface Utterance {
  blob: Blob;
  durationMs: number;
  /** Speech was actually detected (silence isn't sent for transcription). */
  heardSpeech: boolean;
}

const TICK_MS = 50;
/** How long a pause ends the turn once the user has spoken. */
const END_SILENCE_MS = 900;
/** Minimum voiced time before a pause can end the turn. */
const MIN_SPEECH_MS = 250;
/** Nothing said for this long: the utterance ends empty. */
const NO_SPEECH_MS = 8_000;

function pickMimeType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"])
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  return "";
}

export class Microphone {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples = new Float32Array(2048);
  private startedAt = 0;
  private voicedMs = 0;
  private lastVoiceAt = 0;
  private floor = 0;
  private floorSamples = 0;
  private current = 0;
  private ended = false;
  onSpeechEnd: (() => void) | null = null;

  static supported(): boolean {
    return (
      typeof window !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined"
    );
  }

  /** Asks for the microphone (the browser prompts the first time). */
  async open(): Promise<void> {
    if (!Microphone.supported()) throw new MicError("not_supported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      throw new MicError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "permission_denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "no_microphone"
            : "not_supported",
      );
    }
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
  }

  get isOpen() {
    return this.stream !== null;
  }

  get recording() {
    return this.recorder?.state === "recording";
  }

  /** Starts one utterance; `onSpeechEnd` fires on the pause that ends it. */
  begin(): void {
    if (!this.stream || this.recording) return;
    const mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(250);
    this.startedAt = performance.now();
    this.voicedMs = 0;
    this.lastVoiceAt = 0;
    this.floor = 0;
    this.floorSamples = 0;
    this.ended = false;
    void this.ctx?.resume();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    const rms = Math.sqrt(sum / this.samples.length);
    const now = performance.now();
    const elapsed = now - this.startedAt;
    // The first moments calibrate the room's noise floor.
    if (elapsed < 400) {
      this.floor = (this.floor * this.floorSamples + rms) / ++this.floorSamples;
    }
    const threshold = Math.max(0.012, this.floor * 2.5);
    const voiced = elapsed >= 400 && rms > threshold;
    if (voiced) {
      this.voicedMs += TICK_MS;
      this.lastVoiceAt = now;
    }
    this.current = Math.min(1, rms * 9);
    const heard = this.voicedMs >= MIN_SPEECH_MS;
    const end =
      (heard && now - this.lastVoiceAt >= END_SILENCE_MS) ||
      (!heard && elapsed >= NO_SPEECH_MS) ||
      elapsed >= VOICE_LIMITS.maxUtteranceMs;
    if (end && !this.ended) {
      this.ended = true;
      this.onSpeechEnd?.();
    }
  }

  /** The live input level (0..1). */
  level(): number {
    return this.recording ? this.current : 0;
  }

  /** Ends the utterance and returns it (nothing is kept here afterwards). */
  finish(): Promise<Utterance> {
    const recorder = this.recorder;
    this.stopTimer();
    const durationMs = Math.round(performance.now() - this.startedAt);
    const heardSpeech = this.voicedMs >= MIN_SPEECH_MS;
    if (!recorder || recorder.state === "inactive")
      return Promise.resolve({ blob: new Blob(), durationMs: 0, heardSpeech: false });
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.chunks = [];
        this.recorder = null;
        resolve({ blob, durationMs, heardSpeech });
      };
      recorder.stop();
    });
  }

  /** Drops the current utterance without sending it (mute, interrupt, end). */
  discard(): void {
    this.stopTimer();
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
    this.current = 0;
  }

  /** Releases the microphone entirely: the browser's recording indicator turns off. */
  close(): void {
    this.discard();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class MicError extends Error {
  constructor(readonly problem: MicProblem) {
    super(problem);
  }
}
