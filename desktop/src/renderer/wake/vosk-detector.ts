import { DUCK_FACTOR } from "@/core/voice/delivery";
import { StreamResampler } from "@/core/voice/resample";
import { WakeArbiter, type WakeDecision } from "@/core/voice/wake-arbiter";
import {
  EndOfSpeech,
  wakeGate,
  type DetectorState,
  type WakeCapture,
  type WakeDetector,
  wakeGrammar,
} from "@/core/voice/wake-detector";
import { logSound } from "@/features/voice/sound-log";

import { VoskWorker, type VoskRecognizer } from "./vosk-worker-client";

/**
 * "ELISE" on this computer (ADR-095, ADR-108): Vosk (Kaldi, WebAssembly in a worker) restricted
 * to the word and its competitors, over the microphone, in this app's renderer. Nothing leaves
 * the device while it listens: the audio stays in an 8 s ring in memory, and only after the word
 * does the capture — from the word's own start to the end of what followed — go to the existing
 * voice pipeline. "ELISE, ¿qué tengo mañana?" said in one breath keeps every word.
 *
 * ADR-108:
 * - The microphone is read without an AudioContext of its own when the platform allows it
 *   (MediaStreamTrackProcessor): no extra output stream at an odd rate next to ELISE's voice,
 *   and no frames lost while the page is busy. Its native rate is converted to 16 kHz here.
 * - A quieter energy gate lets a voice from across the room reach the recognizer.
 * - The recognizer's hints go through a WakeArbiter: a candidate becomes an activation only if
 *   the word opens what is said and is stable or confident (see wake-arbiter.ts).
 * - A change of audio device restarts listening on the new default device.
 * - Diagnostics (levels, device, candidates and why they were accepted or not) go to the local
 *   voice diagnostics log — memory only, no words, no audio.
 */

const RATE = 16_000;
const FRAME = 2048; // 128 ms
const RING_FRAMES = 63; // ~8 s, in memory only
/** Over ELISE's reply: a word confirmed without a time is captured from this far back (~1.4 s). */
const OVER_REPLY_FRAMES = 11;
/** Voiced frames beyond the word alone ("ELISE" ≈ 4 frames): something more was said. */
const MORE_THAN_THE_WORD = 7;
/**
 * The recognizer decodes when the room has something like speech: it gets the half second
 * before (no word loses its start) and keeps going a little after.
 */
const GATE_LEAD_FRAMES = 4; // ~0.5 s
const GATE_HANGOVER_FRAMES = 10; // ~1.3 s
/** A level summary in the diagnostics log this often while listening. */
const LEVEL_EVERY_FRAMES = 16; // ~2 s
/** A device change settles for this long before listening restarts. */
const DEVICE_SETTLE_MS = 1500;

let model: VoskWorker | null = null;

/** One recognizer worker per app, loaded once; a failed load is retried next time. */
async function loadModel(file: string): Promise<VoskWorker> {
  // The worker fetches it: an absolute URL on the app's own origin (served from the install).
  model ??= new VoskWorker(`${window.location.origin}/__wake/${file}`);
  try {
    await model.ready;
    return model;
  } catch (e) {
    model.terminate();
    model = null;
    throw e;
  }
}

const rms = (x: Float32Array) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / x.length);
};
const dbfs = (v: number) => (v > 0 ? Math.round(20 * Math.log10(v)) : -120);

/** A short, non-reversible label for a device id (diagnostics never keep the id itself). */
async function redact(id: string | undefined): Promise<string> {
  if (!id) return "default";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest).slice(0, 3)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Chromium's MediaStreamTrackProcessor for audio (not in every lib.dom version). */
interface AudioDataLike {
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  copyTo(dest: Float32Array, opts: { planeIndex: number; format: "f32-planar" }): void;
  close(): void;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => {
  readable: ReadableStream<AudioDataLike>;
};

type StartOptions = Parameters<WakeDetector["start"]>[0];

export class VoskWakeDetector implements WakeDetector {
  state: DetectorState = "stopped";
  private stream: MediaStream | null = null;
  /** Only when the platform has no track processor: a context at the device's own rate. */
  private ctx: AudioContext | null = null;
  private reader: ReadableStreamDefaultReader<AudioDataLike> | null = null;
  private resampler: StreamResampler | null = null;
  private pending = new Float32Array(0);
  private rec: VoskRecognizer | null = null;
  /** `start`: where the frame sits in what the recognizer heard (-1: not fed, silence). */
  private ring: { start: number; data: Float32Array }[] = [];
  private fed = 0;
  /**
   * Where what is being said began (in what the recognizer heard): a final result ends one
   * utterance, the next begins after it. A word confirmed from a partial (no time yet) is
   * captured from here, so a confirmation that waited a moment never cuts the request's start.
   */
  private utteranceFrom = 0;
  private gate = 0;
  private pre: Float32Array[] = [];
  private post: Float32Array[] | null = null;
  private end = new EndOfSpeech();
  private arbiter: WakeArbiter | null = null;
  private candidate = 0;
  private generation = 0;
  private stats = { frames: 0, sum: 0, peak: 0, clipped: 0, gated: 0 };
  private onDeviceChange: (() => void) | null = null;
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Kept for resuming after a hold: the model and the callbacks of the running start(). */
  private resumeWith: { m: VoskWorker; opts: StartOptions } | null = null;
  /** The decision for the capture in progress (the coordinator asks for it). */
  lastDecision: Extract<WakeDecision, { accept: true }> | null = null;

  async start(opts: StartOptions) {
    if (this.state === "held" && this.resumeWith) return this.resume();
    if (this.state !== "stopped" && this.state !== "model_failed" && !this.failedMic()) return;
    const gen = ++this.generation;
    const set = (s: DetectorState) => {
      if (gen !== this.generation) return;
      this.state = s;
      opts.onState(s);
    };
    set("loading");
    let m: VoskWorker;
    try {
      m = await loadModel(opts.model.file);
    } catch {
      return set("model_failed");
    }
    if (gen !== this.generation) return;
    try {
      // Echo cancellation keeps ELISE's own voice (and the chime) out of what it hears; noise
      // suppression and gain control even out a voice from across the room.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (e) {
      const name = (e as DOMException).name;
      return set(
        name === "NotAllowedError" || name === "SecurityError" ? "mic_denied" : "no_microphone",
      );
    }
    if (gen !== this.generation) return this.release();
    const track = this.stream.getAudioTracks()[0]!;
    this.arbiter ??= new WakeArbiter(opts.model.tokens);
    this.rec = this.recognizer(m, opts);
    this.resumeWith = { m, opts };
    const settings = track.getSettings();
    const Processor = (window as { MediaStreamTrackProcessor?: TrackProcessorCtor })
      .MediaStreamTrackProcessor;
    if (Processor) {
      // Frames queue (never dropped while the page is busy); no audio output is opened.
      const { readable } = new Processor({ track, maxBufferSize: 200 });
      this.reader = readable.getReader();
      void this.pump(this.reader, gen, opts);
    } else {
      // Fallback: a context at the device's own rate, its output silenced explicitly.
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaStreamSource(this.stream);
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.resampler = new StreamResampler(this.ctx.sampleRate, RATE);
      node.onaudioprocess = (e) => this.input(e.inputBuffer.getChannelData(0), opts);
      source.connect(node);
      node.connect(mute);
      mute.connect(this.ctx.destination);
    }
    // A microphone unplugged mid-way: say so (the coordinator retries later).
    track.addEventListener("ended", () => {
      logSound("wake:device", "ended");
      this.release();
      set("no_microphone");
    });
    this.watchDevices(opts);
    logSound(
      "wake:device",
      `start device=${await redact(settings.deviceId)} rate=${settings.sampleRate ?? "?"} ` +
        `channels=${settings.channelCount ?? "?"} aec=${settings.echoCancellation ?? "?"} ` +
        `ns=${settings.noiseSuppression ?? "?"} agc=${settings.autoGainControl ?? "?"} ` +
        `path=${Processor ? "track" : "context"}`,
    );
    set("listening");
  }

  private async pump(
    reader: ReadableStreamDefaultReader<AudioDataLike>,
    gen: number,
    opts: StartOptions,
  ) {
    let scratch = new Float32Array(0);
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value || gen !== this.generation) {
        value?.close();
        return;
      }
      if (!this.resampler || this.resampler.from !== value.sampleRate)
        this.resampler = new StreamResampler(value.sampleRate, RATE);
      if (scratch.length !== value.numberOfFrames) scratch = new Float32Array(value.numberOfFrames);
      value.copyTo(scratch, { planeIndex: 0, format: "f32-planar" });
      value.close();
      this.input(scratch, opts);
    }
  }

  /** Native-rate samples in; 128 ms frames at 16 kHz out to the detector. */
  private input(native: Float32Array, opts: StartOptions) {
    const x = this.resampler!.push(native);
    const all = new Float32Array(this.pending.length + x.length);
    all.set(this.pending);
    all.set(x, this.pending.length);
    let at = 0;
    for (; at + FRAME <= all.length; at += FRAME) this.frame(all.slice(at, at + FRAME), opts);
    this.pending = all.slice(at);
  }

  /** A device plugged or unplugged: listen again on the (new) default device. */
  private watchDevices(opts: StartOptions) {
    if (this.onDeviceChange) return;
    this.onDeviceChange = () => {
      if (this.deviceTimer) clearTimeout(this.deviceTimer);
      this.deviceTimer = setTimeout(() => {
        // Never in the middle of a capture or a conversation: those finish first.
        if (this.state !== "listening") return;
        logSound("wake:device", "changed, restarting");
        this.release();
        this.state = "stopped";
        void this.start(opts);
      }, DEVICE_SETTLE_MS);
    };
    navigator.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
  }

  private failedMic() {
    return this.state === "no_microphone" || this.state === "mic_denied";
  }

  private recognizer(m: VoskWorker, opts: StartOptions) {
    this.fed = 0;
    this.utteranceFrom = 0;
    const decide = (d: WakeDecision | null) => {
      if (!d || this.post) return;
      const id = `c${++this.candidate}`;
      if (!d.accept) {
        logSound("wake:candidate", `${id} rejected ${d.reason}`);
        return;
      }
      logSound(
        "wake:candidate",
        `${id} accepted ${d.source}${d.confidence !== null ? ` conf=${d.confidence.toFixed(2)}` : ""}${d.guarded ? " guarded" : ""}`,
      );
      this.detected(opts, d);
    };
    const music = () => Boolean(opts.listenThrough?.());
    return m.recognizer(RATE, wakeGrammar(opts.model), {
      onPartial: (partial) =>
        decide(
          this.arbiter!.signal(
            { kind: "partial", text: partial, at: performance.now() },
            { music: music() },
          ),
        ),
      onResult: (text, words) => {
        // Whatever this result decides, the next utterance starts after what was heard so far.
        queueMicrotask(() => (this.utteranceFrom = this.fed));
        decide(
          this.arbiter!.signal(
            { kind: "final", text, words, at: performance.now() },
            { music: music() },
          ),
        );
      },
    });
  }

  private detected(opts: StartOptions, d: Extract<WakeDecision, { accept: true }>) {
    this.lastDecision = d;
    // From a quarter second before the word, or (without its time) from where the utterance
    // began — including the gate's lead — so nothing said with the word is lost.
    const from =
      d.wordStart === null ? this.utteranceFrom : Math.max(0, (d.wordStart - 0.25) * RATE);
    const first = this.ring.findIndex((f) => f.start >= 0 && f.start + f.data.length > from);
    const pre = this.ring.slice(Math.max(0, first));
    // ADR-109: over her reply, "the utterance" began with her own voice: only the moments just
    // before the word.
    this.pre = (
      d.wordStart === null && opts.overReply?.() ? pre.slice(-OVER_REPLY_FRAMES) : pre
    ).map((f) => f.data);
    this.post = [];
    this.end.reset();
    // The music is lowered as the word is heard: what follows is measured against that room.
    if (opts.listenThrough?.()) this.end.scaleFloor(DUCK_FACTOR.normal);
    this.state = "capturing";
    opts.onState("capturing");
    opts.onDetected(d);
  }

  /** The coordinator's verdict on the last capture (from its transcription). */
  outcome(kind: "confirmed" | "rejected") {
    if (kind === "confirmed") this.arbiter?.confirmed();
    else this.arbiter?.rejected(performance.now());
    logSound("wake:outcome", kind);
  }

  private frame(x: Float32Array, opts: StartOptions) {
    if (this.state === "held") return;
    const energy = rms(x);
    if (this.post) {
      this.post.push(x);
      if (!this.end.push(energy)) return;
      const all = [...this.pre, ...this.post];
      const voiced = all.filter((f) => this.end.speech(rms(f))).length;
      const capture: WakeCapture = {
        audio: concat(all),
        sampleRate: RATE,
        speechAfter: this.end.speechAfter || voiced >= MORE_THAN_THE_WORD,
      };
      this.post = null;
      this.pre = [];
      this.ring = [];
      this.state = "listening";
      opts.onState("listening");
      opts.onCaptured(capture);
      return;
    }
    // Listening: the ring keeps the last moments, in memory only; the recognizer hears speech.
    this.end.learn(energy);
    this.summarize(x, energy);
    const entry = { start: -1, data: x };
    this.ring.push(entry);
    if (this.ring.length > RING_FRAMES) this.ring.shift();
    // With ELISE's music playing, the gate stays open: music sets the room's loudness (ADR-104).
    if (wakeGate(energy, this.end.roomFloor) || opts.listenThrough?.()) {
      // Opening: the moments just before go first, so the word keeps its start.
      if (this.gate === 0)
        for (const f of this.ring.slice(-1 - GATE_LEAD_FRAMES, -1)) if (f.start < 0) this.feed(f);
      this.gate = GATE_HANGOVER_FRAMES;
    } else if (this.gate > 0) this.gate--;
    if (this.gate > 0) this.feed(entry);
  }

  /** Levels for the diagnostics log: never the audio, only how loud and how often clipped. */
  private summarize(x: Float32Array, energy: number) {
    const s = this.stats;
    s.frames++;
    s.sum += energy * energy;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      if (a > s.peak) s.peak = a;
      if (a >= 0.98) s.clipped++;
    }
    if (this.gate > 0) s.gated++;
    if (s.frames < LEVEL_EVERY_FRAMES) return;
    logSound(
      "wake:level",
      `rms=${dbfs(Math.sqrt(s.sum / s.frames))}dB peak=${dbfs(s.peak)}dB floor=${dbfs(this.end.roomFloor)}dB ` +
        `clipped=${s.clipped} decoding=${Math.round((s.gated / s.frames) * 100)}%`,
    );
    this.stats = { frames: 0, sum: 0, peak: 0, clipped: 0, gated: 0 };
  }

  private feed(f: { start: number; data: Float32Array }) {
    f.start = this.fed;
    this.fed += f.data.length;
    try {
      this.rec?.accept(f.data, RATE);
    } catch {
      // A dropped frame is harmless.
    }
  }

  private release() {
    void this.reader?.cancel().catch(() => undefined);
    this.reader = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.resampler = null;
    this.pending = new Float32Array(0);
    try {
      this.rec?.remove();
    } catch {
      // Already gone.
    }
    this.rec = null;
    this.gate = 0;
    this.ring = [];
    this.pre = [];
    this.post = null;
  }

  stop() {
    this.generation++;
    this.release();
    if (this.onDeviceChange)
      navigator.mediaDevices.removeEventListener?.("devicechange", this.onDeviceChange);
    this.onDeviceChange = null;
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.resumeWith = null;
    this.state = "stopped";
  }

  hold() {
    if (this.state !== "listening" && this.state !== "capturing") return;
    this.state = "held";
    this.post = null;
    this.pre = [];
    this.ring = [];
    this.gate = 0;
  }

  /** After a conversation: a fresh recognizer (nothing half-heard carries over). */
  private resume() {
    const { m, opts } = this.resumeWith!;
    try {
      this.rec?.remove();
    } catch {
      // Already gone.
    }
    this.arbiter?.reset();
    this.rec = this.recognizer(m, opts);
    this.state = "listening";
    opts.onState("listening");
  }
}

function concat(parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 16-bit PCM WAV of a capture: what the existing transcription endpoint accepts. */
export function wav(audio: Float32Array, sampleRate: number): Blob {
  const data = new DataView(new ArrayBuffer(44 + audio.length * 2));
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  data.setUint32(4, 36 + audio.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  str(36, "data");
  data.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++)
    data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, audio[i]!)) * 0x7fff, true);
  return new Blob([data.buffer], { type: "audio/wav" });
}
