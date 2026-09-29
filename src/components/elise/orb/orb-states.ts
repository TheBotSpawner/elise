/**
 * Visual language of each Orb state (docs/product/05 §8). Motion communicates state; states
 * also differ in shape (ring style), so meaning never depends on color alone.
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

export interface OrbStateStyle {
  /** Core color (CSS variable). */
  color: string;
  /** Seconds per breathing cycle of the core. */
  breath: number;
  /** Core scale amplitude while breathing. */
  amplitude: number;
  /** Seconds between emitted waves; null = no waves. */
  waveEvery: number | null;
  /** Seconds per blob morph cycle (organic deformation). */
  morph: number;
  ring: "none" | "steady" | "orbit" | "dashed";
}

export const ORB_STYLES: Record<OrbState, OrbStateStyle> = {
  idle: {
    color: "var(--accent)",
    breath: 5,
    amplitude: 0.03,
    waveEvery: 4.5,
    morph: 12,
    ring: "none",
  },
  listening: {
    color: "var(--accent)",
    breath: 1.6,
    amplitude: 0.08,
    waveEvery: 1.2,
    morph: 5,
    ring: "steady",
  },
  thinking: {
    color: "var(--accent-2)",
    breath: 2.4,
    amplitude: 0.05,
    waveEvery: 1.8,
    morph: 3.5,
    ring: "orbit",
  },
  speaking: {
    color: "var(--accent)",
    breath: 0.9,
    amplitude: 0.09,
    waveEvery: 0.9,
    morph: 4,
    ring: "none",
  },
  executing: {
    color: "var(--accent)",
    breath: 1.8,
    amplitude: 0.04,
    waveEvery: 1.4,
    morph: 6,
    ring: "orbit",
  },
  waiting_approval: {
    color: "var(--warning)",
    breath: 3.5,
    amplitude: 0.02,
    waveEvery: null,
    morph: 14,
    ring: "steady",
  },
  success: {
    color: "var(--success)",
    breath: 3,
    amplitude: 0.03,
    waveEvery: 2.5,
    morph: 10,
    ring: "none",
  },
  error: {
    color: "var(--danger)",
    breath: 4,
    amplitude: 0.02,
    waveEvery: null,
    morph: 16,
    ring: "dashed",
  },
};
