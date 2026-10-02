import type { RendererState } from "./orb-renderer";

/**
 * ELISE Orb states (docs/product/05 §8, Live Canvas v2). Motion carries the state; colour only
 * confirms it. Product names map 1:1 onto the reference renderer's states.
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

const RENDERER: Record<OrbState, RendererState> = {
  idle: "idle",
  listening: "listening",
  user_speaking: "userSpeaking",
  thinking: "thinking",
  searching: "searching",
  speaking: "speaking",
  executing: "executing",
  waiting_approval: "approval",
  success: "success",
  attention: "attention",
  error: "error",
  sleeping: "sleeping",
};

export function toRendererState(state: OrbState): RendererState {
  return RENDERER[state];
}

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
