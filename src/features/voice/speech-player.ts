"use client";

import type { VoiceLanguage } from "@/core/voice/providers";

/**
 * Plays ELISE's spoken reply segment by segment (16-bit PCM from /api/voice/speak, scheduled
 * on Web Audio). The next segment is requested while the current one plays and scheduled
 * back-to-back, so speech flows without silences between sentences; each request carries the
 * text said just before it, so the provider can continue the same intonation. The level is the
 * real output amplitude. `stop()` cuts at once and every late chunk of what was cut is dropped
 * (each reply has its own generation: audio from an older one is never scheduled).
 */

/** Per line: whether it may still be said, and a hook when its synthesis starts (telemetry). */
export interface SpeakOptions {
  valid?: () => boolean;
  onBegin?: () => void;
}

/** What playback measured for one segment (development diagnostics; no content). */
export interface SegmentStats {
  chars: number;
  /** Silence before this segment because its audio wasn't there yet (0 = seamless). */
  gapMs: number;
  /** Request → first audio byte. */
  firstAudioMs: number;
}

/** No audio for this long (first byte or between chunks): the segment is skipped. */
const STALL_MS = 8000;

interface Item extends SpeakOptions {
  text: string;
  language: VoiceLanguage | null;
}

interface Flight {
  item: Item;
  controller: AbortController;
  requestedAt: number;
  response: Promise<Response>;
}

export class SpeechPlayer {
  private ctx: AudioContext;
  private analyser: AnalyserNode;
  private queue: Item[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private flights = new Set<AbortController>();
  /** The next segment, already requested while the current one plays. */
  private ahead: Flight | null = null;
  /** What was last sent for synthesis in this reply (prosody continuity). */
  private said = "";
  private nextTime = 0;
  private working = false;
  private samples = new Float32Array(1024);
  private generation = 0;
  onStart: (() => void) | null = null;
  onIdle: (() => void) | null = null;
  onError: (() => void) | null = null;
  onSegment: ((s: SegmentStats) => void) | null = null;

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

  speak(text: string, language: VoiceLanguage | null, options: SpeakOptions = {}) {
    this.queue.push({ text, language, ...options });
    if (!this.working) void this.drain(this.generation);
    else this.prefetch();
  }

  /** Requests the next queued segment now, unless one is already on its way. */
  private prefetch() {
    if (this.ahead) return;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      // A line whose moment passed (progress after the results) is dropped, never said late.
      if (item.valid && !item.valid()) continue;
      this.ahead = this.request(item);
      return;
    }
  }

  private request(item: Item): Flight {
    item.onBegin?.();
    const controller = new AbortController();
    this.flights.add(controller);
    const previous = this.said;
    this.said = item.text;
    return {
      item,
      controller,
      requestedAt: performance.now(),
      response: fetch("/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: item.text,
          language: item.language,
          ...(previous ? { previous } : {}),
        }),
        signal: controller.signal,
      }),
    };
  }

  private async drain(generation: number) {
    this.working = true;
    await this.ctx.resume();
    for (;;) {
      if (generation !== this.generation) return;
      this.prefetch();
      const flight = this.ahead;
      if (!flight) break;
      this.ahead = null;
      try {
        await this.play(flight, generation);
      } catch (error) {
        // An interruption aborts quietly; a stalled or failed segment is reported and skipped.
        if (this.stalled || !(error instanceof DOMException && error.name === "AbortError"))
          this.onError?.();
      } finally {
        this.flights.delete(flight.controller);
      }
    }
    // A newer reply may already be playing after an interruption: leave its state alone.
    if (generation !== this.generation) return;
    this.working = false;
    this.said = "";
    // The next reply starts a fresh schedule: its first segment is not a "gap".
    this.nextTime = 0;
    this.idleWhenDone();
  }

  private stalled = false;

  private async play(flight: Flight, generation: number) {
    const { controller } = flight;
    // A segment whose audio stops arriving is skipped (its text is on screen) instead of
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
      const res = await flight.response;
      if (!res.ok || !res.body) throw new Error("speech failed");
      // While this one streams and plays, the next one is already being synthesized.
      this.prefetch();
      await this.stream(res, flight, generation, arm);
    } finally {
      clearTimeout(watchdog);
    }
  }

  private async stream(res: Response, flight: Flight, generation: number, arm: () => void) {
    const { controller, item } = flight;
    const rate = Number(/rate=(\d+)/.exec(res.headers.get("x-audio-format") ?? "")?.[1] ?? 24000);
    const reader = res.body!.getReader();
    let carry: Uint8Array | null = null;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let started = false;
    const flush = () => {
      if (!pendingBytes || generation !== this.generation) return;
      // Checked again when the audio arrives: it may have gone stale while synthesizing.
      if (!started && item.valid && !item.valid()) {
        controller.abort();
        return;
      }
      const bytes = new Uint8Array(pendingBytes);
      let o = 0;
      for (const p of pending) {
        bytes.set(p, o);
        o += p.length;
      }
      pending = [];
      pendingBytes = 0;
      const gap = this.schedule(bytes, rate);
      if (!started)
        this.onSegment?.({
          chars: item.text.length,
          gapMs: gap,
          firstAudioMs: Math.round(performance.now() - flight.requestedAt),
        });
      started = true;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (generation !== this.generation) return;
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

  /** Schedules PCM right after what is already queued; returns the silence it had to leave. */
  private schedule(bytes: Uint8Array, rate: number): number {
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const buffer = this.ctx.createBuffer(1, pcm.length, rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i]! / 32768;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const earliest = this.ctx.currentTime + 0.04;
    // The audio ran dry before this arrived: that silence is what the listener heard as a cut.
    const gapMs =
      this.nextTime > 0 && earliest > this.nextTime
        ? Math.round((earliest - this.nextTime) * 1000)
        : 0;
    const startAt = Math.max(this.nextTime, earliest);
    if (!this.sources.size && this.nextTime <= this.ctx.currentTime) this.onStart?.();
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      this.idleWhenDone();
    };
    return gapMs;
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
    // A new generation: chunks of anything requested before are never scheduled.
    this.generation++;
    this.queue = [];
    this.ahead = null;
    this.said = "";
    for (const c of this.flights) c.abort();
    this.flights.clear();
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
