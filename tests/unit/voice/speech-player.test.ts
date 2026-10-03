// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpeechPlayer } from "@/features/voice/speech-player";

/**
 * Speech player (ADR-030): the next segment is synthesized while the current one plays (no
 * silence between them), carries the previous text, and nothing from a cut reply is ever
 * scheduled after a barge-in. Web Audio and the network are faked.
 */

const started: number[] = [];
class FakeContext {
  currentTime = 0;
  destination = {};
  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} };
  }
  createBuffer(_c: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return {
      buffer: null as { duration: number } | null,
      onended: null,
      connect() {},
      start(at: number) {
        started.push(at);
      },
      stop() {},
    };
  }
  createOscillator() {
    return {};
  }
  createGain() {
    return {};
  }
  async resume() {}
  async close() {}
}

/** A response whose audio arrives only when the test releases it. */
function controlled() {
  let push!: (bytes: Uint8Array | null) => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (b) => (b ? c.enqueue(b) : c.close());
    },
  });
  return {
    response: new Response(body, { headers: { "x-audio-format": "pcm_s16le;rate=24000" } }),
    push: (b: Uint8Array | null) => push(b),
  };
}

const flushAsync = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("speech player", () => {
  const calls: { body: { text: string; previous?: string } }[] = [];
  let responses: ReturnType<typeof controlled>[] = [];
  beforeEach(() => {
    started.length = 0;
    calls.length = 0;
    responses = [];
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ body: JSON.parse(init.body as string) });
        const r = controlled();
        responses.push(r);
        return r.response;
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests the next segment while the current one is still arriving, with the text before it", async () => {
    const p = new SpeechPlayer();
    p.speak("Encontré la reunión.", "es");
    p.speak("Es a las dos.", "es");
    await flushAsync();
    // Both requested before the first segment's audio has finished.
    expect(calls.map((c) => c.body.text)).toEqual(["Encontré la reunión.", "Es a las dos."]);
    expect(calls[1]!.body.previous).toBe("Encontré la reunión.");
  });

  it("after a barge-in, late audio from the cut reply is never scheduled", async () => {
    const p = new SpeechPlayer();
    p.speak("Una respuesta larga que se interrumpe.", "es");
    await flushAsync();
    p.stop();
    responses[0]!.push(new Uint8Array(24_000));
    responses[0]!.push(null);
    await flushAsync();
    expect(started).toHaveLength(0);
  });

  it("a progress line whose moment passed is never requested", async () => {
    const p = new SpeechPlayer();
    p.speak("Lo busco.", "es", { valid: () => false });
    await flushAsync();
    expect(calls).toHaveLength(0);
  });

  it("segments are scheduled back to back and report their size and gap", async () => {
    const p = new SpeechPlayer();
    const stats: { chars: number; gapMs: number }[] = [];
    p.onSegment = (s) => stats.push(s);
    p.speak("Encontré la reunión.", "es");
    p.speak("Es a las dos.", "es");
    await flushAsync();
    responses[0]!.push(new Uint8Array(14_400)); // 0.3 s
    responses[0]!.push(null);
    await flushAsync();
    responses[1]!.push(new Uint8Array(14_400));
    responses[1]!.push(null);
    await flushAsync();
    expect(started).toHaveLength(2);
    expect(started[1]).toBeCloseTo(started[0]! + 0.3, 5);
    expect(stats.map((s) => s.gapMs)).toEqual([0, 0]);
    expect(stats[0]!.chars).toBe("Encontré la reunión.".length);
  });
});
