import {
  EndOfSpeech,
  type DetectorState,
  type WakeCapture,
  type WakeDetector,
  wakeGrammar,
} from "@/core/voice/wake-detector";

import { VoskWorker, type VoskRecognizer } from "./vosk-worker-client";

/**
 * "ELISE" on this computer (ADR-095): Vosk (Kaldi, WebAssembly in a worker) restricted to a
 * two-entry grammar — the word, or anything else — over the microphone, in this app's renderer.
 * Nothing leaves the device while it listens: the audio stays in an 8 s ring in memory, and
 * only after the word does the capture — from the word's own start (its time from the
 * recognizer) to the end of what followed — go to the existing voice pipeline. "ELISE, ¿qué
 * tengo mañana?" said in one breath keeps every word, even when the recognizer only confirms the
 * word at the end of the sentence. The microphone is released whenever it stops.
 */

const RATE = 16_000;
const FRAME = 2048; // 128 ms
const RING_FRAMES = 63; // ~8 s, in memory only
const PREROLL_FRAMES = 13; // ~1.6 s before a word confirmed without a time
/** Voiced frames beyond the word alone ("ELISE" ≈ 4 frames): something more was said. */
const MORE_THAN_THE_WORD = 7;
/**
 * The recognizer only decodes when the room has something like speech: a quiet room costs
 * almost nothing. It gets the half second before (no word loses its start) and keeps going a
 * little after, so a pause inside a sentence doesn't cut it.
 */
const GATE_LEAD_FRAMES = 4; // ~0.5 s
const GATE_HANGOVER_FRAMES = 10; // ~1.3 s
/** After a detection, the same words can't fire again. */
const REFRACTORY_MS = 1500;

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

export class VoskWakeDetector implements WakeDetector {
  state: DetectorState = "stopped";
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private rec: VoskRecognizer | null = null;
  /** `start`: where the frame sits in what the recognizer heard (-1: not fed, silence). */
  private ring: { start: number; data: Float32Array }[] = [];
  private fed = 0;
  private gate = 0;
  private pre: Float32Array[] = [];
  private post: Float32Array[] | null = null;
  private end = new EndOfSpeech();
  private lastDetection = 0;
  private generation = 0;
  /** Kept for resuming after a hold: the model and the callbacks of the running start(). */
  private resumeWith: { m: VoskWorker; opts: Parameters<WakeDetector["start"]>[0] } | null = null;

  async start(opts: Parameters<WakeDetector["start"]>[0]) {
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
      // Echo cancellation keeps ELISE's own voice (and the chime) out of what it hears.
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
    this.ctx = new AudioContext({ sampleRate: RATE });
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is enough here (and runs with the window hidden); 128 ms frames.
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1);
    this.rec = this.recognizer(m, opts);
    this.resumeWith = { m, opts };
    this.node.onaudioprocess = (e) =>
      this.frame(new Float32Array(e.inputBuffer.getChannelData(0)), opts);
    source.connect(this.node);
    // A ScriptProcessor only runs while connected to the output; it writes silence.
    this.node.connect(this.ctx.destination);
    // A microphone unplugged mid-way: say so (the coordinator retries later).
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      this.release();
      set("no_microphone");
    });
    set("listening");
  }

  private failedMic() {
    return this.state === "no_microphone" || this.state === "mic_denied";
  }

  private recognizer(m: VoskWorker, opts: Parameters<WakeDetector["start"]>[0]) {
    const heard = (text: string) => text.split(/\s+/).some((w) => opts.model.tokens.includes(w));
    // A partial result is the fastest sign; the refractory time keeps one utterance one wake.
    this.fed = 0;
    return m.recognizer(RATE, wakeGrammar(opts.model), {
      onPartial: (partial) => heard(partial) && this.detected(opts, null),
      onResult: (text, words) => {
        if (!heard(text)) return;
        const w = words.find((x) => opts.model.tokens.includes(x.word));
        this.detected(opts, w ? w.start : null);
      },
    });
  }

  /** `wordStart`: the word's time from the recognizer, when it gave one. */
  private detected(opts: Parameters<WakeDetector["start"]>[0], wordStart: number | null) {
    const now = Date.now();
    if (this.post || now - this.lastDetection < REFRACTORY_MS) return;
    this.lastDetection = now;
    // From a quarter second before the word (or the last moments, without a time).
    const from = wordStart === null ? null : Math.max(0, (wordStart - 0.25) * RATE);
    this.pre = (
      from === null
        ? this.ring.slice(-PREROLL_FRAMES)
        : this.ring.slice(
            Math.max(
              0,
              this.ring.findIndex((f) => f.start >= 0 && f.start + f.data.length > from),
            ),
          )
    ).map((f) => f.data);
    this.post = [];
    this.end.reset();
    this.state = "capturing";
    opts.onState("capturing");
    opts.onDetected();
  }

  private frame(x: Float32Array, opts: Parameters<WakeDetector["start"]>[0]) {
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
    const entry = { start: -1, data: x };
    this.ring.push(entry);
    if (this.ring.length > RING_FRAMES) this.ring.shift();
    if (this.end.speech(energy)) {
      // Opening: the moments just before go first, so the word keeps its start.
      if (this.gate === 0)
        for (const f of this.ring.slice(-1 - GATE_LEAD_FRAMES, -1)) if (f.start < 0) this.feed(f);
      this.gate = GATE_HANGOVER_FRAMES;
    } else if (this.gate > 0) this.gate--;
    if (this.gate > 0) this.feed(entry);
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
    this.node?.disconnect();
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
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
