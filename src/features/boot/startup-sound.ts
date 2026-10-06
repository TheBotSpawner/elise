"use client";

/**
 * ELISE's startup sound (ADR-046, Parts X-AA): one short, soft "system online" tone, played
 * with the Orb's boot sequence. Synthesized with Web Audio — an original sound, no file, no
 * network request — about 0.9 s and quiet.
 *
 * Browsers (Chrome's autoplay policy) only let a page start audio after the user interacted
 * with it. ELISE never works around that:
 *   - if this document already has user activation (e.g. signed in and came here with a
 *     click), it plays with the Orb;
 *   - otherwise it waits for the first tap or key press, but only for ARM_MS — a sound
 *     arriving seconds after boot would feel random, so after that it's skipped for this
 *     session. No error, no prompt.
 * A per-device preference turns it off ("elise.startupSound").
 */

const PREF = "elise.startupSound";

export const STARTUP_SOUND = {
  /** How long after boot a first interaction may still play it. */
  armMs: 2000,
  durationS: 0.9,
  /** Peak gain: soft, below the timer chime. */
  gain: 0.06,
} as const;

export function startupSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF) !== "0";
  } catch {
    return true;
  }
}

export function setStartupSoundEnabled(on: boolean) {
  try {
    window.localStorage.setItem(PREF, on ? "1" : "0");
  } catch {
    // Storage blocked: the default (on) stays for this page.
  }
}

/** The tone itself: two soft partials rising a fifth, a brief shimmer, a filter opening up. */
export function synthesize(ctx: AudioContext) {
  const t0 = ctx.currentTime + 0.02;
  const end = t0 + STARTUP_SOUND.durationS;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(STARTUP_SOUND.gain, t0 + 0.06);
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(700, t0);
  filter.frequency.exponentialRampToValueAtTime(5200, t0 + 0.45);
  filter.connect(master).connect(ctx.destination);
  const voice = (type: OscillatorType, from: number, to: number, level: number, start: number) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0 + start);
    osc.frequency.exponentialRampToValueAtTime(to, t0 + start + 0.35);
    amp.gain.setValueAtTime(level, t0);
    osc.connect(amp).connect(filter);
    osc.start(t0 + start);
    osc.stop(end);
  };
  voice("sine", 392, 587.33, 0.7, 0); // G4 → D5
  voice("sine", 392 * 1.004, 587.33 * 1.004, 0.35, 0); // slight detune: width
  voice("triangle", 1174.66, 1567.98, 0.12, 0.12); // the shimmer, entering a beat later
}

type AudioFactory = () => AudioContext | null;

const defaultFactory: AudioFactory = () =>
  typeof window !== "undefined" && "AudioContext" in window ? new AudioContext() : null;

/** Whether the page may start audio right now without being refused. */
function mayPlay(): boolean {
  const nav = navigator as Navigator & {
    userActivation?: { hasBeenActive: boolean };
    getAutoplayPolicy?: (type: "audiocontext") => "allowed" | "allowed-muted" | "disallowed";
  };
  if (nav.getAutoplayPolicy?.("audiocontext") === "allowed") return true;
  return nav.userActivation?.hasBeenActive === true;
}

function play(factory: AudioFactory): boolean {
  const ctx = factory();
  if (!ctx) return false;
  const go = () => {
    synthesize(ctx);
    // One sound, then the audio device is released.
    window.setTimeout(() => void ctx.close().catch(() => undefined), 1500);
  };
  if (ctx.state === "running") go();
  else void ctx.resume().then(go, () => void ctx.close().catch(() => undefined));
  return true;
}

/**
 * Called once, when the Orb boots. "played", "armed" (waiting for the first interaction within
 * ARM_MS), "off" (the user turned it off) or "unsupported".
 */
export function playStartupSound(
  factory: AudioFactory = defaultFactory,
): "played" | "armed" | "off" | "unsupported" {
  if (typeof window === "undefined") return "unsupported";
  if (!startupSoundEnabled()) return "off";
  if (mayPlay()) return play(factory) ? "played" : "unsupported";
  const events = ["pointerdown", "keydown"] as const;
  const disarm = () => {
    window.clearTimeout(timer);
    for (const e of events) window.removeEventListener(e, onGesture, true);
  };
  const onGesture = () => {
    disarm();
    play(factory);
  };
  const timer = window.setTimeout(disarm, STARTUP_SOUND.armMs);
  for (const e of events) window.addEventListener(e, onGesture, true);
  return "armed";
}
