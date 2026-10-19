"use client";

import { createContext, useContext } from "react";

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
let wakeListener: WakeListener | null = null;

/** The device heard the word: the session picks it up now, or as soon as it mounts. */
export function requestDeviceWake(remainder: string) {
  if (wakeListener) wakeListener(remainder);
  else pending = remainder;
}

/** The voice session (one at a time) receives device wakes. */
export function onDeviceWake(listener: WakeListener): () => void {
  wakeListener = listener;
  if (pending !== null) {
    const r = pending;
    pending = null;
    listener(r);
  }
  return () => {
    if (wakeListener === listener) wakeListener = null;
  };
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

/** Phases where the device may hold the microphone for the wake word. */
export const deviceMayListen = (phase: VoicePhase) =>
  phase === "idle" || phase === "sleeping" || phase === "error" || phase === "offline";
