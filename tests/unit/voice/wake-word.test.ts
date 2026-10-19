import { describe, expect, it } from "vitest";

import { voiceReducer, initialVoice } from "@/core/voice/session";
import { asksToShow, EndOfSpeech, WAKE_MODELS, wakeGrammar } from "@/core/voice/wake-detector";
import {
  deviceMayListen,
  onDeviceWake,
  onVoicePhase,
  publishVoicePhase,
  requestDeviceWake,
} from "@/features/voice/device-wake";

/** "ELISE" on the device (ADR-095): the pure parts — model data, end of speech, hand-off. */
describe("the wake word as data", () => {
  it("the grammar is the word, its competitors and 'anything else'", () => {
    const m = WAKE_MODELS[0]!;
    const g = wakeGrammar(m);
    expect(g[0]).toBe("elise");
    expect(g.at(-1)).toBe("[unk]");
    // Real names that sound alike stay as competitors; rare words that stole the word don't.
    expect(g).toEqual(expect.arrayContaining(["elisa", "eli", "elías"]));
    expect(g).not.toEqual(expect.arrayContaining(["lis"]));
    expect(m.license).toBe("Apache-2.0");
  });
});

describe("the end of what followed the word", () => {
  const run = (frames: number[]) => {
    const e = new EndOfSpeech();
    for (let i = 0; i < 20; i++) e.learn(0.002); // a quiet room
    let n = 0;
    for (const f of frames) {
      n++;
      if (e.push(f)) return { frames: n, speechAfter: e.speechAfter };
    }
    return { frames: -1, speechAfter: e.speechAfter };
  };
  it("a command: ends after a short silence", () => {
    expect(run([0.1, 0.1, 0.1, ...Array(10).fill(0.002)])).toEqual({
      frames: 10,
      speechAfter: true,
    });
  });
  it("the word alone: waits a little longer for a pause, then ends with nothing more", () => {
    expect(run(Array(20).fill(0.002))).toEqual({ frames: 11, speechAfter: false });
  });
  it("never runs forever (a TV in the background)", () => {
    expect(run(Array(100).fill(0.1)).frames).toBe(70);
  });
});

describe("only explicit words bring the window up", () => {
  it.each([
    ["abrí ELISE y mostrame la planificación", true],
    ["mostrame esto en pantalla", true],
    ["abrí tu ventana", true],
    ["¿qué tengo mañana?", false],
    ["organizame la mañana", false],
    ["poné música", false],
  ])("%s → %s", (text, shows) => expect(asksToShow(text)).toBe(shows));
});

describe("the hand-off between the device and the session", () => {
  it("a wake before the session mounts is delivered once it does", () => {
    requestDeviceWake("¿qué tengo mañana?");
    const got: string[] = [];
    const off = onDeviceWake((r) => got.push(r));
    expect(got).toEqual(["¿qué tengo mañana?"]);
    requestDeviceWake("otra");
    expect(got).toEqual(["¿qué tengo mañana?", "otra"]);
    off();
  });
  it("the device listens only while nobody talks", () => {
    const seen: string[] = [];
    const off = onVoicePhase((p) => seen.push(p));
    publishVoicePhase("speaking");
    publishVoicePhase("sleeping");
    off();
    expect(seen.slice(-2)).toEqual(["speaking", "sleeping"]);
    expect(deviceMayListen("speaking")).toBe(false);
    expect(deviceMayListen("listening")).toBe(false);
    expect(deviceMayListen("sleeping")).toBe(true);
    expect(deviceMayListen("idle")).toBe(true);
  });
  it("a session that doesn't exist yet rests, ready to wake (no microphone yet)", () => {
    const s = voiceReducer(initialVoice, {
      type: "rest",
      speak: true,
      bargeIn: true,
      continuous: false,
    });
    expect(s.phase).toBe("sleeping");
    const busy = voiceReducer(
      { ...initialVoice, phase: "speaking" },
      { type: "rest", speak: true, bargeIn: true, continuous: false },
    );
    expect(busy.phase).toBe("speaking");
  });
});
