"use client";

/**
 * Browser microphone for one voice session (ADR-014, ADR-017). Opened only after the user
 * started the session; capture only — it decides nothing. The controller reads the input
 * level every tick (turn taking, barge-in) and asks for the audio of one utterance. A
 * snapshot is the audio so far, for a speculative transcription, without stopping. Audio stays
 * in memory until it is uploaded for transcription, then it is dropped.
 */

export type MicProblem = "permission_denied" | "no_microphone" | "not_supported";

export interface Utterance {
  blob: Blob;
  durationMs: number;
}

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
  private samples = new Float32Array(2048);
  private startedAt = 0;

  static supported(): boolean {
    return (
      typeof window !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined"
    );
  }

  /** Asks for the microphone (the browser prompts only the first time). */
  async open(): Promise<void> {
    if (this.stream) return;
    if (!Microphone.supported()) throw new MicError("not_supported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // The browser's echo cancellation keeps ELISE's own voice out of the input.
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
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
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

  /** Starts recording one utterance. */
  begin(): void {
    if (!this.stream || this.recording) return;
    const mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    // Small timeslices make snapshots fresh (a snapshot is the chunks so far).
    this.recorder.start(200);
    this.startedAt = performance.now();
    void this.ctx?.resume();
  }

  /** The audio recorded so far, without stopping (null when there's nothing yet). */
  snapshot(): Blob | null {
    if (!this.recorder || !this.chunks.length) return null;
    return new Blob(this.chunks, { type: this.recorder.mimeType || "audio/webm" });
  }

  /** The raw input RMS (0..~0.5), read by the controller every tick. */
  rms(): number {
    if (!this.analyser || !this.stream) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.sqrt(sum / this.samples.length);
  }

  /** The level shown by the Orb (0..1). */
  level(): number {
    return Math.min(1, this.rms() * 9);
  }

  /** Ends the utterance and returns it (nothing is kept here afterwards). */
  finish(): Promise<Utterance> {
    const recorder = this.recorder;
    const durationMs = Math.round(performance.now() - this.startedAt);
    if (!recorder || recorder.state === "inactive")
      return Promise.resolve({ blob: new Blob(), durationMs: 0 });
    return new Promise((resolve) => {
      recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.chunks = [];
        this.recorder = null;
        resolve({ blob, durationMs });
      };
      recorder.stop();
    });
  }

  /** Drops the current utterance without sending it (mute, interrupt, a reply that ended). */
  discard(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
  }

  /** Releases the microphone entirely: the browser's recording indicator turns off. */
  close(): void {
    this.discard();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    // The audio context is kept (suspended) so waking later needs no new user gesture.
    void this.ctx?.suspend();
  }

  dispose(): void {
    this.close();
    void this.ctx?.close();
    this.ctx = null;
  }
}

export class MicError extends Error {
  constructor(readonly problem: MicProblem) {
    super(problem);
  }
}
