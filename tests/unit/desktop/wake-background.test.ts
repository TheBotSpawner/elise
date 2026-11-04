import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WAKE_MODELS } from "@/core/voice/wake-detector";

/** ADR-137: the corner Orb comes up with the word, and a silent microphone doesn't pass for one. */

const handlers: { onPartial?: (text: string) => void } = {};
vi.mock("../../../desktop/src/renderer/wake/vosk-worker-client", () => ({
  VoskWorker: class {
    ready = Promise.resolve();
    recognizer(_rate: number, _grammar: unknown, h: typeof handlers) {
      Object.assign(handlers, h);
      return { accept: () => undefined, remove: () => undefined };
    }
    terminate() {}
  },
}));

const metrics = vi.hoisted(() => ({ getAppMetrics: vi.fn() }));
vi.mock("electron", () => ({ app: metrics, BrowserWindow: {}, powerMonitor: {} }));
vi.mock("../../../desktop/src/main/log", () => ({ log: vi.fn() }));
vi.mock("../../../desktop/src/main/store", () => ({ loadState: vi.fn() }));
vi.mock("../../../desktop/src/main/wake-orb", () => ({ isWakeOrbWindow: vi.fn() }));

const { VoskWakeDetector } = await import("../../../desktop/src/renderer/wake/vosk-detector");
const { resetAudioService } = await import("../../../desktop/src/main/wake");

/** A microphone track: frames arrive only when the test pushes them. */
function microphone() {
  const waiting: ((r: { value?: unknown; done: boolean }) => void)[] = [];
  const queued: unknown[] = [];
  const stop = vi.fn();
  class Processor {
    readable = {
      getReader: () => ({
        read: () =>
          new Promise((resolve) => {
            if (queued.length) resolve({ value: queued.shift(), done: false });
            else waiting.push(resolve);
          }),
        cancel: async () => waiting.shift()?.({ done: true }),
      }),
    };
  }
  const track = {
    stop,
    getSettings: () => ({ sampleRate: 16_000 }),
    addEventListener: () => undefined,
  };
  vi.stubGlobal("window", { MediaStreamTrackProcessor: Processor, location: { origin: "app:" } });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
    },
  });
  const frame = () => {
    const value = {
      numberOfFrames: 2048,
      numberOfChannels: 1,
      sampleRate: 16_000,
      copyTo: () => undefined,
      close: () => undefined,
    };
    const next = waiting.shift();
    if (next) next({ value, done: false });
    else queued.push(value);
  };
  return { frame, stop };
}

async function started(
  events: string[],
  onCaptured: (d: InstanceType<typeof VoskWakeDetector>) => void,
) {
  const detector = new VoskWakeDetector();
  await detector.start({
    model: WAKE_MODELS[0]!,
    onState: (s) => events.push(s),
    onDetected: () => events.push("detected"),
    onCaptured: () => onCaptured(detector),
  });
  await vi.advanceTimersByTimeAsync(0);
  return detector;
}

describe("the wake detector in the background (ADR-137)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("says a microphone that delivers nothing is gone, in seconds", async () => {
    const { stop } = microphone();
    const events: string[] = [];
    const detector = await started(events, () => undefined);
    expect(detector.state).toBe("listening");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(detector.state).toBe("no_microphone");
    expect(detector.stalls).toBe(1);
    expect(stop).toHaveBeenCalled();
  });

  it("leaves a microphone that delivers audio alone", async () => {
    const { frame } = microphone();
    const detector = await started([], () => undefined);
    for (let i = 0; i < 30; i++) {
      frame();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(detector.state).toBe("listening");
    expect(detector.stalls).toBe(0);
    detector.stop();
  });

  it("tells what the Orb shows before the report that brings it up, and doesn't drop it after", async () => {
    const { frame } = microphone();
    const events: string[] = [];
    const detector = await started(events, (d) => d.hold());
    events.length = 0;
    handlers.onPartial?.("elise");
    expect(events).toEqual(["detected", "capturing"]);
    for (let i = 0; i < 16; i++) frame();
    await vi.advanceTimersByTimeAsync(0);
    // The hand-off held the detector: no "listening" while it transcribes.
    expect(events).toEqual(["detected", "capturing"]);
    expect(detector.state).toBe("held");
    detector.stop();
  });
});

describe("restarting the audio service (ADR-137)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("restarts it once a minute at most, and only that process", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    metrics.getAppMetrics.mockReturnValue([
      { pid: 1, serviceName: "network.mojom.NetworkService" },
      { pid: 2, serviceName: "audio.mojom.AudioService" },
    ]);
    resetAudioService();
    resetAudioService();
    expect(kill.mock.calls).toEqual([[2]]);
    vi.advanceTimersByTime(60_000);
    resetAudioService();
    expect(kill).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
