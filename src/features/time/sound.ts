"use client";

import type { TimerSound } from "@/core/timers/model";

/**
 * ELISE's timer sound (ADR-045): a short synthesized chime (no file, no jarring alarm). Browsers
 * only let a page make sound after the user interacted with it, so the audio context is unlocked
 * on the first tap or key press and reused. Without that, the visual notice still shows.
 */

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  return ctx;
}

/** Called once from the app: the first user gesture unlocks sound for later completions. */
export function unlockAudioOnGesture() {
  const unlock = () => {
    void context()?.resume();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return unlock;
}

/** Notes (Hz) and gain of each style: ELISE is a rising three-note chime, soft one low note. */
const STYLES: Record<Exclude<TimerSound, "none">, { notes: number[]; gain: number }> = {
  elise: { notes: [659.25, 880, 1318.5], gain: 0.18 },
  soft: { notes: [523.25, 659.25], gain: 0.09 },
};

/** Plays the chime; false when the browser doesn't allow sound yet. */
export function playChime(sound: TimerSound): boolean {
  if (sound === "none") return true;
  const c = context();
  if (!c || c.state !== "running") return false;
  const { notes, gain } = STYLES[sound];
  const start = c.currentTime + 0.02;
  notes.forEach((freq, i) => {
    const t = start + i * 0.16;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(env).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.95);
  });
  return true;
}
