// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { DEFAULT_TIME_PREFERENCES } from "@/core/timers/model";
import type { TimerPayload } from "@/core/workspace/time";
import { nearest, timeStore } from "@/features/time/store";

const MIN = 60_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");

const timer = (id: string, over: Partial<TimerPayload> = {}): TimerPayload => ({
  id,
  kind: "timer",
  label: id,
  state: "running",
  durationMs: 30 * MIN,
  startedAt: new Date(NOW).toISOString(),
  endsAt: new Date(NOW + 30 * MIN).toISOString(),
  remainingMs: null,
  elapsedMs: 0,
  laps: [],
  pomodoro: null,
  version: 1,
  completedAt: null,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
  serverNow: new Date(NOW).toISOString(),
  ...over,
});

describe("the page's timers (global mini timer)", () => {
  it("shows the nearest end; paused and stopwatches come after running ones", () => {
    const pasta = timer("Pasta", { endsAt: new Date(NOW + 8 * MIN).toISOString() });
    const laundry = timer("Lavarropas");
    const paused = timer("Estudio", { state: "paused", endsAt: null, remainingMs: MIN });
    expect(nearest([laundry, paused, pasta], new Date(NOW))?.id).toBe("Pasta");
    expect(nearest([timer("x", { state: "completed" })], new Date(NOW))).toBeNull();
  });

  it("a newer version always wins (a late Realtime event never rolls a timer back)", () => {
    timeStore.load(
      [timer("a", { version: 3 })],
      DEFAULT_TIME_PREFERENCES,
      new Date().toISOString(),
    );
    timeStore.upsert(timer("a", { version: 2, state: "paused" }));
    expect(timeStore.get().timers[0]).toMatchObject({ version: 3, state: "running" });
    timeStore.upsert(timer("a", { version: 4, state: "paused" }));
    expect(timeStore.get().timers[0]).toMatchObject({ version: 4, state: "paused" });
  });

  it("counts on the server's clock (this device's clock may be off)", () => {
    const server = Date.now() + 90_000;
    timeStore.load([], DEFAULT_TIME_PREFERENCES, new Date(server).toISOString());
    expect(Math.abs(timeStore.now().getTime() - server)).toBeLessThan(1_000);
  });
});
