/**
 * Application boot (ADR-046, Parts W-Z): the Orb's startup sequence belongs to a cold entry into
 * ELISE, not to a route. Boot identity is this JavaScript document:
 *
 *   new tab / fresh app session    boots (module state starts empty)
 *   hard reload                    boots (a new document)
 *   client navigation, back, a remounted Home, a new chat, the Orb flying into the nav
 *                                  never boots again (module state survives them)
 *   entering on another route      no boot; later visits to Home don't replay it either
 *
 * A remount while the sequence is still playing (React Strict Mode, a quick re-render)
 * continues the same timeline instead of starting over.
 */

export const BOOT = {
  /** Point → wireframe → ring → idle. */
  durationMs: 1200,
  /** prefers-reduced-motion: a short fade/resolve instead of the assembly. */
  reducedMs: 350,
} as const;

let startedAt: number | null = null;
let skipped = false;

/**
 * The boot timeline for an Orb mounting now: `fresh` the first time in this document, a running
 * timeline for a remount during it, null once it's over (or when entry was elsewhere).
 */
export function claimBoot(now: number): { start: number; fresh: boolean } | null {
  if (startedAt === null) {
    if (skipped) return null;
    startedAt = now;
    return { start: now, fresh: true };
  }
  return now - startedAt < BOOT.durationMs ? { start: startedAt, fresh: false } : null;
}

/** The app was entered somewhere other than Home: this document has no boot sequence. */
export function skipBoot() {
  if (startedAt === null) skipped = true;
}

/** Tests only: a new document. */
export function resetBoot() {
  startedAt = null;
  skipped = false;
}

export interface BootFrame {
  /** The first cyan point (0..1 opacity). */
  dot: number;
  /** Wireframe lines resolving (0..1): opacity and radius. */
  wire: number;
  /** Outer ring and glow coming online (0..1). */
  ring: number;
}

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const between = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * Where the sequence is `elapsed` ms in; null once it's over (the Orb is simply idle).
 *   100-300 ms  a small cyan point appears
 *   300-850 ms  the wireframe resolves around it
 *   600-1050 ms the outer ring and glow come online
 *   ~1200 ms    settled
 */
export function bootFrame(elapsed: number, reduced: boolean): BootFrame | null {
  if (reduced) {
    if (elapsed >= BOOT.reducedMs) return null;
    const k = easeOut(between(elapsed, 0, BOOT.reducedMs));
    return { dot: 0, wire: k, ring: k };
  }
  if (elapsed >= BOOT.durationMs) return null;
  return {
    dot: between(elapsed, 100, 300) * (1 - between(elapsed, 550, 1000)),
    wire: easeOut(between(elapsed, 300, 850)),
    ring: easeOut(between(elapsed, 600, 1050)),
  };
}
