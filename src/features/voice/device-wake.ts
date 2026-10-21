"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

import type { VoicePhase } from "@/core/voice/session";

/**
 * The hand-off between a device's local wake word (ELISE Desktop, ADR-095) and the one voice
 * session the app already has. The device detects "ELISE" and transcribes what followed; the
 * session (the same controller, STT, agent and TTS as a tap on the mic) takes it from there.
 * The session tells the device when it's busy, so only one of them holds the microphone.
 * No second session, no second pipeline: two tiny channels in memory.
 */

/** The device listens for its wake word in the background (Desktop with the setting on). */
export const DeviceWakeContext = createContext(false);
export const useDeviceWake = () => useContext(DeviceWakeContext);

type WakeListener = (remainder: string) => void;
let pending: string | null = null;
/** A page's own conversation (Inicio, a chat): it always gets the wake first. */
let page: WakeListener | null = null;
/** The corner Orb (QuickVoice): only on pages without a conversation of their own. */
let corner: WakeListener | null = null;

/** The device heard the word: the session picks it up now, or as soon as it mounts. */
export function requestDeviceWake(remainder: string) {
  const l = page ?? corner;
  if (l) l(remainder);
  else pending = remainder;
}

/** A page's conversation is mounted: the corner Orb stays out of the wake and its phase. */
export const pageHasWake = () => page !== null;

/**
 * A voice session receives device wakes. By priority, not mount order: the corner Orb
 * (`fallback`) never takes a wake from the page's own conversation, even while it animates out.
 */
export function onDeviceWake(listener: WakeListener, fallback = false): () => void {
  if (fallback) corner = listener;
  else page = listener;
  if (pending !== null) {
    const r = pending;
    pending = null;
    (page ?? corner)?.(r);
  }
  return () => {
    if (page === listener) page = null;
    if (corner === listener) corner = null;
  };
}

const endListeners = new Set<() => void>();

/** The device asks the session to end (the corner Orb was tapped). */
export function requestVoiceEnd() {
  for (const l of endListeners) l();
}

export function onVoiceEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => void endListeners.delete(listener);
}

type PhaseListener = (phase: VoicePhase) => void;
const phaseListeners = new Set<PhaseListener>();
let lastPhase: VoicePhase = "idle";

/** The session's phase, for the device: it listens for the word only while nobody talks. */
export function publishVoicePhase(phase: VoicePhase) {
  if (phase === lastPhase) return;
  lastPhase = phase;
  for (const l of phaseListeners) l(phase);
}

export function onVoicePhase(listener: PhaseListener): () => void {
  phaseListeners.add(listener);
  listener(lastPhase);
  return () => void phaseListeners.delete(listener);
}

/**
 * ADR-104: what the device's own capture is doing before the session takes over — "listening"
 * from the moment it heard "ELISE" while the person keeps talking, "thinking" while it transcribes
 * — so the page's Orb reacts at once instead of staying idle for those seconds.
 */
export type DeviceCapture = "listening" | "thinking" | null;
let capture: DeviceCapture = null;
const captureListeners = new Set<() => void>();

export function publishDeviceCapture(next: DeviceCapture) {
  if (next === capture) return;
  capture = next;
  captureListeners.forEach((l) => l());
}

export function useDeviceCapture(): DeviceCapture {
  return useSyncExternalStore(
    (l) => (captureListeners.add(l), () => void captureListeners.delete(l)),
    () => capture,
    () => null,
  );
}

/** Phases where the device may hold the microphone for the wake word. */
export const deviceMayListen = (phase: VoicePhase) =>
  phase === "idle" || phase === "sleeping" || phase === "error" || phase === "offline";
