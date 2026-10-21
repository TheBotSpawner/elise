"use client";

import { logSound } from "@/features/voice/sound-log";

/**
 * Completion feedback (ADR-072): checking a habit day, completing a task or reaching a goal
 * feels finished — a short accent pop on what was tapped, one soft tone, and on phones a tap of
 * haptics. Decoration only: it never decides, delays or blocks the action, and every part fails
 * silently (no audio, no vibration API, reduced motion).
 *
 * It is called from the user's own interaction, never from rendering: a refetch, a realtime
 * update or a change made in Chat re-renders the item as completed but plays nothing. The same
 * item within a moment (a double tap, two handlers) plays once.
 */

export type CompletionKind = "habit" | "task" | "goal";

const PREF = "elise.interactionSounds";
/** A repeat of the same completion inside this window is the same completion. */
const ONCE_MS = 1500;

export const COMPLETION_SOUND = {
  /** Peak gain: softer than the startup tone; a goal is a touch fuller, not louder. */
  gain: 0.045,
  durationS: { habit: 0.22, task: 0.22, goal: 0.38 },
} as const;

export function interactionSoundsEnabled(): boolean {
  try {
    return window.localStorage.getItem(PREF) !== "0";
  } catch {
    return true;
  }
}

export function setInteractionSoundsEnabled(on: boolean) {
  try {
    window.localStorage.setItem(PREF, on ? "1" : "0");
  } catch {
    // Storage blocked: the default (on) stays for this page.
  }
}

/** One quick rising pair (a soft "tick-ting"); a goal adds a higher partial that lingers. */
export function synthesizeCompletion(ctx: AudioContext, kind: CompletionKind) {
  logSound(`completion:${kind}`);
  const t0 = ctx.currentTime + 0.005;
  const end = t0 + COMPLETION_SOUND.durationS[kind];
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t0);
  master.gain.exponentialRampToValueAtTime(COMPLETION_SOUND.gain, t0 + 0.012);
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  master.connect(ctx.destination);
  const note = (freq: number, at: number, level: number) => {
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t0 + at);
    amp.gain.setValueAtTime(level, t0 + at);
    osc.connect(amp).connect(master);
    osc.start(t0 + at);
    osc.stop(end);
  };
  note(880, 0, 0.6); // A5
  note(1318.51, 0.05, 0.5); // E6, a fifth up: "done"
  if (kind === "goal") note(1760, 0.11, 0.3); // A6: a little more meaning, same voice
}

let audio: AudioContext | null = null;

/** One context, reused: no start-up lag on the next completion. */
function context(): AudioContext | null {
  if (!interactionSoundsEnabled() || !("AudioContext" in window)) return null;
  audio ??= new AudioContext();
  return audio;
}

/**
 * Call inside the tap when the completion is confirmed later (a goal, after the server): the
 * audio is unlocked by the gesture, so the tone may play once the answer comes back.
 */
export function primeCompletionSound() {
  try {
    const ctx = context();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => undefined);
  } catch {
    // Decoration only.
  }
}

function playTone(kind: CompletionKind) {
  // Created inside the tap (or primed there), so the browser's autoplay rules allow it; if they
  // don't, it stays silent.
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "running") synthesizeCompletion(ctx, kind);
  else
    void ctx.resume().then(
      () => synthesizeCompletion(ctx, kind),
      () => undefined,
    );
}

function haptic(kind: CompletionKind) {
  if (!window.matchMedia?.("(pointer: coarse)").matches) return;
  navigator.vibrate?.(kind === "goal" ? [10, 60, 10] : 8);
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The pop: a quick scale with a thin accent glow that settles. Nothing else on the page moves. */
function pop(element: Element, kind: CompletionKind) {
  if (reducedMotion() || typeof element.animate !== "function") return;
  const glow = "color-mix(in srgb, var(--accent) 45%, transparent)";
  element.animate(
    [
      { transform: "scale(0.94)", boxShadow: `0 0 0 0 ${glow}` },
      { transform: "scale(1.04)", boxShadow: `0 0 0 4px ${glow}`, offset: 0.45 },
      { transform: "scale(1)", boxShadow: "0 0 0 0 transparent" },
    ],
    { duration: kind === "goal" ? 420 : 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  );
}

const recent = new Map<string, number>();

/**
 * The one entry point, for an explicit incomplete → complete by the user (`key` names the item:
 * "task:<id>", "habit:<id>:<date>"). Returns whether it played; it never throws.
 */
export function completionFeedback({
  kind,
  key,
  element,
  now = Date.now(),
}: {
  kind: CompletionKind;
  key: string;
  element?: Element | null;
  now?: number;
}): boolean {
  if (typeof window === "undefined") return false;
  if (now - (recent.get(key) ?? -Infinity) < ONCE_MS) return false;
  recent.set(key, now);
  for (const part of [
    () => element && pop(element, kind),
    () => playTone(kind),
    () => haptic(kind),
  ])
    try {
      part();
    } catch {
      // Decoration: a missing API or a refused device never reaches the user.
    }
  return true;
}
