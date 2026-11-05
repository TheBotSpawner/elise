import { OrbRenderer } from "@/components/elise/orb/orb-renderer";
import { toRendererState, type OrbState } from "@/components/elise/orb/orb-states";

/**
 * The background conversation's orb (ADR-095), in its own tiny window: ELISE's real Orb renderer
 * on a canvas, nothing else (no React, no bridge). The main process tells it what the
 * conversation is doing (`eliseOrb.state`) and pops it in when it appears (`eliseOrb.pop`).
 * A tap ends the conversation; the eye brings ELISE to the front: the main process watches for
 * "#end" and "#show" (no bridge here).
 */
const canvas = document.querySelector("canvas")!;
const ctx = canvas.getContext("2d")!;
const renderer = new OrbRenderer();
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
let state: OrbState = "listening";

const STATES: readonly OrbState[] = ["listening", "user_speaking", "thinking", "speaking"];
const setState = (s: string) => {
  if (STATES.includes(s as OrbState)) state = s as OrbState;
};

(window as unknown as { eliseOrb: object }).eliseOrb = {
  state: setState,
  pop: (s: string) => {
    setState(s);
    for (const el of [canvas, document.body]) el.classList.remove("in", "out");
    void canvas.offsetWidth; // restart the transition
    for (const el of [canvas, document.body]) el.classList.add("in");
  },
};

canvas.addEventListener("click", () => {
  for (const el of [canvas, document.body]) el.classList.add("out");
  location.hash = `end-${Date.now()}`;
});
// The eye: ELISE's window to the front; the orb itself keeps working as before.
document.getElementById("eye")!.addEventListener("click", () => {
  location.hash = `show-${Date.now()}`;
});

const loop = (now: number) => {
  requestAnimationFrame(loop);
  const px = canvas.clientWidth;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const backing = Math.round(px * dpr);
  if (canvas.width !== backing) canvas.width = canvas.height = backing;
  renderer.frame(ctx, px, dpr, now, {
    state: toRendererState(state),
    light: false,
    reduced: reduced.matches,
    // No microphone here: the renderer's own motion for listening / speaking.
    level: -1,
    pointer: { x: 0, y: 0 },
  });
};
requestAnimationFrame(loop);
