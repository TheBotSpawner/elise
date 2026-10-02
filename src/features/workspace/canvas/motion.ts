/**
 * Live Canvas motion tokens (ADR-021, docs/product/05 §34). One place for durations and curves;
 * components never invent their own. Motion only marks a change: arrival, focus, reflow,
 * leaving. Nothing loops except the Orb and genuine "in progress" indicators.
 */

export const EASE = [0.22, 1, 0.36, 1] as const;
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

export const DUR = { xs: 0.12, sm: 0.2, md: 0.28, lg: 0.48 } as const;

/** Surfaces moving between zones (Spatial → Focus and back): one shared transition. */
export const REFLOW = { duration: 0.42, ease: EASE } as const;

export const ORB_MOVE = { duration: DUR.lg, ease: EASE } as const;

export function surfaceMotion(reduced: boolean) {
  return reduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: DUR.xs } },
        transition: { duration: DUR.sm },
      }
    : {
        initial: { opacity: 0, y: 12, scale: 0.985 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, scale: 0.985, transition: { duration: 0.16, ease: EASE_EXIT } },
        transition: { duration: DUR.md, ease: EASE, layout: REFLOW },
      };
}

/** Charts draw in once (lines trace, bars rise); never on every update. */
export const CHART_IN = { duration: 0.6, ease: EASE } as const;
