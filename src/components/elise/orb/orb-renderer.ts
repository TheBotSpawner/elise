/**
 * ELISE Orb, "Open Core" (ADR-136; design-reference/ELISE-OpenCore.zip): a thin glass sphere, two
 * opposed arcs that hug it without closing it, an S flowing through it (the dialogue) and a small
 * core (the presence). Motion carries the state; colour only confirms it.
 * Canvas 2D: no WebGL, no libraries, no images. Nothing snaps: motion τ 150 ms, colour τ 200 ms,
 * pointer τ 133 ms. Transients: success 900 ms then idle; error 1200 ms then a dimmer idle.
 */

import { BOOT, type BootFrame } from "./boot";
import type { OrbState } from "./orb-states";

type RGB = [number, number, number];
type Point = [number, number];

export interface StateParams {
  scale: number;
  rot: number;
  span: number;
  arcW: number;
  arcOut: number;
  squash: number;
  spin: number;
  wobble: number;
  wobbleP: number;
  breath: number;
  breathP: number;
  flow: number;
  flowAmp: number;
  flowSpeed: number;
  flowTurn: number;
  flowMorph: number;
  core: number;
  glow: number;
  hollow: number;
  halo: number;
  sweep: number;
  sat: number;
  ping: number;
  shake: number;
  nod: number;
  lvArcs: number;
  lvCore: number;
  lvFlow: number;
  lvArcW: number;
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
 * Geometry (R = the sphere's radius)
 *   scale     sphere size (1 = base)
 *   rot       arc orientation in degrees (-38 diagonal, 90 sides, 0 top/bottom)
 *   span      each arc's opening (°); 180 closes the sphere
 *   arcW      arc thickness (× R)
 *   arcOut    arcs' radial offset (× R): "opening up"
 *   squash    the arcs' perspective (1 = a flat circle)
 * Motion
 *   spin      continuous turn (°/s)
 *   wobble    slow swing (°) · wobbleP its period (s)
 *   breath    scale breathing (fraction) · breathP its period (s)
 * The inner S
 *   flow      opacity · flowAmp curve · flowSpeed cycles/s (+ outward, − toward the core)
 *   flowTurn  the S turning (°/s) · flowMorph how much its curve reorganizes
 * Core
 *   core      radius (× R) · glow halo strength
 *   hollow    0..1 hollow core (error) · halo 0..1 the waiting ring around the core
 * Signals
 *   sweep     meridian sweep (searching) · sat orbiting satellite (executing)
 *   ping      pulse going outward (attention)
 *   shake / nod  the "no" / "yes" gesture on entering the state
 * Audio
 *   lvArcs    level opens the arcs · lvCore level grows the core
 *   lvFlow    level widens the S · lvArcW level thickens the arcs
 * Colour
 *   bright    overall intensity 0..1
 *   tint      [colour, amount] confirming the state (never the only signal)
 *   dur       ms; states with a duration return to idle on their own
 */
const IDLE: StateParams = {
  scale: 1,
  rot: -38,
  span: 128,
  arcW: 0.2,
  arcOut: 0,
  squash: 0.84,
  spin: 0,
  wobble: 4,
  wobbleP: 11,
  breath: 0.012,
  breathP: 5.5,
  flow: 0.32,
  flowAmp: 0.28,
  flowSpeed: 0.1,
  flowTurn: 0,
  flowMorph: 0,
  core: 0.12,
  glow: 0.8,
  hollow: 0,
  halo: 0,
  sweep: 0,
  sat: 0,
  ping: 0,
  shake: 0,
  nod: 0,
  lvArcs: 0,
  lvCore: 0,
  lvFlow: 0,
  lvArcW: 0,
  bright: 0.88,
  tint: [null, 0],
};

const OVERRIDES: Record<Exclude<OrbState, "idle">, Partial<StateParams>> = {
  listening: {
    scale: 1.04,
    rot: 90,
    span: 104,
    arcW: 0.15,
    arcOut: 0.15,
    squash: 0.9,
    wobble: 2,
    wobbleP: 6,
    breath: 0.022,
    breathP: 2.8,
    flow: 0.2,
    flowAmp: 0.16,
    flowSpeed: -0.15,
    core: 0.13,
    glow: 0.95,
    bright: 1,
  },
  user_speaking: {
    scale: 1.02,
    rot: 90,
    span: 64,
    arcW: 0.27,
    arcOut: 0.0,
    squash: 0.9,
    wobble: 0,
    breath: 0,
    flow: 0.28,
    flowAmp: 0.18,
    flowSpeed: -0.7,
    core: 0.12,
    glow: 1,
    lvArcs: 0.34,
    lvCore: 0.45,
    lvFlow: 0.4,
    lvArcW: 0.25,
    bright: 1,
  },
  thinking: {
    rot: -38,
    span: 70,
    arcW: 0.21,
    spin: 42,
    wobble: 0,
    breath: 0.006,
    breathP: 2,
    flow: 0.95,
    flowAmp: 0.42,
    flowSpeed: 0.35,
    flowTurn: 70,
    flowMorph: 0.75,
    core: 0.1,
    glow: 0.75,
    bright: 0.95,
  },
  searching: {
    rot: 0,
    span: 112,
    arcW: 0.14,
    squash: 0.8,
    wobble: 0,
    flow: 0.12,
    flowAmp: 0.12,
    core: 0.1,
    glow: 0.7,
    sweep: 1,
    bright: 0.9,
  },
  speaking: {
    rot: -38,
    span: 120,
    arcW: 0.2,
    wobble: 3,
    wobbleP: 4,
    flow: 0.72,
    flowAmp: 0.26,
    flowSpeed: 0.8,
    core: 0.14,
    glow: 1,
    lvCore: 0.95,
    lvFlow: 1.1,
    lvArcW: 0.35,
    bright: 1,
  },
  executing: {
    rot: 22,
    span: 84,
    arcW: 0.2,
    spin: 150,
    wobble: 0,
    flow: 0.45,
    flowAmp: 0.22,
    flowSpeed: 1.2,
    core: 0.11,
    glow: 0.9,
    sat: 1,
    bright: 1,
  },
  waiting_approval: {
    rot: 90,
    span: 150,
    arcW: 0.16,
    arcOut: 0.02,
    wobble: 0,
    breath: 0.004,
    breathP: 3,
    flow: 0.1,
    flowAmp: 0.1,
    flowSpeed: 0.05,
    core: 0.11,
    glow: 0.85,
    halo: 1,
    bright: 0.95,
    tint: ["#A9C7FF", 0.22],
  },
  success: {
    rot: -38,
    span: 172,
    arcW: 0.17,
    wobble: 0,
    flow: 0.3,
    core: 0.17,
    glow: 1.2,
    nod: 1,
    bright: 1,
    tint: ["#4BE3B0", 0.38],
    dur: 900,
  },
  attention: {
    rot: -38,
    span: 128,
    arcOut: 0.06,
    wobble: 0,
    core: 0.14,
    glow: 1,
    ping: 1,
    bright: 1,
    tint: ["#F6B44E", 0.4],
  },
  error: {
    rot: -38,
    span: 44,
    arcW: 0.2,
    arcOut: -0.02,
    wobble: 0,
    breath: 0,
    flow: 0.06,
    core: 0.13,
    glow: 0.5,
    hollow: 1,
    shake: 1,
    bright: 0.95,
    tint: ["#FF6A5C", 0.55],
    dur: 1200,
  },
  sleeping: {
    scale: 0.9,
    rot: -38,
    span: 158,
    arcW: 0.1,
    squash: 0.8,
    wobble: 0,
    breath: 0.03,
    breathP: 8,
    flow: 0,
    core: 0.07,
    glow: 0.3,
    bright: 0.38,
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
  reduced: { motion: 0, flowSpeed: 0.15, level: 0.5 },
  boot: { dot: 600, sphere: 800, arcs: 900, total: BOOT.durationMs, reduced: BOOT.reducedMs },
  pointerLean: 0.07, // how far it leans toward the pointer (× R)
  periods: { ping: 1.6, sweep: 2.2, sat: 1.1, halo: 2.4 },
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

export class OrbRenderer {
  private readonly p: StateParams = { ...IDLE };
  private color: RGB = [...hex(CONFIG.accent)];
  private readonly ptr = { x: 0, y: 0 };
  private level = 0;
  /** Internal clock (s). */
  private t = 0;
  private last: number | null = null;
  private spinPhase = 0;
  private flowPhase = 0;
  private flowRot = 0;
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
      const r = CONFIG.reduced;
      target.spin *= r.motion;
      target.wobble *= r.motion;
      target.breath *= r.motion;
      target.flowTurn *= r.motion;
      target.flowMorph *= r.motion;
      target.flowSpeed *= r.flowSpeed;
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

    // Continuous turn; stopping, it settles on the nearest multiple of 180° (the arcs are symmetric).
    const p = this.p;
    this.spinPhase += p.spin * DEG * dt;
    if (Math.abs(p.spin) < 6) {
      const home = Math.round(this.spinPhase / Math.PI) * Math.PI;
      this.spinPhase += (home - this.spinPhase) * kM * (1 - Math.abs(p.spin) / 6);
    }
    this.flowPhase += p.flowSpeed * dt;
    this.flowRot += p.flowTurn * DEG * dt;
    if (Math.abs(p.flowTurn) < 4) {
      const home = Math.round(this.flowRot / Math.PI) * Math.PI;
      this.flowRot += (home - this.flowRot) * kM * 0.5;
    }

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
      bFlow = 1,
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
        bFlow = ease((bt - b.total + 500) / 500);
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
    const R = size * 0.34 * p.scale * breath;
    let ox = 0,
      oy = 0;
    if (p.shake && !reduced) {
      const s = this.stateElapsed / 1000;
      if (s < 0.9) ox += R * 0.1 * Math.sin(s * TAU * 6.5) * Math.exp(-s * 3.4);
    }
    if (p.nod && !reduced) {
      const s = this.stateElapsed / 1000;
      if (s < 0.8) oy -= R * 0.07 * Math.sin(s * TAU * 2.4) * Math.exp(-s * 4);
    }
    const lean = CONFIG.pointerLean;
    const X = cx + ox,
      Y = cy + oy;
    // Parallax: the arcs sit in front of the core, so it tilts.
    const ax = X + this.ptr.x * R * lean,
      ay = Y + this.ptr.y * R * lean;
    const kx = X + this.ptr.x * R * lean * 0.45,
      ky = Y + this.ptr.y * R * lean * 0.45;
    const sx = X + this.ptr.x * R * lean * 0.2,
      sy = Y + this.ptr.y * R * lean * 0.2;

    const wob = p.wobble * DEG * Math.sin((t * TAU) / Math.max(0.5, p.wobbleP));
    const rot =
      p.rot * DEG +
      this.spinPhase +
      wob +
      (1 - bArcs) * -1.6 +
      this.ptr.x * 0.12 -
      this.ptr.y * 0.06;
    // The perspective deepens toward the pointer.
    const squash = clamp(
      p.squash - Math.abs(this.ptr.y) * 0.06 + Math.abs(this.ptr.x) * 0.03,
      0.55,
      1,
    );

    ctx.save();
    ctx.globalAlpha = clamp(p.bright, 0, 1) * bAlpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const px1 = Math.max(1, size / 260); // At least 1 logical px; grows with the size.

    // Ambient halo, dark only: in light the stroke gives the contrast, not the glow.
    if (!light && lod > 0 && bSphere > 0) {
      const g = ctx.createRadialGradient(sx, sy, R * 0.2, sx, sy, R * 1.6);
      g.addColorStop(0, rgba(c, 0.1 * p.glow * bSphere));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - R * 1.6, sy - R * 1.6, R * 3.2, R * 3.2);
    }

    // Pulse going outward (attention).
    if (p.ping > 0.02) {
      const per = CONFIG.periods.ping;
      const ph = reduced ? 0.45 : (t % per) / per;
      const rr = R * (1.08 + 0.32 * easeOut(ph)) + Math.max(0, p.arcOut) * R;
      const a = (reduced ? 0.55 : Math.pow(1 - ph, 1.4) * 0.75) * p.ping;
      ctx.strokeStyle = rgba(light ? main : hi, a);
      ctx.lineWidth = Math.max(px1 * (lod ? 1.2 : 1.1), R * 0.035 * (reduced ? 0.8 : 1 - ph * 0.6));
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, TAU);
      ctx.stroke();
      if (!reduced) {
        // A faint base ring: the signal stays between pulses (it matters at 40 px).
        ctx.strokeStyle = rgba(light ? main : hi, 0.3 * p.ping);
        ctx.lineWidth = Math.max(px1, R * 0.018);
        ctx.beginPath();
        ctx.arc(sx, sy, R * 1.12 + Math.max(0, p.arcOut) * R, 0, TAU);
        ctx.stroke();
      }
      if (!reduced && lod > 0) {
        const ph2 = ((t + per / 2) % per) / per;
        ctx.strokeStyle = rgba(light ? main : hi, Math.pow(1 - ph2, 1.6) * 0.3 * p.ping);
        ctx.beginPath();
        ctx.arc(sx, sy, R * (1.08 + 0.32 * easeOut(ph2)), 0, TAU);
        ctx.stroke();
      }
    }

    // The glass sphere.
    if (bSphere > 0) {
      if (lod > 0) {
        const g = ctx.createRadialGradient(sx - R * 0.3, sy - R * 0.35, R * 0.1, sx, sy, R);
        if (light) {
          g.addColorStop(0, "rgba(255,255,255,0)");
          g.addColorStop(1, rgba(main, 0.075 * bSphere));
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
      // A thin specular reflection.
      if (lod > 0 && bSphere > 0.5) {
        ctx.strokeStyle = light ? rgba(WHITE, 0.9 * bSphere) : rgba(WHITE, 0.12 * bSphere);
        ctx.lineWidth = Math.max(1, R * (light ? 0.02 : 0.012));
        ctx.beginPath();
        ctx.arc(sx, sy, R * 0.9, -2.55, -1.75);
        ctx.stroke();
      }
    }

    // Sweep (searching).
    if (p.sweep > 0.02 && bSphere > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx, sy, R * 0.985, 0, TAU);
      ctx.clip();
      ctx.translate(sx, sy);
      ctx.rotate(-14 * DEG);
      const per = CONFIG.periods.sweep;
      const phi = reduced ? 0.55 : (Math.PI / 2) * 0.8 * Math.sin((t * TAU) / per);
      const dir = reduced ? 1 : Math.sign(Math.cos((t * TAU) / per)) || 1;
      const trail = lod === 0 ? [0] : [0, 0.13, 0.26];
      for (let i = trail.length - 1; i >= 0; i--) {
        const f = phi - dir * trail[i];
        const rx = R * Math.sin(f);
        ctx.strokeStyle = rgba(light ? main : hi, (i === 0 ? 0.95 : 0.35 / i) * p.sweep);
        ctx.lineWidth = Math.max(px1 * (lod ? 1.3 : 1.25), R * (i === 0 ? 0.045 : 0.025));
        ctx.beginPath();
        ctx.ellipse(0, 0, Math.max(0.01, Math.abs(rx)), R, 0, -Math.PI / 2, Math.PI / 2, rx < 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    // The inner S.
    const flowA = p.flow * bFlow * (1 + p.lvFlow * lv * 0.4);
    if (flowA > 0.03 && (lod > 0 || p.flow > 0.5)) {
      const amp = R * (p.flowAmp * (1 + p.flowMorph * Math.sin(t * 1.35)) + p.lvFlow * lv * 0.22);
      const ang = rot + this.flowRot + 0.35;
      const L = R * 0.8;
      const ca = Math.cos(ang),
        sa = Math.sin(ang);
      const N = lod === 2 ? 36 : 22;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const u = -1 + (2 * i) / N;
        const lx = u * L,
          ly = -amp * Math.sin(Math.PI * u) * (1 - 0.25 * u * u);
        const x = kx + lx * ca - ly * sa,
          y = ky + lx * sa + ly * ca;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      const g = ctx.createLinearGradient(kx - L * ca, ky - L * sa, kx + L * ca, ky + L * sa);
      const col = light ? main : hi;
      // A glint travels the S (the dialogue); its direction says who is talking.
      const h = ((this.flowPhase % 1) + 1) % 1;
      const stops: [number, number][] = [
        [0, 0],
        [0.2, 0.35],
        [0.5, 0.55],
        [0.8, 0.35],
        [1, 0],
      ];
      for (const [o, a] of stops) g.addColorStop(o, rgba(col, a * flowA));
      const hp = 0.12 + 0.76 * h;
      g.addColorStop(clamp(hp - 0.09, 0, 1), rgba(col, 0.5 * flowA));
      g.addColorStop(hp, rgba(col, Math.min(1, 1.15 * flowA)));
      g.addColorStop(clamp(hp + 0.09, 0, 1), rgba(col, 0.5 * flowA));
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(lod ? 1 : 1.2, R * (lod === 2 ? 0.022 : 0.032));
      ctx.stroke();
      if (!light && lod > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = rgba(c, 0.07 * flowA);
        ctx.lineWidth = R * 0.08;
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // The arcs.
    if (bArcs > 0) {
      const span = p.span * DEG * (0.25 + 0.75 * bArcs);
      const rA = R * (1 + p.arcOut + p.lvArcs * lv * 0.5 + (1 - bArcs) * 0.25);
      const w = R * p.arcW * (lod === 0 ? 1.3 : 1) * (1 + p.lvArcW * lv * 0.5);
      for (let side = 0; side < 2; side++) {
        const center = rot - Math.PI / 2 + side * Math.PI;
        this.arc(
          ctx,
          ax,
          ay,
          rA,
          w,
          squash,
          center,
          span,
          lod,
          light,
          { c, hi, main, deep },
          bArcs,
          side,
        );
      }
    }

    // Satellite (executing): a point in orbit with a short trail.
    if (p.sat > 0.02) {
      const per = CONFIG.periods.sat;
      const a0 = reduced ? -0.6 : (t * TAU) / per;
      const cr = Math.cos(rot),
        sr = Math.sin(rot);
      const at = (a: number): Point => {
        const ex = R * 0.74 * Math.cos(a),
          ey = R * 0.74 * Math.sin(a) * squash;
        return [kx + ex * cr - ey * sr, ky + ex * sr + ey * cr];
      };
      const dotR = Math.max(lod ? 1.6 : 1.4, R * 0.055);
      if (!reduced && lod > 0) {
        const M = 10;
        for (let i = 0; i < M; i++) {
          const pa = at(a0 - 0.9 * (1 - i / M)),
            pb = at(a0 - 0.9 * (1 - (i + 1) / M));
          ctx.strokeStyle = rgba(light ? main : hi, p.sat * 0.55 * (i / M));
          ctx.lineWidth = dotR * 1.1 * (0.3 + (0.7 * i) / M);
          ctx.beginPath();
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
          ctx.stroke();
        }
      }
      const q = at(a0);
      ctx.fillStyle = rgba(light ? deep : hi, p.sat);
      ctx.beginPath();
      ctx.arc(q[0], q[1], dotR, 0, TAU);
      ctx.fill();
    }

    // The core.
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
        ctx.globalAlpha *= solid;
        ctx.beginPath();
        ctx.arc(kx, ky, cr, 0, TAU);
        ctx.fill();
        ctx.globalAlpha /= solid;
      }
      if (p.hollow > 0.01) {
        ctx.strokeStyle = rgba(light ? deep : hi, p.hollow);
        ctx.lineWidth = Math.max(1.1, cr * 0.42);
        ctx.beginPath();
        ctx.arc(kx, ky, cr * 1.05, 0, TAU);
        ctx.stroke();
      }
      // The waiting ring around the core (waiting_approval).
      if (p.halo > 0.02) {
        const per = CONFIG.periods.halo;
        const ph = reduced ? 0 : Math.sin((t * TAU) / per);
        ctx.strokeStyle = rgba(light ? main : hi, p.halo * (0.75 + 0.2 * ph));
        ctx.lineWidth = Math.max(lod ? 1.1 : 1, R * 0.026);
        ctx.beginPath();
        ctx.arc(kx, ky, Math.max(cr + 2.2, cr * 2.5 * (1 + 0.05 * ph)), 0, TAU);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** An arc: a tapered ribbon on a tilted ellipse (perspective). */
  private arc(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    w: number,
    k: number,
    center: number,
    span: number,
    lod: number,
    light: boolean,
    pal: { c: RGB; hi: RGB; main: RGB; deep: RGB },
    alpha: number,
    side: number,
  ) {
    const N = lod === 2 ? 44 : lod === 1 ? 28 : 16;
    const pw = lod === 0 ? 0.38 : 0.62; // Blunter ends at small sizes.
    const a0 = center - span / 2;
    // The ellipse follows the arcs' rotation.
    const rotE = center + Math.PI / 2 - side * Math.PI;
    const ce = Math.cos(rotE),
      se = Math.sin(rotE);
    const pt = (rad: number, th: number): Point => {
      const lx = rad * Math.cos(th - rotE),
        ly = rad * Math.sin(th - rotE) * k;
      return [cx + lx * ce - ly * se, cy + lx * se + ly * ce];
    };
    const outer: Point[] = [];
    const inner: Point[] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N,
        th = a0 + span * u;
      const prof = Math.pow(Math.sin(Math.PI * u), pw) * (0.8 + 0.4 * u);
      outer.push(pt(r, th));
      inner.push(pt(r - w * prof, th));
    }
    ctx.beginPath();
    ctx.moveTo(...outer[0]!);
    for (let i = 1; i <= N; i++) ctx.lineTo(...outer[i]!);
    for (let i = N; i >= 0; i--) ctx.lineTo(...inner[i]!);
    ctx.closePath();

    const s = outer[0]!;
    const e = outer[N]!;
    const g = ctx.createLinearGradient(s[0], s[1], e[0], e[1]);
    const prevA = ctx.globalAlpha;
    ctx.globalAlpha = prevA * alpha;
    if (light) {
      g.addColorStop(0, rgba(pal.main, 1));
      g.addColorStop(0.6, rgba(pal.deep, 1));
      g.addColorStop(1, rgba(pal.main, 1));
    } else {
      // Glow without shadowBlur: additive strokes of the same outline.
      if (lod > 0) {
        ctx.globalCompositeOperation = "lighter";
        const gw: [number, number][] =
          lod === 2
            ? [
                [0.26, 0.018],
                [0.15, 0.03],
                [0.07, 0.05],
              ]
            : [
                [0.18, 0.03],
                [0.07, 0.06],
              ];
        for (const [lw, a] of gw) {
          ctx.strokeStyle = rgba(pal.c, a);
          ctx.lineWidth = r * lw;
          ctx.stroke();
        }
        ctx.globalCompositeOperation = "source-over";
      }
      g.addColorStop(0, rgba(pal.hi, 1));
      g.addColorStop(0.55, rgba(pal.c, 1));
      g.addColorStop(1, rgba(pal.deep, 1));
    }
    ctx.fillStyle = g;
    ctx.fill();
    if (light) {
      ctx.strokeStyle = rgba(pal.deep, 0.5);
      ctx.lineWidth = Math.max(0.6, r * 0.008);
      ctx.stroke();
    }
    // A light edge along the outer border.
    if (lod > 0) {
      ctx.beginPath();
      const from = Math.floor(N * 0.15),
        to = Math.ceil(N * 0.8);
      for (let i = from; i <= to; i++) {
        if (i === from) ctx.moveTo(...outer[i]!);
        else ctx.lineTo(...outer[i]!);
      }
      ctx.strokeStyle = light ? rgba(WHITE, 0.55) : rgba(WHITE, 0.45);
      ctx.lineWidth = Math.max(0.8, r * 0.012);
      ctx.stroke();
    }
    ctx.globalAlpha = prevA;
  }
}
