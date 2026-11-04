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
  /** Core → sphere → arcs → the S → idle. */
  durationMs: 2600,
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
  /** ms into the sequence. */
  t: number;
}

/**
 * Where the sequence is `elapsed` ms in; null once it's over (the Orb is simply idle). The renderer
 * draws it: the core, then the sphere, the arcs and last the S.
 */
export function bootFrame(elapsed: number, reduced: boolean): BootFrame | null {
  return elapsed >= (reduced ? BOOT.reducedMs : BOOT.durationMs) ? null : { t: elapsed };
}
