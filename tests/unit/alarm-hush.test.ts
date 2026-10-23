// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

/**
 * A ringing alarm goes quiet while ELISE listens or speaks (so "ELISE, apagá la alarma" is heard
 * to the end) and comes back if it wasn't turned off.
 */

const played = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/features/voice/sound-log", () => ({ logSound: () => played.n++ }));

const param = () => ({
  value: 0,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
});
class FakeContext {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = async () => undefined;
  createOscillator() {
    const node = { type: "", frequency: param(), start: vi.fn(), stop: vi.fn() };
    return { ...node, connect: (n: unknown) => n };
  }
  createGain() {
    return { gain: param(), connect: (n: unknown) => n };
  }
}
vi.stubGlobal("AudioContext", FakeContext);

const { hushAlarms, ring } = await import("@/features/time/alarm-sound");

describe("alarm while ELISE listens", () => {
  it("stays silent while hushed and rings again after", async () => {
    vi.useFakeTimers();
    const r = await ring("brisa", 80, true);
    expect(played.n).toBe(1);
    hushAlarms(true);
    vi.advanceTimersByTime(20_000);
    expect(played.n).toBe(1);
    hushAlarms(false);
    vi.advanceTimersByTime(20_000);
    expect(played.n).toBeGreaterThan(1);
    r.stop();
    vi.useRealTimers();
  });
});
