import { describe, expect, it } from "vitest";

import { OrbRenderer, type OrbFrameInput } from "@/components/elise/orb/orb-renderer";
import { ORB_STATES, resolveOrbState } from "@/components/elise/orb/orb-states";

/** Canvas 2D context stand-in that records stroke colours and accepts every call. */
function fakeContext() {
  const strokes: string[] = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get: (_t, key) => {
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => gradient;
      if (key in target) return target[key as string];
      return () => {};
    },
    set: (_t, key, value) => {
      if (key === "strokeStyle" && typeof value === "string") strokes.push(value);
      target[key as string] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const input = (over: Partial<OrbFrameInput> = {}): OrbFrameInput => ({
  state: "idle",
  light: false,
  reduced: false,
  level: -1,
  pointer: { x: 0, y: 0 },
  ...over,
});

/** The first colour of the sphere's border, as [r, g, b]. */
const rgb = (s: string) =>
  s
    .match(/[0-9]+/g)!
    .slice(0, 3)
    .map(Number);

describe("Orb state resolution", () => {
  it("follows the motion-spec priority", () => {
    expect(resolveOrbState(["thinking", "waiting_approval"])).toBe("waiting_approval");
    expect(resolveOrbState(["success", "executing"])).toBe("executing");
    expect(resolveOrbState(["error", "success"])).toBe("error");
    expect(resolveOrbState([])).toBe("idle");
  });
});

describe("OrbRenderer", () => {
  it("draws every state, in both themes, at every size, without throwing", () => {
    for (const state of ORB_STATES)
      for (const light of [false, true])
        for (const size of [32, 120, 440])
          for (const reduced of [false, true]) {
            const r = new OrbRenderer();
            const { ctx } = fakeContext();
            for (const now of [0, 16, 32])
              r.frame(
                ctx,
                size,
                2,
                now,
                input({ state, light, reduced, pointer: { x: 1, y: -1 } }),
              );
          }
  });

  it("eases colour toward the new state instead of snapping", () => {
    const r = new OrbRenderer();
    const { ctx, strokes } = fakeContext();
    r.frame(ctx, 440, 1, 1000, input());
    const before = rgb(strokes[0]!);
    strokes.length = 0;
    r.frame(ctx, 440, 1, 1016, input({ state: "error" }));
    const step = rgb(strokes[0]!);
    // One 16 ms step: on its way, not there yet.
    expect(step).not.toEqual(before);
    expect(Math.abs(step[0]! - before[0]!)).toBeLessThan(25);
  });

  it("success and error return to idle on their own, error dimmer", () => {
    const r = new OrbRenderer();
    const { ctx } = fakeContext();
    r.frame(ctx, 200, 1, 0, input({ state: "success" }));
    expect(r.effectiveState).toBe("success");
    r.frame(ctx, 200, 1, 1000, input({ state: "success" }));
    expect(r.effectiveState).toBe("idle");
  });

  it("an accent is a name in the app, never read as a colour code", () => {
    const seen = (accent?: string) => {
      const r = new OrbRenderer();
      const { ctx, strokes } = fakeContext();
      for (let now = 0; now < 3000; now += 50) {
        strokes.length = 0;
        r.frame(ctx, 300, 1, now, input({ accent }));
      }
      return rgb(strokes[0]!);
    };
    // "amber" read as hex is nearly black.
    expect(Math.max(...seen("amber"))).toBeGreaterThan(150);
    expect(seen("amber")).not.toEqual(seen("violet"));
    expect(seen("cyan")).toEqual(seen());
  });

  it("slows down at rest", () => {
    const r = new OrbRenderer();
    const { ctx } = fakeContext();
    r.frame(ctx, 200, 1, 0, input({ state: "thinking" }));
    expect(r.suggestedFps).toBe(60);
    r.frame(ctx, 200, 1, 16, input());
    expect(r.suggestedFps).toBe(30);
    r.frame(ctx, 200, 1, 32, input({ state: "sleeping" }));
    expect(r.suggestedFps).toBe(20);
  });
});
