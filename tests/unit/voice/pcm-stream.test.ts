// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpeechPlayer } from "@/features/voice/speech-player";

/**
 * ELISE's speech output stream (ADR-108). The worklet is loaded as it ships (public/audio) with
 * the AudioWorklet globals faked: what goes in comes out sample for sample — no per-chunk
 * positioning or resampling — with short fades only where the audio starts, runs dry or is cut.
 */

type Msg = { type: string; samples?: Float32Array };
interface Processor {
  port: { onmessage: ((e: { data: Msg }) => void) | null; postMessage: (m: unknown) => void };
  process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

function loadWorklet() {
  const posted: { type: string }[] = [];
  let Ctor: (new () => Processor) | null = null;
  const scope = {
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (m: { type: string }) => posted.push(m) };
    },
    registerProcessor: (_name: string, c: new () => Processor) => (Ctor = c),
    currentFrame: 0,
  };
  const src = readFileSync(join(__dirname, "../../../public/audio/pcm-stream-worklet.js"), "utf8");
  new Function("AudioWorkletProcessor", "registerProcessor", "currentFrame", src)(
    scope.AudioWorkletProcessor,
    scope.registerProcessor,
    scope.currentFrame,
  );
  const p = new Ctor!();
  const push = (samples: Float32Array) => p.port.onmessage!({ data: { type: "push", samples } });
  const flush = () => p.port.onmessage!({ data: { type: "flush" } });
  const render = (blocks: number) => {
    const out: number[] = [];
    for (let b = 0; b < blocks; b++) {
      const block = new Float32Array(128);
      p.process([], [[block]]);
      out.push(...block);
    }
    return out;
  };
  return { push, flush, render, posted };
}

const signal = (n: number) =>
  Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i / 7) + 0.2 * Math.sin(i / 2.3));

describe("speech output stream (worklet)", () => {
  it("plays chunks of any size back to back, sample for sample (fades only at the edges)", () => {
    const w = loadWorklet();
    const x = signal(24_000);
    // Irregular chunks, pushed between render blocks, like the network delivers them.
    const sizes = [9600, 3301, 4999, 2048, 3333];
    let at = 0;
    const out: number[] = [];
    for (const n of sizes) {
      w.push(x.slice(at, at + n));
      at += n;
      out.push(...w.render(10));
    }
    out.push(...w.render(200));
    for (let i = 48; i < at - 48; i++) expect(out[i]).toBeCloseTo(x[i]!, 6);
    // Faded in from silence, and out at the very end: no click either way.
    expect(Math.abs(out[0]!)).toBeLessThan(Math.abs(x[0]!) + 1e-9);
    expect(Math.abs(out[at - 1]!)).toBeLessThan(0.05);
    expect(w.posted.map((m) => m.type)).toEqual(["start", "drained"]);
  });

  it("an underrun is a faded silence, and the audio fades back in", () => {
    const w = loadWorklet();
    w.push(Float32Array.from({ length: 500 }, () => 0.8));
    const first = w.render(8); // 1024 samples: runs dry at 500
    expect(Math.abs(first[499]!)).toBeLessThan(0.05);
    expect(first.slice(500).every((v) => v === 0)).toBe(true);
    w.push(Float32Array.from({ length: 500 }, () => 0.8));
    const again = w.render(1);
    expect(again[0]!).toBeLessThan(0.05);
    expect(again[60]!).toBeCloseTo(0.8, 5);
    expect(w.posted.map((m) => m.type)).toEqual(["start", "drained", "start"]);
  });

  it("a cut (barge-in) fades out over 5 ms and drops everything queued", () => {
    const w = loadWorklet();
    w.push(Float32Array.from({ length: 24_000 }, () => 0.8));
    w.render(4);
    w.flush();
    const out = w.render(4);
    expect(out[0]!).toBeLessThanOrEqual(0.80001);
    expect(out[119]!).toBeLessThan(0.01);
    expect(out.slice(120).every((v) => v === 0)).toBe(true);
    expect(w.posted.at(-1)).toEqual({ type: "flushed" });
  });
});

// ── The player on the stream ────────────────────────────────────────────────

const pushed: Msg[] = [];
const nodes: {
  name: string;
  port: { onmessage: ((e: { data: { type: string } }) => void) | null };
}[] = [];
const node = () => nodes.at(-1) ?? null;

class FakeStreamContext {
  currentTime = 0;
  sampleRate: number;
  state = "running";
  baseLatency = 0.01;
  outputLatency = 0.02;
  onstatechange: (() => void) | null = null;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48_000;
  }
  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} };
  }
  createGain() {
    return { connect() {}, gain: { setTargetAtTime() {} } };
  }
  createBuffer() {
    throw new Error("no buffer scheduling on the stream path");
  }
  async resume() {}
  async close() {}
}

class FakeWorkletNode {
  port = {
    onmessage: null as ((e: { data: { type: string } }) => void) | null,
    postMessage: (m: Msg) => pushed.push(m),
  };
  constructor(
    readonly ctx: unknown,
    readonly name: string,
  ) {
    nodes.push(this);
  }
  connect() {}
  disconnect() {}
}

function audioResponse(chunks: number[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n * 2));
      c.close();
    },
  });
  return new Response(body, { headers: { "x-audio-format": "pcm_s16le;rate=24000" } });
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("speech player on the stream (ADR-108)", () => {
  beforeEach(() => {
    pushed.length = 0;
    nodes.length = 0;
    vi.stubGlobal("AudioContext", FakeStreamContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => audioResponse([12_000, 4_000, 4_000])),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens one stream at the voice's rate and pushes every chunk to it, in order", async () => {
    const p = new SpeechPlayer();
    p.speak("Hola, te cuento.", "es");
    await settle();
    expect(node()?.name).toBe("pcm-stream");
    const samples = pushed.filter((m) => m.type === "push").map((m) => m.samples!.length);
    expect(samples.reduce((a, b) => a + b, 0)).toBe(20_000);
  });

  it("is idle only once the stream drained; a barge-in flushes it", async () => {
    const p = new SpeechPlayer();
    const idle = vi.fn();
    p.onIdle = idle;
    p.speak("Hola.", "es");
    await settle();
    expect(p.speaking).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    node()!.port.onmessage!({ data: { type: "drained" } });
    expect(idle).toHaveBeenCalled();
    expect(p.speaking).toBe(false);
    p.speak("Otra cosa.", "es");
    await settle();
    p.stop();
    expect(pushed.at(-1)).toEqual({ type: "flush" });
    expect(p.speaking).toBe(false);
  });
});
