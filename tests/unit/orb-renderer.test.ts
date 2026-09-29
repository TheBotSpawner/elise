import { describe, expect, it } from "vitest";

import { OrbRenderer, orbParams } from "@/components/elise/orb/orb-renderer";
import { resolveOrbState, toRendererState } from "@/components/elise/orb/orb-states";

/** Canvas 2D context stand-in that records stroke colours and accepts every call. */
function fakeContext() {
  const strokes: string[] = [];
  const gradient = { addColorStop: () => {} };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get: (_t, key) => {
      if (key === "createRadialGradient") return () => gradient;
      if (key in target) return target[key as string];
      return () => {};
    },
    set: (_t, key, value) => {
      if (key === "strokeStyle") strokes.push(value as string);
      target[key as string] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

describe("orbParams", () => {
  it("keeps the approved reference values", () => {
    expect(orbParams("thinking", false)).toMatchObject({
      rot: 0.6,
      dsp: 2.2,
      amp: 0.75,
      scale: 0.96,
      inner: 1,
      col: [124, 196, 255],
    });
    expect(orbParams("approval", false)).toMatchObject({
      rot: 0,
      halo: 1,
      follow: 0,
      brate: 0.78,
      col: [245, 186, 96],
    });
    expect(orbParams("executing", true)).toMatchObject({
      orbit: 1,
      follow: 0.4,
      col: [40, 80, 205],
    });
    expect(orbParams("rest", false)).toMatchObject({ glow: 0.45, col: [94, 232, 240] });
  });
});

describe("Orb state resolution", () => {
  it("follows the motion-spec priority", () => {
    expect(resolveOrbState(["thinking", "waiting_approval"])).toBe("waiting_approval");
    expect(resolveOrbState(["success", "executing"])).toBe("executing");
    expect(resolveOrbState(["error", "success"])).toBe("error");
    expect(resolveOrbState([])).toBe("idle");
    expect(toRendererState("waiting_approval")).toBe("approval");
  });
});

describe("OrbRenderer", () => {
  it("renders frames and eases colour toward the new state instead of snapping", () => {
    const renderer = new OrbRenderer();
    const { ctx, strokes } = fakeContext();
    const input = { light: false, reduced: false, level: -1, pointer: { x: 0, y: 0 } };
    renderer.frame(ctx, 440, 2, 1000, { ...input, state: "idle" });
    strokes.length = 0;
    renderer.frame(ctx, 440, 2, 1016, { ...input, state: "approval" });
    // One 16 ms step toward amber: still close to cyan, not amber yet.
    expect(strokes[0]).toMatch(/^rgba\((9[0-9]|1[0-9]{2}),2[0-9]{2},2[0-9]{2},/);
  });

  it("draws the mini orb below 90 px without throwing", () => {
    const renderer = new OrbRenderer();
    const { ctx } = fakeContext();
    expect(() =>
      renderer.frame(ctx, 40, 2, 1000, {
        state: "executing",
        light: true,
        reduced: true,
        level: 0,
        pointer: { x: 1, y: -1 },
      }),
    ).not.toThrow();
  });
});
