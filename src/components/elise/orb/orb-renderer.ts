/**
 * ELISE Orb renderer — ported from the approved reference renderer (JarvisOrb).
 * The params() table, easing constants and drawing are kept as in the reference:
 * motion τ 450 ms, colour τ 600 ms, pointer τ 400 ms; nothing snaps.
 * Transients: success shows 900 ms then idle; error 1200 ms then "rest" (dimmer idle).
 */

export type RendererState =
  "idle" | "listening" | "thinking" | "speaking" | "executing" | "approval" | "success" | "error";

type RGB = [number, number, number];

interface Params {
  rot: number;
  dsp: number;
  amp: number;
  scale: number;
  glow: number;
  brate: number;
  breath: number;
  inner: number;
  orbit: number;
  halo: number;
  rings: number;
  follow: number;
  col: RGB;
  level: number;
}

type ParamKey = RendererState | "rest";

const NUMERIC = [
  "rot",
  "dsp",
  "amp",
  "scale",
  "glow",
  "brate",
  "breath",
  "inner",
  "orbit",
  "halo",
  "rings",
  "follow",
] as const;

/** Idle/listening colours per approved accent (ADR-012); state colours never change. */
const ACCENT_RGB: Record<string, { light: [RGB, RGB]; dark: [RGB, RGB] }> = {
  blue: {
    light: [
      [47, 111, 220],
      [36, 89, 184],
    ],
    dark: [
      [127, 176, 255],
      [166, 200, 255],
    ],
  },
  violet: {
    light: [
      [124, 77, 219],
      [106, 60, 196],
    ],
    dark: [
      [180, 156, 255],
      [203, 188, 255],
    ],
  },
  green: {
    light: [
      [23, 138, 79],
      [17, 112, 63],
    ],
    dark: [
      [111, 227, 164],
      [152, 236, 191],
    ],
  },
  amber: {
    light: [
      [183, 121, 31],
      [143, 92, 18],
    ],
    dark: [
      [242, 195, 91],
      [246, 212, 137],
    ],
  },
};

export function orbParams(key: ParamKey, light: boolean, accent?: string): Params {
  const C: Record<string, RGB> = light
    ? {
        idle: [0, 128, 146],
        listen: [0, 140, 160],
        think: [22, 104, 190],
        exec: [40, 80, 205],
        approval: [176, 108, 8],
        success: [0, 136, 92],
        error: [198, 48, 48],
      }
    : {
        idle: [94, 232, 240],
        listen: [128, 242, 255],
        think: [124, 196, 255],
        exec: [126, 160, 255],
        approval: [245, 186, 96],
        success: [120, 240, 190],
        error: [255, 122, 122],
      };
  const tint = accent ? ACCENT_RGB[accent] : undefined;
  if (tint) [C.idle, C.listen] = light ? tint.light : tint.dark;
  const S: Record<ParamKey, Omit<Params, "level">> = {
    idle: {
      rot: 0.12,
      dsp: 0.6,
      amp: 0.35,
      scale: 1,
      glow: 0.6,
      brate: 1.12,
      breath: 1,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 1,
      col: C.idle!,
    },
    listening: {
      rot: 0.18,
      dsp: 0.9,
      amp: 0.5,
      scale: 1.06,
      glow: 0.95,
      brate: 1.12,
      breath: 0.3,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 1,
      follow: 1,
      col: C.listen!,
    },
    thinking: {
      rot: 0.6,
      dsp: 2.2,
      amp: 0.75,
      scale: 0.96,
      glow: 0.8,
      brate: 1.12,
      breath: 0,
      inner: 1,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 0.6,
      col: C.think!,
    },
    speaking: {
      rot: 0.2,
      dsp: 1,
      amp: 0.5,
      scale: 1.02,
      glow: 0.9,
      brate: 1.12,
      breath: 0.2,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 1,
      col: C.idle!,
    },
    executing: {
      rot: 0.45,
      dsp: 0.8,
      amp: 0.3,
      scale: 0.94,
      glow: 0.7,
      brate: 1.12,
      breath: 0,
      inner: 0,
      orbit: 1,
      halo: 0,
      rings: 0,
      follow: 0.4,
      col: C.exec!,
    },
    approval: {
      rot: 0,
      dsp: 0.15,
      amp: 0.2,
      scale: 1,
      glow: 0.75,
      brate: 0.78,
      breath: 1,
      inner: 0,
      orbit: 0,
      halo: 1,
      rings: 0,
      follow: 0,
      col: C.approval!,
    },
    success: {
      rot: 0.15,
      dsp: 0.6,
      amp: 0.3,
      scale: 1.03,
      glow: 0.95,
      brate: 1.12,
      breath: 0.6,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 1,
      col: C.success!,
    },
    error: {
      rot: 0.05,
      dsp: 0.4,
      amp: 0.2,
      scale: 0.97,
      glow: 0.55,
      brate: 1.12,
      breath: 0.3,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 0.5,
      col: C.error!,
    },
    rest: {
      rot: 0.1,
      dsp: 0.5,
      amp: 0.28,
      scale: 0.99,
      glow: 0.45,
      brate: 1.12,
      breath: 0.8,
      inner: 0,
      orbit: 0,
      halo: 0,
      rings: 0,
      follow: 1,
      col: C.idle!,
    },
  };
  const o = S[key] ?? S.idle;
  return { ...o, col: [...o.col] as RGB, level: 0 };
}

export interface OrbFrameInput {
  state: RendererState;
  light: boolean;
  /** Approved accent key (data-accent); cyan when absent. */
  accent?: string;
  reduced: boolean;
  /** Live mic/TTS RMS 0..1; negative = simulated while listening/speaking. */
  level: number;
  /** Normalized pointer position relative to the orb (-1..1, soft-clamped). */
  pointer: { x: number; y: number };
}

/** Stateful renderer: one instance per canvas. Phase-accumulated so speed changes never jump. */
export class OrbRenderer {
  private P: Params | null = null;
  private rot = 0;
  private rot2 = 0;
  private dph = 0;
  private bph = 0;
  private sweep = 0;
  private level = 0;
  private ps = { x: 0, y: 0 };
  private lastState: RendererState | null = null;
  private since = 0;
  private last = 0;

  frame(
    ctx: CanvasRenderingContext2D,
    size: number,
    dpr: number,
    now: number,
    input: OrbFrameInput,
  ) {
    const dt = this.last ? Math.min(0.05, Math.max(0.001, (now - this.last) / 1000)) : 0.016;
    this.last = now;
    const t = now / 1000;
    const { state: s, light, reduced } = input;
    if (s !== this.lastState) {
      this.lastState = s;
      this.since = t;
    }
    const e = t - this.since;
    let key: ParamKey = s;
    if (s === "success" && e > 0.9) key = "idle";
    if (s === "error" && e > 1.2) key = "rest";

    const T = orbParams(key, light, input.accent);
    if (!this.P) this.P = T;
    const P = this.P;
    const k = 1 - Math.exp(-dt / 0.45);
    const kc = 1 - Math.exp(-dt / 0.6);
    for (const n of NUMERIC) P[n] += (T[n] - P[n]) * k;
    for (let i = 0; i < 3; i++) P.col[i]! += (T.col[i]! - P.col[i]!) * kc;

    let lv = 0;
    if (input.level >= 0) lv = s === "listening" || s === "speaking" ? Math.min(1, input.level) : 0;
    else if (s === "listening")
      lv = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1) * 0.8 + Math.sin(t * 13.7) * 0.2);
    else if (s === "speaking")
      lv = Math.max(0, Math.sin(t * 5.2)) * (0.55 + 0.45 * Math.sin(t * 1.3));
    if (reduced) lv *= 0.3;
    this.level += (lv - this.level) * Math.min(1, dt * (lv > this.level ? 30 : 6));
    P.level = this.level;

    const m = reduced ? 0 : 1;
    this.rot += dt * P.rot * m;
    this.rot2 -= dt * 0.9 * P.inner * m;
    this.dph += dt * P.dsp * m;
    this.bph += dt * P.brate * m;
    this.sweep += dt * 1.6 * P.orbit * m;
    const kp = 1 - Math.exp(-dt / 0.4);
    this.ps.x += (input.pointer.x * P.follow * m - this.ps.x) * kp;
    this.ps.y += (input.pointer.y * P.follow * m - this.ps.y) * kp;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const breathe = 0.5 + 0.5 * Math.sin(this.bph);
    let cx = size / 2 + this.ps.x * size * 0.018;
    const cy = size / 2 + this.ps.y * size * 0.018;
    if (s === "error" && e < 0.5 && !reduced) cx += Math.sin(e * 50) * (1 - e / 0.5) * size * 0.014;
    const R = size * 0.27 * P.scale * (1 + 0.022 * breathe * P.breath + 0.07 * P.level);
    this.draw(ctx, cx, cy, R, P, s, e, light, size);
    ctx.globalCompositeOperation = "source-over";
  }

  private draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    P: Params,
    s: RendererState,
    e: number,
    light: boolean,
    size: number,
  ) {
    const r = Math.round(P.col[0]);
    const g = Math.round(P.col[1]);
    const b = Math.round(P.col[2]);
    const c = (a: number) => `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
    const TAU = Math.PI * 2;
    const H = Math.PI / 2;
    // Below 90 px: mini orb (4 latitudes, 8 meridians, no inner core, no rings).
    const small = size < 90;
    const dph = this.dph;
    ctx.globalCompositeOperation = light ? "source-over" : "lighter";
    let gr = ctx.createRadialGradient(cx, cy, R * 0.3, cx, cy, R * 2);
    gr.addColorStop(0, c((light ? 0.09 : 0.15) * P.glow * (small ? 1.4 : 1)));
    gr.addColorStop(1, c(0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2, 0, TAU);
    ctx.fill();
    gr = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 0, cx, cy, R * 1.02);
    gr.addColorStop(0, c(light ? 0.1 : 0.2));
    gr.addColorStop(0.7, c(light ? 0.04 : 0.06));
    gr.addColorStop(1, c(0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.02, 0, TAU);
    ctx.fill();

    const tilt = 0.42 + this.ps.y * 0.22;
    const yaw0 = this.ps.x * 0.5;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    const sphere = (
      rad: number,
      yaw: number,
      lats: number,
      mers: number,
      segL: number,
      segM: number,
      alphaMul: number,
      deform: boolean,
    ) => {
      const proj = (la: number, lo: number): [number, number, number] => {
        let mm = 1;
        if (deform) {
          mm +=
            P.amp * 0.045 * Math.sin(la * 4 + dph * 3) * Math.cos(lo * 3 - dph * 1.8) +
            P.level * 0.07 * Math.sin(la * 7 + dph * 6 + lo) +
            P.inner * 0.03 * Math.sin(lo * 6 + la * 3 - dph * 2.5);
        }
        const x = Math.cos(la) * Math.sin(lo) * mm;
        const y = Math.sin(la) * mm;
        const z = Math.cos(la) * Math.cos(lo) * mm;
        return [cx + x * rad, cy + (y * ct - z * st) * rad, y * st + z * ct];
      };
      const base = (light ? 0.62 : 0.75) * alphaMul;
      const seg = (a: [number, number, number], q: [number, number, number], lo: number) => {
        const f = ((a[2] + q[2]) / 2 + 1) / 2;
        let al = base * (0.06 + 0.94 * f * f);
        if (P.orbit > 0.02) {
          const d = Math.cos(lo - yaw - this.sweep);
          al *= 1 + P.orbit * 1.4 * Math.pow(Math.max(0, d), 10);
        }
        ctx.strokeStyle = c(al);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(q[0], q[1]);
        ctx.stroke();
      };
      for (let i = 1; i <= lats; i++) {
        const la = -H + (i * Math.PI) / (lats + 1);
        let p = proj(la, yaw);
        for (let kk = 1; kk <= segL; kk++) {
          const lo = yaw + (kk / segL) * TAU;
          const q = proj(la, lo);
          seg(p, q, lo);
          p = q;
        }
      }
      for (let j = 0; j < mers; j++) {
        const lo = yaw + (j * TAU) / mers;
        let p = proj(-H, lo);
        for (let kk = 1; kk <= segM; kk++) {
          const q = proj(-H + (kk / segM) * Math.PI, lo);
          seg(p, q, lo);
          p = q;
        }
      }
    };
    ctx.lineWidth = small ? 0.7 : light ? 0.9 : 0.8;
    if (small) sphere(R, this.rot + yaw0, 4, 8, 28, 14, 1, true);
    else sphere(R, this.rot + yaw0, 8, 16, 56, 28, 1, true);
    if (P.inner > 0.02 && !small) {
      ctx.lineWidth = 0.7;
      sphere(R * 0.52, this.rot2, 4, 8, 32, 16, 0.9 * P.inner, false);
    }

    const RR = R * 1.34;
    ctx.lineWidth = small ? 0.8 : 1;
    ctx.strokeStyle = c((light ? 0.22 : 0.18) + P.halo * 0.25);
    ctx.beginPath();
    ctx.arc(cx, cy, RR, 0, TAU);
    ctx.stroke();
    if (P.orbit > 0.02) {
      const a0 = this.sweep * 1.6 - H;
      ctx.lineWidth = small ? 1.4 : 1.8;
      ctx.strokeStyle = c(0.95 * P.orbit);
      ctx.beginPath();
      ctx.arc(cx, cy, RR, a0, a0 + 0.9);
      ctx.stroke();
      ctx.fillStyle = c(P.orbit);
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(a0 + 0.9) * RR,
        cy + Math.sin(a0 + 0.9) * RR,
        small ? 1.4 : 2.4,
        0,
        TAU,
      );
      ctx.fill();
      ctx.lineWidth = 1;
    }
    if (P.halo > 0.02) {
      ctx.setLineDash(small ? [1.5, 3] : [2, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c(0.6 * P.halo * (0.75 + 0.25 * Math.sin(this.bph)));
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.52, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (P.rings > 0.02 && !small) {
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        ctx.strokeStyle = c(0.32 * P.level * P.rings * (1 - i * 0.28));
        ctx.beginPath();
        ctx.arc(cx, cy, R * (1.1 + i * 0.1 + P.level * 0.12 * (i + 1)), 0, TAU);
        ctx.stroke();
      }
    }
    if (s === "success" && e < 0.9) {
      const q = e / 0.9;
      const qe = 1 - Math.pow(1 - q, 3);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = c(0.7 * (1 - q));
      ctx.beginPath();
      ctx.arc(cx, cy, R * (1.02 + qe * 0.8), 0, TAU);
      ctx.stroke();
    }
  }
}
