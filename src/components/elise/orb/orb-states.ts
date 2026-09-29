import type { RendererState } from "./orb-renderer";

/**
 * ELISE Orb states (docs/product/05 §8). Motion carries the state; colour only confirms it.
 * `waiting_approval` is the product name for the reference renderer's `approval` state.
 */
export const ORB_STATES = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "executing",
  "waiting_approval",
  "success",
  "error",
] as const;

export type OrbState = (typeof ORB_STATES)[number];

export function toRendererState(state: OrbState): RendererState {
  return state === "waiting_approval" ? "approval" : state;
}

/**
 * When several signals are active, the Orb shows the most important one
 * (motion spec): approval › listening › speaking › executing › thinking › error › success › idle.
 */
const PRIORITY: readonly OrbState[] = [
  "waiting_approval",
  "listening",
  "speaking",
  "executing",
  "thinking",
  "error",
  "success",
  "idle",
];

export function resolveOrbState(active: readonly OrbState[]): OrbState {
  return PRIORITY.find((s) => active.includes(s)) ?? "idle";
}
