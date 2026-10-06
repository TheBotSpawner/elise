// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOT, bootFrame, claimBoot, resetBoot, skipBoot } from "@/components/elise/orb/boot";
import { Orb } from "@/components/elise/orb/orb";
import { OrbRenderer } from "@/components/elise/orb/orb-renderer";
import {
  playStartupSound,
  setStartupSoundEnabled,
  STARTUP_SOUND,
  startupSoundEnabled,
} from "@/features/boot/startup-sound";
import { I18nProvider } from "@/lib/i18n/client";

/** ADR-046 Parts W-AB: the Orb boots once per app session, quietly, without slowing anything. */

beforeEach(() => {
  resetBoot();
  localStorage.clear();
});

describe("boot identity", () => {
  it("boots once per document; a remount mid-sequence continues it, never replays it", () => {
    expect(claimBoot(1000)).toEqual({ start: 1000, fresh: true });
    expect(claimBoot(1400)).toEqual({ start: 1000, fresh: false });
    // Navigating away and back to Home, a new chat, the Orb remounting: nothing.
    expect(claimBoot(1000 + BOOT.durationMs + 1)).toBeNull();
    expect(claimBoot(99_999)).toBeNull();
  });

  it("entering ELISE on another route has no boot, even when Home is visited later", () => {
    skipBoot();
    expect(claimBoot(5)).toBeNull();
  });

  it("a Home that already booted is not undone by the shell's skip", () => {
    expect(claimBoot(0)?.fresh).toBe(true);
    skipBoot();
    expect(claimBoot(100)).toEqual({ start: 0, fresh: false });
  });
});

describe("boot sequence", () => {
  it("point → wireframe → ring → idle, settled around 1.2 s", () => {
    expect(bootFrame(0, false)).toEqual({ dot: 0, wire: 0, ring: 0 });
    expect(bootFrame(250, false)!.dot).toBeGreaterThan(0.5);
    expect(bootFrame(250, false)!.wire).toBe(0);
    const mid = bootFrame(700, false)!;
    expect(mid.wire).toBeGreaterThan(0.6);
    expect(mid.ring).toBeGreaterThan(0);
    expect(mid.ring).toBeLessThan(mid.wire);
    expect(bootFrame(1100, false)).toMatchObject({ dot: 0, wire: 1, ring: 1 });
    expect(bootFrame(BOOT.durationMs, false)).toBeNull();
  });

  it("reduced motion: a short fade/resolve, no assembly", () => {
    const f = bootFrame(100, true)!;
    expect(f.dot).toBe(0);
    expect(f.wire).toBe(f.ring);
    expect(bootFrame(BOOT.reducedMs, true)).toBeNull();
  });

  it("the renderer draws the boot frames on the same canvas, then is just the Orb", () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, key) =>
        key in t
          ? t[key as string]
          : key === "createRadialGradient"
            ? () => (calls.push("gradient"), { addColorStop: () => {} })
            : () => {},
      set: (t, key, v) => ((t[key as string] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    const r = new OrbRenderer();
    const input = {
      state: "idle" as const,
      light: false,
      reduced: false,
      level: -1,
      pointer: { x: 0, y: 0 },
    };
    r.frame(ctx, 300, 1, 16, { ...input, boot: bootFrame(200, false) });
    const withDot = calls.length;
    calls.length = 0;
    r.frame(ctx, 300, 1, 32, { ...input, boot: null });
    // The point's own halo is one extra gradient while it shows.
    expect(withDot).toBe(calls.length + 1);
  });
});

describe("Orb lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts the boot (and its sound) once, not again when Home remounts", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      new Proxy({}, { get: () => () => ({ addColorStop: () => {} }) }) as never,
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const onBoot = vi.fn();
    const mount = () =>
      render(
        <I18nProvider locale="es">
          <Orb boot onBoot={onBoot} />
        </I18nProvider>,
      );
    mount().unmount();
    mount().unmount();
    expect(onBoot).toHaveBeenCalledTimes(1);
    // Orbs without `boot` (nav, dock, onboarding) never claim it.
    resetBoot();
    render(
      <I18nProvider locale="es">
        <Orb />
      </I18nProvider>,
    );
    expect(claimBoot(performance.now())?.fresh).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("startup sound", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function fakeAudio() {
    const started: number[] = [];
    const node = () => ({
      connect: (n: unknown) => n,
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      start: (t: number) => started.push(t),
      stop: () => {},
      type: "",
    });
    const ctx = {
      state: "running",
      currentTime: 0,
      destination: {},
      createGain: node,
      createOscillator: node,
      createBiquadFilter: node,
      resume: async () => {},
      close: async () => {},
    };
    const factory = vi.fn(() => ctx as unknown as AudioContext);
    return { factory, started };
  }

  const activation = (hasBeenActive: boolean) =>
    vi.stubGlobal("navigator", { ...navigator, userActivation: { hasBeenActive } });

  it("is on by default and can be turned off per device", () => {
    expect(startupSoundEnabled()).toBe(true);
    setStartupSoundEnabled(false);
    const { factory } = fakeAudio();
    expect(playStartupSound(factory)).toBe("off");
    expect(factory).not.toHaveBeenCalled();
  });

  it("plays at boot when the browser allows it (the page already had a user gesture)", () => {
    activation(true);
    const { factory, started } = fakeAudio();
    expect(playStartupSound(factory)).toBe("played");
    expect(started.length).toBeGreaterThan(0);
  });

  it("autoplay blocked: no error, no AudioContext; the first interaction soon after plays it", () => {
    vi.useFakeTimers();
    activation(false);
    const { factory } = fakeAudio();
    expect(playStartupSound(factory)).toBe("armed");
    expect(factory).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerdown"));
    expect(factory).toHaveBeenCalledTimes(1);
    // Only once.
    window.dispatchEvent(new Event("keydown"));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("autoplay blocked and no interaction in time: skipped for this session, never late", () => {
    vi.useFakeTimers();
    activation(false);
    const { factory } = fakeAudio();
    playStartupSound(factory);
    vi.advanceTimersByTime(STARTUP_SOUND.armMs + 1);
    window.dispatchEvent(new Event("pointerdown"));
    expect(factory).not.toHaveBeenCalled();
  });
});
