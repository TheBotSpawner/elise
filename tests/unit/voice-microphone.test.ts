import { afterEach, describe, expect, it, vi } from "vitest";

import { Microphone } from "@/features/voice/microphone";

/**
 * Root cause of "the first follow-up after ELISE speaks is lost": a stopped MediaRecorder
 * delivers its final chunk *after* stop(), and that fragment of the previous recording landed
 * at the start of the next utterance — an invalid WebM the speech provider rejected (400).
 */
class FakeRecorder {
  static all: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly label: string) {
    FakeRecorder.all.push(this);
  }
  start() {
    this.state = "recording";
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  stop() {
    this.state = "inactive";
    // Like Chrome: the last data and the stop event arrive asynchronously.
    queueMicrotask(() => {
      this.emit(`${this.label}:tail`);
      this.onstop?.();
    });
  }
}

let recorders = 0;
function install() {
  FakeRecorder.all = [];
  recorders = 0;
  vi.stubGlobal(
    "MediaRecorder",
    Object.assign(
      function (this: unknown) {
        return new FakeRecorder(`r${++recorders}`);
      } as unknown as typeof MediaRecorder,
      { isTypeSupported: () => true },
    ),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      resume() {
        return Promise.resolve();
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return { fftSize: 0, getFloatTimeDomainData() {} };
      }
    },
  );
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    configurable: true,
  });
  vi.stubGlobal("window", globalThis);
}

afterEach(() => vi.unstubAllGlobals());

describe("microphone recordings", () => {
  it("a discarded recording's late fragment never reaches the next utterance", async () => {
    install();
    const mic = new Microphone();
    await mic.open();
    // ELISE speaks: the recorder runs for barge-in.
    mic.begin();
    FakeRecorder.all[0]!.emit("r1:elise-speaking");
    // Playback ended → listen(): discard, then a fresh recording at once.
    mic.discard();
    mic.begin();
    await Promise.resolve();
    await Promise.resolve();
    FakeRecorder.all[1]!.emit("r2:header+user-speech");
    const utterance = await mic.finish();
    expect(await utterance.blob.text()).toBe("r2:header+user-speech" + "r2:tail");
  });

  it("an old recorder's late stop never clears the new recording", async () => {
    install();
    const mic = new Microphone();
    await mic.open();
    mic.begin();
    const first = mic.finish(); // stop() is async
    mic.begin(); // the next utterance starts before the old stop event
    await first;
    FakeRecorder.all[1]!.emit("r2:speech");
    expect(mic.recording).toBe(true);
    expect(await (await mic.finish()).blob.text()).toBe("r2:speech" + "r2:tail");
  });
});
