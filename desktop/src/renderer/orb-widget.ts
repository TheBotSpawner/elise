import { OrbRenderer } from "@/components/elise/orb/orb-renderer";
import { toRendererState } from "@/components/elise/orb/orb-states";

/**
 * The background-listening orb (ADR-095), in its own tiny window: ELISE's real Orb renderer on a
 * canvas, nothing else (no React, no bridge). It shows only while a conversation is active.
 */
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const renderer = new OrbRenderer();
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

const loop = (now: number) => {
  requestAnimationFrame(loop);
  const px = canvas.clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const backing = Math.round(px * dpr);
  if (canvas.width !== backing) canvas.width = canvas.height = backing;
  renderer.frame(ctx, px, dpr, now, {
    state: toRendererState("speaking"),
    light: false,
    reduced: reduced.matches,
    level: -1,
    pointer: { x: 0, y: 0 },
  });
};
requestAnimationFrame(loop);
