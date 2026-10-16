// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { completesDay, type Habit, type HabitEntry } from "@/core/capabilities/habits";

/** A Web Audio stand-in that counts what was played. */
class FakeAudio {
  static created = 0;
  static tones = 0;
  state = "running";
  currentTime = 0;
  destination = {};
  constructor() {
    FakeAudio.created++;
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect: (x: unknown) => x,
    };
  }
  createOscillator() {
    FakeAudio.tones++;
    return {
      type: "sine",
      frequency: { setValueAtTime() {} },
      connect: (x: unknown) => x,
      start() {},
      stop() {},
    };
  }
  resume() {
    return Promise.resolve();
  }
}

function media(matches: Record<string, boolean>) {
  window.matchMedia = ((q: string) => ({ matches: Boolean(matches[q]) })) as never;
}

async function fresh() {
  vi.resetModules();
  return import("@/features/feedback/completion");
}

beforeEach(() => {
  FakeAudio.created = 0;
  FakeAudio.tones = 0;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudio;
  media({});
  window.localStorage.clear();
});

describe("completion feedback (ADR-072)", () => {
  it("one completion plays once: a double tap or a second handler doesn't replay it", async () => {
    const { completionFeedback } = await fresh();
    expect(completionFeedback({ kind: "task", key: "task:1", now: 1000 })).toBe(true);
    expect(completionFeedback({ kind: "task", key: "task:1", now: 1400 })).toBe(false);
    expect(completionFeedback({ kind: "task", key: "task:2", now: 1400 })).toBe(true);
    expect(FakeAudio.created).toBe(1); // one context, reused
    expect(FakeAudio.tones).toBe(4); // two notes per completion
    // Much later it's a new completion (completed, reopened, completed again).
    expect(completionFeedback({ kind: "task", key: "task:1", now: 9000 })).toBe(true);
  });

  it("a goal sounds a little fuller than a habit day", async () => {
    const { completionFeedback } = await fresh();
    completionFeedback({ kind: "goal", key: "goal:1" });
    expect(FakeAudio.tones).toBe(3);
  });

  it("interaction sounds off: no audio at all, the pop still shows", async () => {
    const { completionFeedback, setInteractionSoundsEnabled } = await fresh();
    setInteractionSoundsEnabled(false);
    const el = document.createElement("button");
    el.animate = vi.fn() as never;
    completionFeedback({ kind: "habit", key: "habit:h:2026-10-16", element: el });
    expect(FakeAudio.created).toBe(0);
    expect(el.animate).toHaveBeenCalledOnce();
  });

  it("reduced motion: no pop, the completion still counts and sounds", async () => {
    media({ "(prefers-reduced-motion: reduce)": true });
    const { completionFeedback } = await fresh();
    const el = document.createElement("button");
    el.animate = vi.fn() as never;
    expect(completionFeedback({ kind: "habit", key: "h", element: el })).toBe(true);
    expect(el.animate).not.toHaveBeenCalled();
    expect(FakeAudio.tones).toBe(2);
  });

  it("a refused or missing audio device never surfaces", async () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = class {
      constructor() {
        throw new Error("NotAllowedError");
      }
    };
    const { completionFeedback } = await fresh();
    expect(() => completionFeedback({ kind: "task", key: "t" })).not.toThrow();
  });

  it("haptics only on touch screens, and very short", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    let feedback = await fresh();
    feedback.completionFeedback({ kind: "task", key: "a" });
    expect(vibrate).not.toHaveBeenCalled();
    media({ "(pointer: coarse)": true });
    feedback = await fresh();
    feedback.completionFeedback({ kind: "task", key: "b" });
    expect(vibrate).toHaveBeenCalledWith(8);
  });
});

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: "h1",
  name: "Leer",
  description: null,
  frequency: "daily",
  target: 1,
  unit: null,
  preferredDays: [],
  active: true,
  startDate: "2026-01-01",
  createdAt: "",
  icon: null,
  pausedUntil: null,
  archived: false,
  ...over,
});
const entry = (value: number): HabitEntry => ({
  id: "e",
  habitId: "h1",
  date: "2026-10-16",
  value,
  status: "done",
  notes: null,
  source: "user_ui",
});

describe("which habit writes complete a day", () => {
  it("not met → met completes; undo or an already met day doesn't", () => {
    expect(completesDay(habit(), undefined, 1)).toBe(true);
    expect(completesDay(habit(), entry(1), 1)).toBe(false);
    expect(completesDay(habit(), entry(1), null)).toBe(false);
    expect(completesDay(habit(), undefined, null)).toBe(false);
  });

  it("measured habits complete only when the day's target is reached", () => {
    const water = habit({ unit: "litros", target: 2 });
    expect(completesDay(water, undefined, 1)).toBe(false);
    expect(completesDay(water, entry(1), 2)).toBe(true);
    expect(completesDay(water, entry(2), 3)).toBe(false);
  });
});
