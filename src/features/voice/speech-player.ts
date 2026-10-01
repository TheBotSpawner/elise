"use client";

import type { VoiceLanguage } from "@/core/voice/providers";

/**
 * Plays ELISE's spoken reply sentence by sentence, starting each as its audio streams in
 * (16-bit PCM from /api/voice/speak, scheduled on Web Audio). The level is the real output
 * amplitude, so the Orb moves with what ELISE is actually saying. `stop()` cuts it at once.
 */
/** No audio for this long (first byte or between chunks): the sentence is skipped. */
const STALL_MS = 8000;

export class SpeechPlayer {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private queue: { text: string; language: VoiceLanguage | null }[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private controller: AbortController | null = null;
  private nextTime = 0;
  private working = false;
  private samples = new Float32Array(1024);
  private generation = 0;
  onStart: (() => void) | null = null;
  onIdle: (() => void) | null = null;
  onError: (() => void) | null = null;

  /** Create from a user gesture (tapping the microphone), so the browser allows playback. */
  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
  }

  get speaking(): boolean {
    return this.working || this.sources.size > 0;
  }

  speak(text: string, language: VoiceLanguage | null) {
    this.queue.push({ text, language });
    if (!this.working) void this.drain(this.generation);
  }

  private async drain(generation: number) {
    this.working = true;
    await this.ctx.resume();
    while (this.queue.length && generation === this.generation) {
      const next = this.queue.shift()!;
      try {
        await this.play(next.text, next.language, generation);
      } catch (error) {
        // An interruption aborts quietly; a stalled or failed sentence is reported and skipped.
        if (this.stalled || !(error instanceof DOMException && error.name === "AbortError"))
          this.onError?.();
      }
    }
    // A newer reply may already be playing after an interruption: leave its state alone.
    if (generation !== this.generation) return;
    this.working = false;
    this.idleWhenDone();
  }

  private stalled = false;

  private async play(text: string, language: VoiceLanguage | null, generation: number) {
    const controller = (this.controller = new AbortController());
    // A sentence whose audio stops arriving is skipped (its text is on screen) instead of
    // leaving ELISE "speaking" forever.
    this.stalled = false;
    let watchdog = 0;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        this.stalled = true;
        controller.abort();
      }, STALL_MS);
    };
    arm();
    try {
      await this.stream(text, language, generation, controller, arm);
    } finally {
      clearTimeout(watchdog);
    }
  }

  private async stream(
    text: string,
    language: VoiceLanguage | null,
    generation: number,
    controller: AbortController,
    arm: () => void,
  ) {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, language }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error("speech failed");
    const rate = Number(/rate=(\d+)/.exec(res.headers.get("x-audio-format") ?? "")?.[1] ?? 24000);
    const reader = res.body.getReader();
    let carry: Uint8Array | null = null;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
      if (!pendingBytes || generation !== this.generation) return;
      const bytes = new Uint8Array(pendingBytes);
      let o = 0;
      for (const p of pending) {
        bytes.set(p, o);
        o += p.length;
      }
      pending = [];
      pendingBytes = 0;
      this.schedule(bytes, rate);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      let chunk = value;
      if (carry) {
        const joined = new Uint8Array(carry.length + chunk.length);
        joined.set(carry);
        joined.set(chunk, carry.length);
        chunk = joined;
        carry = null;
      }
      // Samples are 2 bytes: keep an odd trailing byte for the next chunk.
      if (chunk.length % 2) {
        carry = chunk.slice(chunk.length - 1);
        chunk = chunk.slice(0, chunk.length - 1);
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
      // ~150 ms per buffer: smooth scheduling without delaying the start.
      if (pendingBytes >= rate * 0.3) flush();
    }
    flush();
  }

  private schedule(bytes: Uint8Array, rate: number) {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const buffer = this.ctx.createBuffer(1, pcm.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const startAt = Math.max(this.nextTime, this.ctx.currentTime + 0.04);
    if (!this.sources.size && this.nextTime <= this.ctx.currentTime) this.onStart?.();
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.idleWhenDone();
    };
  }

  private idleWhenDone() {
    if (!this.working && !this.sources.size && !this.queue.length) this.onIdle?.();
  }

  /** The raw output RMS: what ELISE is putting into the speakers right now (barge-in). */
  rms(): number {
    if (!this.sources.size) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.sqrt(sum / this.samples.length);
  }

  /** The live output level (0..1). */
  level(): number {
    return Math.min(1, this.rms() * 5);
  }

  /** A very short, quiet tone when the wake phrase is heard (no "Yes?" every time). */
  chime() {
    void this.ctx.resume();
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const t = this.ctx.currentTime;
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Stops speaking now (interruption); whatever was generated stays on screen. */
  stop() {
    this.generation++;
    this.queue = [];
    this.controller?.abort();
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.working = false;
  }

  close() {
    this.stop();
    void this.ctx.close();
  }
}
