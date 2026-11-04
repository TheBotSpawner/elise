/**
 * ELISE Orb, "Open Core · Ojo" (ADR-136; design-reference/ELISE-OpenCore.zip): a thin glass sphere
 * that works as an eye. The logo's two crescents are its eyelids: they hug the sphere without ever
 * closing it. The core is the pupil, ELISE's presence: it looks, dilates with the voice and narrows
 * when something asks for attention. Motion carries the state; colour only confirms it.
 * Canvas 2D: no WebGL, no libraries, no images. Nothing snaps: motion τ 150 ms, colour τ 200 ms,
 * pointer τ 133 ms. Transients: success 900 ms then idle; error 1200 ms then a dimmer idle.
 * It never blinks by itself: the design rules it out (it feels more human than it should).
 */

import { BOOT, type BootFrame } from "./boot";
import type { OrbState } from "./orb-states";

type RGB = [number, number, number];

export interface StateParams {
  scale: number;
  rot: number;
  span: number;
  lid: number;
  arcOut: number;
  wobble: number;
  wobbleP: number;
  breath: number;
  breathP: number;
  core: number;
  glow: number;
  gazeX: number;
  gazeY: number;
  drift: number;
  driftP: number;
  saccade: number;
  hollow: number;
  halo: number;
  iris: number;
  lightUp: number;
  rimLight: number;
  lvCore: number;
  lvLids: number;
  nod: number;
  shake: number;
  ping: number;
  bright: number;
  tint: readonly [string | null, number];
  dur?: number;
}

type NumericParam = Exclude<keyof StateParams, "tint" | "dur">;

export interface OrbFrameInput {
  state: OrbState;
  light: boolean;
  /** Approved accent key (data-accent); cyan when absent. */
  accent?: string;
  reduced: boolean;
  /** Live mic/TTS RMS 0..1; negative = simulated while listening/speaking. */
  level: number;
  /** Normalized pointer position relative to the orb (-1..1, soft-clamped). */
  pointer: { x: number; y: number };
  /** The startup sequence, while it plays (boot.ts); null/absent: the Orb as usual. */
  boot?: BootFrame | null;
}

/** The energy colour of each approved accent (ADR-012). In light, the palette inks it itself. */
const ACCENT_HEX: Record<string, string> = {
  blue: "#7FB0FF",
  violet: "#B49CFF",
  green: "#6FE3A4",
  amber: "#F2C35B",
};

/** Syllables and phrases, no randomness: a voice while there's no real level. */
function simulatedLevel(t: number) {
  const syl = Math.abs(Math.sin(t * 7.1)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 1.1));
  const word = 0.5 + 0.5 * Math.sin(t * 1.27);
  const phrase = Math.sin(t * 0.55) > -0.55 ? 1 : 0.08;
  return Math.min(1, Math.max(0, (0.15 + syl * 0.85) * (0.45 + 0.55 * word) * phrase));
}

/**
 * States are data: everything tunable lives here, the drawing code only reads it.
 *
 * Eyelids (R = the sphere's radius)
 *   rot       orientation (°): 0 horizontal eye, -38 the logo's diagonal, 90 lids at the sides
 *   span      each lid's length (°)
 *   lid       closing: thickness at its centre (× R). 0.2 a crescent, 0.5 half shut, 1 shut
 *   arcOut    radial opening (× R) · scale the sphere's size
 *   wobble    slow drift (°) · wobbleP its period (s)
 *   breath    scale breathing (fraction) · breathP its period (s)
 * Pupil (the core)
 *   core      radius (× R) · glow halo strength
 *   gazeX/Y   where it looks (× R)
 *   drift     small circular path of the gaze (thinking) · driftP its period (s)
 *   saccade   0..1 a gaze jumping from point to point (searching)
 *   hollow    hollow pupil (error) · halo the still ring around it (waiting)
 *   iris      segments turning around the pupil (executing)
 * Voice
 *   lightUp   ELISE speaks: the light is born in the pupil and fills the glass
 *   rimLight  the person speaks: the light comes in from the glass's edge toward the pupil
 *   lvCore / lvLids  how much the voice level moves the pupil and the lids
 * Gestures and signals
 *   nod / shake  the "yes" / "no" on entering the state · ping a pulse going outward
 * Colour
 *   bright    overall intensity 0..1
 *   tint      [colour, amount] confirming the state (never the only signal)
 *   dur       ms; states with a duration return to idle on their own
 */
const IDLE: StateParams = {
  scale: 1,
  rot: -38,
  span: 142,
  lid: 0.2,
  arcOut: 0,
  wobble: 3,
  wobbleP: 12,
  breath: 0.012,
  breathP: 5.5,
  core: 0.12,
  glow: 0.8,
  gazeX: 0,
  gazeY: 0,
  drift: 0,
  driftP: 3,
  saccade: 0,
  hollow: 0,
  halo: 0,
  iris: 0,
  lightUp: 0,
  rimLight: 0,
  lvCore: 0,
  lvLids: 0,
  nod: 0,
  shake: 0,
  ping: 0,
  bright: 0.9,
  tint: [null, 0],
};

const OVERRIDES: Record<Exclude<OrbState, "idle">, Partial<StateParams>> = {
  listening: {
    scale: 1.03,
    rot: 0,
    span: 150,
    lid: 0.14,
    arcOut: 0.12,
    wobble: 1.5,
    wobbleP: 6,
    breath: 0.02,
    breathP: 2.8,
    core: 0.135,
    glow: 0.95,
    bright: 1,
  },
  user_speaking: {
    scale: 1.02,
    rot: 0,
    span: 146,
    lid: 0.16,
    arcOut: 0.05,
    wobble: 0,
    breath: 0,
    core: 0.12,
    glow: 1,
    rimLight: 1,
    lvCore: 0.35,
    lvLids: 0.3,
    bright: 1,
  },
  thinking: {
    rot: -20,
    span: 160,
    lid: 0.34,
    wobble: 0,
    breath: 0.006,
    breathP: 2,
    core: 0.1,
    glow: 0.75,
    gazeX: 0.2,
    gazeY: -0.24,
    drift: 0.07,
    driftP: 3.2,
    bright: 0.95,
  },
  searching: {
    rot: 0,
    span: 150,
    lid: 0.14,
    arcOut: 0.06,
    wobble: 0,
    core: 0.1,
    glow: 0.85,
    saccade: 1,
    bright: 1,
  },
  speaking: {
    rot: -38,
    span: 142,
    lid: 0.2,
    wobble: 2,
    wobbleP: 4,
    core: 0.14,
    glow: 1,
    lightUp: 1,
    lvCore: 0.9,
    lvLids: 0.25,
    bright: 1,
  },
  executing: {
    rot: 0,
    span: 168,
    lid: 0.4,
    wobble: 0,
    core: 0.11,
    glow: 0.9,
    iris: 1,
    bright: 1,
  },
  waiting_approval: {
    rot: 90,
    span: 158,
    lid: 0.16,
    arcOut: 0.02,
    wobble: 0,
    breath: 0.004,
    breathP: 3,
    core: 0.11,
    glow: 0.85,
    halo: 1,
    bright: 0.95,
    tint: ["#A9C7FF", 0.22],
  },
  success: {
    rot: -38,
    span: 150,
    lid: 0.18,
    arcOut: 0.08,
    wobble: 0,
    core: 0.17,
    glow: 1.3,
    nod: 1,
    bright: 1,
    tint: ["#4BE3B0", 0.38],
    dur: 900,
  },
  attention: {
    rot: 0,
    span: 146,
    lid: 0.14,
    arcOut: 0.1,
    wobble: 0,
    core: 0.095,
    glow: 1,
    ping: 1,
    bright: 1,
    tint: ["#F6B44E", 0.4],
  },
  error: {
    rot: -38,
    span: 150,
    lid: 0.42,
    arcOut: -0.02,
    wobble: 0,
    breath: 0,
    core: 0.13,
    glow: 0.5,
    hollow: 1,
    shake: 1,
    bright: 0.95,
    tint: ["#FF6A5C", 0.5],
    dur: 1200,
  },
  sleeping: {
    scale: 0.92,
    rot: 0,
    span: 176,
    lid: 0.86,
    wobble: 0,
    breath: 0.03,
    breathP: 8,
    core: 0.07,
    glow: 0.3,
    bright: 0.42,
    tint: ["#8A9BA3", 0.55],
  },
};
// Every state inherits from idle what it doesn't define.
const STATES = Object.fromEntries([
  ["idle", IDLE],
  ...Object.entries(OVERRIDES).map(([k, v]) => [k, { ...IDLE, ...v }]),
]) as Record<OrbState, StateParams>;

/** What doesn't depend on the state. */
const CONFIG = {
  accent: "#22D3EE",
  tauMotion: 150, // ms · ~95 % in 450 ms
  tauColor: 200, // ms · ~95 % in 600 ms
  tauPointer: 133, // ms · ~95 % in 400 ms
  afterErrorDim: { bright: 0.6, tint: ["#8A9BA3", 0.3] as const }, // the dimmer idle after an error
  reduced: { motion: 0, level: 0.5, saccadeDwell: 2.2 },
  boot: { dot: 600, sphere: 800, arcs: 900, total: BOOT.durationMs, reduced: BOOT.reducedMs },
  pointerLean: 0.03, // the whole eye shifts toward the pointer (× R)
  pointerGaze: 0.14, // how much the pupil looks at the pointer (× R): discreet on purpose
  saccade: { dwell: 0.62, move: 0.13, rx: 0.4, ry: 0.26 },
  periods: { ping: 1.6, halo: 2.4, iris: 1.3 },
};

const NUM_KEYS = (Object.keys(IDLE) as (keyof StateParams)[]).filter(
  (k): k is NumericParam => typeof IDLE[k] === "number",
);
const TAU = Math.PI * 2,
  DEG = Math.PI / 180;

const hexCache: Record<string, RGB> = {};
function hex(c: string): RGB {
  const hit = hexCache[c];
  if (hit) return hit;
  let s = String(c).trim().replace("#", "");
  if (s.length === 3) s = [...s].map((x) => x + x).join("");
  const n = parseInt(s.slice(0, 6), 16);
  const out: RGB = isNaN(n) ? [34, 211, 238] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (hexCache[c] = out);
}
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgba = (c: RGB, a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : +a.toFixed(3)})`;
const WHITE: RGB = [255, 255, 255];
const INK: RGB = [5, 50, 61];
const INK_DEEP: RGB = [2, 28, 34];
const NIGHT: RGB = [0, 59, 74];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
/** Deterministic noise for the gaze's jumps. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

export class OrbRenderer {
  private readonly p: StateParams = { ...IDLE };
  private color: RGB = [...hex(CONFIG.accent)];
  private readonly ptr = { x: 0, y: 0 };
  /** The gaze's eased position while it jumps (searching). */
  private readonly sac = { x: 0, y: 0 };
  private level = 0;
  /** Internal clock (s). */
  private t = 0;
  private last: number | null = null;
  private inState: OrbState | null = null;
  private stateStart = 0;
  private stateElapsed = 0;
  private dimAfterError = false;
  private first = true;
  /** The state on show (success and error return to idle on their own). */
  effectiveState: OrbState = "idle";
  /** 60 in active states, 30 at rest, 20 asleep or reduced at rest. */
  suggestedFps = 60;

  /** One frame on the Orb's own square canvas. */
  frame(
    ctx: CanvasRenderingContext2D,
    size: number,
    dpr: number,
    now: number,
    input: OrbFrameInput,
  ) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    this.draw(ctx, size / 2, size / 2, size, input, now);
  }

  /** State → eased targets. */
  private update(input: OrbFrameInput, now: number) {
    const dtMs = this.last == null ? 16 : clamp(now - this.last, 0, 100);
    this.last = now;
    const dt = dtMs / 1000;
    this.t += dt;

    const req = input.state;
    if (req !== this.inState) {
      this.dimAfterError = false;
      this.inState = req;
      this.stateStart = now;
    }
    let eff = req;
    const def = STATES[req];
    const since = now - this.stateStart;
    if (def.dur && since > def.dur) {
      eff = "idle";
      if (req === "error") this.dimAfterError = true;
    }
    this.effectiveState = eff;
    this.stateElapsed = since;

    const target = { ...STATES[eff] };
    if (eff === "idle" && this.dimAfterError) {
      target.bright = CONFIG.afterErrorDim.bright;
      target.tint = CONFIG.afterErrorDim.tint;
    }
    const reduced = !!input.reduced;
    if (reduced) {
      const m = CONFIG.reduced.motion;
      target.wobble *= m;
      target.breath *= m;
      target.drift *= m;
      target.shake = 0;
      target.nod = 0;
    }

    // The first frame has no transition.
    const kM = this.first ? 1 : 1 - Math.exp(-dtMs / CONFIG.tauMotion);
    const kC = this.first ? 1 : 1 - Math.exp(-dtMs / CONFIG.tauColor);
    const kP = this.first ? 1 : 1 - Math.exp(-dtMs / CONFIG.tauPointer);
    this.first = false;

    for (const k of NUM_KEYS) this.p[k] += (target[k] - this.p[k]) * kM;
    // Gestures fire on entering; they aren't eased.
    this.p.shake = target.shake;
    this.p.nod = target.nod;

    // Colour: the accent plus the state's tint.
    const acc = hex(ACCENT_HEX[input.accent ?? ""] ?? CONFIG.accent);
    const tc = target.tint[0] ? mix(acc, hex(target.tint[0]), target.tint[1]) : acc;
    this.color = mix(this.color, tc, kC);

    const px = clamp(input.pointer.x, -1, 1);
    const py = clamp(input.pointer.y, -1, 1);
    const pm = reduced ? 0.3 : 1;
    this.ptr.x += (px * pm - this.ptr.x) * kP;
    this.ptr.y += (py * pm - this.ptr.y) * kP;

    // Audio, real or simulated: quick attack, soft decay.
    const lv = clamp(input.level < 0 ? simulatedLevel(this.t) : input.level, 0, 1);
    const kL = 1 - Math.exp(-dtMs / (lv > this.level ? 45 : 160));
    this.level += (lv - this.level) * kL;

    // The gaze's jumps: quick moves between points, pauses in between.
    const S = CONFIG.saccade;
    const dwell = reduced ? CONFIG.reduced.saccadeDwell : S.dwell;
    const step = Math.floor(this.t / dwell);
    const spot = (i: number) => {
      if (i < 0) return [0, 0] as const;
      const a = hash(i * 1.7 + 3) * TAU;
      const r = 0.45 + 0.55 * hash(i * 2.3 + 9);
      return [Math.cos(a) * r * S.rx, Math.sin(a) * r * S.ry] as const;
    };
    const from = spot(step - 1);
    const to = spot(step);
    const m = easeOut((this.t - step * dwell) / (reduced ? 0.6 : S.move));
    this.sac.x = from[0] + (to[0] - from[0]) * m;
    this.sac.y = from[1] + (to[1] - from[1]) * m;

    // Suggested fps, to save work at rest.
    const calm = eff === "idle" || eff === "waiting_approval";
    this.suggestedFps = eff === "sleeping" || (reduced && calm) ? 20 : calm || reduced ? 30 : 60;
    return reduced;
  }

  private draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    size: number,
    input: OrbFrameInput,
    now: number,
  ) {
    const reduced = this.update(input, now);
    const p = this.p;
    const t = this.t;
    const lv = this.level * (reduced ? CONFIG.reduced.level : 1);
    const light = input.light;
    const lod = size < 64 ? 0 : size < 220 ? 1 : 2;

    // Boot.
    let bDot = 1,
      bSphere = 1,
      bArcs = 1,
      bAlpha = 1;
    if (input.boot) {
      const b = CONFIG.boot;
      const bt = input.boot.t;
      if (reduced) {
        bAlpha = ease(bt / b.reduced);
      } else {
        bDot = easeOut(bt / b.dot);
        bSphere = ease((bt - b.dot) / b.sphere);
        bArcs = easeOut((bt - b.dot - b.sphere * 0.75) / b.arcs);
      }
    }

    // Palette.
    const c = this.color;
    let hi: RGB, main: RGB, deep: RGB;
    if (light) {
      hi = mix(c, INK, 0.12);
      main = mix(c, INK, 0.42);
      deep = mix(c, INK_DEEP, 0.66);
    } else {
      hi = mix(c, WHITE, 0.62);
      main = c;
      deep = mix(c, NIGHT, 0.4);
    }

    // Geometry.
    const breath = 1 + p.breath * Math.sin((t * TAU) / Math.max(0.5, p.breathP));
    const R = size * 0.36 * p.scale * breath;
    let ox = 0,
      oy = 0;
    const elapsed = this.stateElapsed / 1000;
    if (p.shake && !reduced && elapsed < 0.9)
      ox += R * 0.1 * Math.sin(elapsed * TAU * 6.5) * Math.exp(-elapsed * 3.4);
    if (p.nod && !reduced && elapsed < 0.8)
      oy -= R * 0.07 * Math.sin(elapsed * TAU * 2.4) * Math.exp(-elapsed * 4);
    // Sphere and lids move together (the lids never leave the edge); the lean toward the pointer
    // comes from the pupil's gaze and a slight turn of the lids.
    const sx = cx + ox + this.ptr.x * R * CONFIG.pointerLean;
    const sy = cy + oy + this.ptr.y * R * CONFIG.pointerLean;

    // The pupil's gaze.
    const dA = (t * TAU) / Math.max(0.5, p.driftP);
    let gx =
      p.gazeX + p.drift * Math.cos(dA) + p.saccade * this.sac.x + this.ptr.x * CONFIG.pointerGaze;
    let gy =
      p.gazeY +
      p.drift * Math.sin(dA) * 0.7 +
      p.saccade * this.sac.y +
      this.ptr.y * CONFIG.pointerGaze;
    const gl = Math.hypot(gx, gy);
    if (gl > 0.5) {
      gx *= 0.5 / gl;
      gy *= 0.5 / gl;
    }
    const kx = sx + gx * R;
    const ky = sy + gy * R;

    const wob = p.wobble * DEG * Math.sin((t * TAU) / Math.max(0.5, p.wobbleP));
    const rot = p.rot * DEG + wob + (1 - bArcs) * -1.6 + this.ptr.x * 0.1 - this.ptr.y * 0.05;

    ctx.save();
    ctx.globalAlpha = clamp(p.bright, 0, 1) * bAlpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const px1 = Math.max(1, size / 260); // At least 1 logical px; grows with the size.
    const col = light ? main : hi;

    // Ambient halo, dark only: in light the stroke gives the contrast, not the glow.
    if (!light && lod > 0 && bSphere > 0) {
      const g = ctx.createRadialGradient(sx, sy, R * 0.2, sx, sy, R * 1.65);
      g.addColorStop(0, rgba(c, 0.1 * p.glow * bSphere));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - R * 1.65, sy - R * 1.65, R * 3.3, R * 3.3);
    }

    // Pulse going outward (attention).
    if (p.ping > 0.02) {
      const per = CONFIG.periods.ping;
      const base = R * (1.1 + Math.max(0, p.arcOut));
      const ph = reduced ? 0.45 : (t % per) / per;
      if (!reduced && lod === 0) {
        // At a small size, a fixed ring keeps the signal between pulses.
        ctx.strokeStyle = rgba(col, 0.3 * p.ping);
        ctx.lineWidth = Math.max(px1, R * 0.018);
        ctx.beginPath();
        ctx.arc(sx, sy, base, 0, TAU);
        ctx.stroke();
      }
      ctx.strokeStyle = rgba(col, (reduced ? 0.55 : Math.pow(1 - ph, 1.4) * 0.75) * p.ping);
      ctx.lineWidth = Math.max(px1 * 1.1, R * 0.035 * (reduced ? 0.8 : 1 - ph * 0.6));
      ctx.beginPath();
      ctx.arc(sx, sy, base + R * 0.28 * easeOut(ph), 0, TAU);
      ctx.stroke();
    }

    // The glass sphere.
    if (bSphere > 0) {
      if (lod > 0) {
        const g = ctx.createRadialGradient(sx - R * 0.3, sy - R * 0.35, R * 0.1, sx, sy, R);
        if (light) {
          g.addColorStop(0, "rgba(255,255,255,0.35)");
          g.addColorStop(1, rgba(main, 0.08 * bSphere));
        } else {
          g.addColorStop(0, rgba(c, 0.015 * bSphere));
          g.addColorStop(0.75, rgba(c, 0.05 * bSphere));
          g.addColorStop(1, rgba(c, 0.13 * bSphere));
        }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, R, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = light
        ? rgba(deep, (lod ? 0.26 : 0.32) * bSphere)
        : rgba(hi, (lod ? 0.2 : 0.26) * bSphere);
      ctx.lineWidth = Math.max(lod ? 0.75 : 0.9, R * 0.011);
      ctx.beginPath();
      ctx.arc(sx, sy, R, -Math.PI / 2, -Math.PI / 2 + TAU * bSphere);
      ctx.stroke();
    }

    // Inside the eye (the lids cover it afterward).
    ctx.save();
    ctx.beginPath();
    ctx.arc(sx, sy, R * 0.99, 0, TAU);
    ctx.clip();

    // The person speaks: the light comes in from the glass's edge toward the pupil.
    if (p.rimLight > 0.02 && bSphere > 0.5) {
      const a = p.rimLight * (light ? 0.05 + 0.22 * lv : 0.07 + 0.4 * lv);
      const g = ctx.createRadialGradient(sx, sy, R * (0.62 - 0.3 * lv), sx, sy, R);
      g.addColorStop(0, rgba(light ? main : c, 0));
      g.addColorStop(1, rgba(light ? main : c, a));
      if (!light) ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    // She speaks: the inside lights up from the pupil, at the voice's rhythm.
    if (p.lightUp > 0.02 && bDot > 0.5) {
      const a = p.lightUp * (light ? 0.05 + 0.2 * lv : 0.06 + 0.38 * lv);
      const g = ctx.createRadialGradient(kx, ky, 0, kx, ky, R * (0.75 + 0.3 * lv));
      g.addColorStop(0, rgba(light ? main : c, a));
      g.addColorStop(0.5, rgba(light ? main : c, a * 0.4));
      g.addColorStop(1, rgba(light ? main : c, 0));
      if (!light) ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }

    // The pupil.
    if (bDot > 0) {
      const cr =
        Math.max(lod ? 2 : 1.7, R * p.core * (1 + p.lvCore * lv * 0.9) * (lod === 0 ? 1.25 : 1)) *
        (bSphere < 1 ? 1 + (1 - bSphere) * 0.4 * bDot : 1) *
        bDot;
      // Its halo: additive in dark, faint in light (it isn't the signal there).
      const gr = cr * (light ? 2.6 : 4.2);
      const g = ctx.createRadialGradient(kx, ky, 0, kx, ky, gr);
      g.addColorStop(0, rgba(c, (light ? 0.28 : 0.55) * p.glow));
      g.addColorStop(1, rgba(c, 0));
      if (!light) ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(kx, ky, gr, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      const solid = 1 - p.hollow;
      if (solid > 0.01) {
        const cg = ctx.createRadialGradient(kx - cr * 0.3, ky - cr * 0.3, 0, kx, ky, cr);
        if (light) {
          cg.addColorStop(0, rgba(main, 1));
          cg.addColorStop(1, rgba(deep, 1));
        } else {
          cg.addColorStop(0, rgba(WHITE, 1));
          cg.addColorStop(0.45, rgba(hi, 1));
          cg.addColorStop(1, rgba(c, 1));
        }
        ctx.fillStyle = cg;
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * solid;
        ctx.beginPath();
        ctx.arc(kx, ky, cr, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
      if (p.hollow > 0.01) {
        ctx.strokeStyle = rgba(light ? deep : hi, p.hollow);
        ctx.lineWidth = Math.max(1.1, cr * 0.42);
        ctx.beginPath();
        ctx.arc(kx, ky, cr * 1.05, 0, TAU);
        ctx.stroke();
      }
      // The still ring around the pupil (waiting_approval).
      if (p.halo > 0.02) {
        const ph = reduced ? 0 : Math.sin((t * TAU) / CONFIG.periods.halo);
        ctx.strokeStyle = rgba(col, p.halo * (0.75 + 0.2 * ph));
        ctx.lineWidth = Math.max(lod ? 1.1 : 1, R * 0.026);
        ctx.beginPath();
        ctx.arc(kx, ky, Math.max(cr + 2.2, cr * 2.5 * (1 + 0.05 * ph)), 0, TAU);
        ctx.stroke();
      }
      // Executing: an iris turning, two segments, like a diaphragm at work.
      if (p.iris > 0.02) {
        const a0 = reduced ? 0.6 : (t * TAU) / CONFIG.periods.iris;
        const ir = Math.max(cr + 2.6, cr * 2.4);
        ctx.strokeStyle = rgba(col, p.iris * 0.95);
        ctx.lineWidth = Math.max(lod ? 1.4 : 1.3, R * 0.04);
        for (let i = 0; i < 2; i++) {
          ctx.beginPath();
          ctx.arc(kx, ky, ir, a0 + i * Math.PI, a0 + i * Math.PI + 1.15);
          ctx.stroke();
        }
        if (lod > 0) {
          ctx.strokeStyle = rgba(col, p.iris * 0.18);
          ctx.lineWidth = Math.max(1, R * 0.012);
          ctx.beginPath();
          ctx.arc(kx, ky, ir, 0, TAU);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // The glass's reflection, over the pupil, as in a real eye.
    if (bSphere > 0.5 && lod > 0) {
      ctx.strokeStyle = light ? rgba(WHITE, 0.9 * bSphere) : rgba(WHITE, 0.12 * bSphere);
      ctx.lineWidth = Math.max(1, R * (light ? 0.02 : 0.012));
      ctx.beginPath();
      ctx.arc(sx, sy, R * 0.9, -2.55, -1.75);
      ctx.stroke();
    }

    // The lids.
    if (bArcs > 0) {
      const span = p.span * DEG * (0.3 + 0.7 * bArcs);
      const Ro = R * (1 + p.arcOut + p.lvLids * lv * 0.5 + (1 - bArcs) * 0.25);
      const T = R * p.lid * (lod === 0 && p.lid < 0.5 ? 1.3 : 1);
      const alpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha * bArcs;
      for (let side = 0; side < 2; side++)
        this.eyelid(
          ctx,
          sx,
          sy,
          Ro,
          T,
          rot - Math.PI / 2 + side * Math.PI,
          span / 2,
          lod,
          light,
          {
            c,
            hi,
            main,
            deep,
          },
          R,
        );
      ctx.globalAlpha = alpha;
    }

    ctx.restore();
  }

  /**
   * A lid is the logo's crescent. Outer edge: a circle's arc. Inner edge: a curve through both ends
   * and a point `T` from the edge. A small `T` is the crescent; `T` ≈ R and the two lids meet.
   */
  private eyelid(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    Ro: number,
    T: number,
    dir: number,
    a: number,
    lod: number,
    light: boolean,
    pal: { c: RGB; hi: RGB; main: RGB; deep: RGB },
    R: number,
  ) {
    const ux = Math.cos(dir),
      uy = Math.sin(dir);
    const x1 = cx + Ro * Math.cos(dir - a),
      y1 = cy + Ro * Math.sin(dir - a);
    const x2 = cx + Ro * Math.cos(dir + a),
      y2 = cy + Ro * Math.sin(dir + a);
    // Thicker toward one end, like the logo; symmetric as it closes.
    const skew =
      lod === 0 ? 0 : 0.22 * Math.min(T, R * 0.4) * (1 - clamp((T / R - 0.45) / 0.4, 0, 1));
    const m = Ro - T;
    const mx = cx + ux * m - uy * skew,
      my = cy + uy * m + ux * skew;
    const qx = 2 * mx - (x1 + x2) / 2,
      qy = 2 * my - (y1 + y2) / 2;
    const path = () => {
      ctx.beginPath();
      ctx.arc(cx, cy, Ro, dir - a, dir + a, false);
      ctx.quadraticCurveTo(qx, qy, x1, y1);
      ctx.closePath();
    };
    const g = ctx.createLinearGradient(x1, y1, x2, y2);
    if (light) {
      g.addColorStop(0, rgba(pal.main, 1));
      g.addColorStop(1, rgba(pal.deep, 1));
    } else {
      // Glow without shadowBlur: additive strokes of the same outline.
      if (lod > 0) {
        path();
        ctx.globalCompositeOperation = "lighter";
        const glow: [number, number][] =
          lod === 2
            ? [
                [0.22, 0.02],
                [0.12, 0.035],
                [0.05, 0.05],
              ]
            : [
                [0.14, 0.03],
                [0.05, 0.06],
              ];
        for (const [lw, alpha] of glow) {
          ctx.strokeStyle = rgba(pal.c, alpha);
          ctx.lineWidth = R * lw;
          ctx.stroke();
        }
        ctx.globalCompositeOperation = "source-over";
      }
      g.addColorStop(0, rgba(pal.hi, 1));
      g.addColorStop(0.5, rgba(pal.c, 1));
      g.addColorStop(1, rgba(pal.deep, 1));
    }
    path();
    ctx.fillStyle = g;
    ctx.fill();
    if (light) {
      ctx.strokeStyle = rgba(pal.deep, 0.35);
      ctx.lineWidth = Math.max(0.6, R * 0.007);
      ctx.stroke();
    }
    if (lod > 0) {
      // A light edge along the outer border.
      ctx.beginPath();
      ctx.arc(cx, cy, Ro - Math.max(0.6, R * 0.012), dir - a * 0.75, dir + a * 0.45, false);
      ctx.strokeStyle = rgba(WHITE, light ? 0.55 : 0.5);
      ctx.lineWidth = Math.max(0.8, R * 0.014);
      ctx.stroke();
    }
  }
}
