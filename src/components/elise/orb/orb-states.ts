import type { VoicePhase } from "@/core/voice/session";

/**
 * ELISE Orb states (docs/product/05 §8). Motion carries the state; colour only confirms it.
 */
export const ORB_STATES = [
  "idle",
  "listening",
  "user_speaking",
  "thinking",
  "searching",
  "speaking",
  "executing",
  "waiting_approval",
  "success",
  "attention",
  "error",
  "sleeping",
] as const;

export type OrbState = (typeof ORB_STATES)[number];

/**
 * When several signals are active, the Orb shows the most important one (motion spec):
 * approval › the user speaking › listening › speaking › executing › searching › thinking ›
 * error › attention › success › sleeping › idle.
 */
const PRIORITY: readonly OrbState[] = [
  "waiting_approval",
  "user_speaking",
  "listening",
  "speaking",
  "executing",
  "searching",
  "thinking",
  "error",
  "attention",
  "success",
  "sleeping",
  "idle",
];

export function resolveOrbState(active: readonly OrbState[]): OrbState {
  return PRIORITY.find((s) => active.includes(s)) ?? "idle";
}

/** What a voice session's phase shows on the Orb (none: the chat's own state decides). */
export function voicePhaseOrb(phase: VoicePhase): OrbState[] {
  switch (phase) {
    case "user_speaking":
      return ["user_speaking"];
    case "listening":
    case "interrupted":
    case "arming":
      return ["listening"];
    case "speaking":
    case "executing":
    case "waiting_approval":
    case "sleeping":
      return [phase];
    case "finalizing_input":
    case "thinking":
      return ["thinking"];
    case "offline":
      return ["attention"];
    default:
      return [];
  }
}
