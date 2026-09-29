"use client";

import { LayoutGroup } from "motion/react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import type { OrbState } from "./orb-states";

/**
 * One Elise, one Orb. The chat publishes the Orb's state here; the navigation shows the same
 * Orb in its brand slot once the hero Orb has "docked" (Home → Chat, motion spec).
 * The shared LayoutGroup lets the hero Orb fly into the nav slot (FLIP, 480 ms).
 */
interface OrbPresence {
  state: OrbState;
  docked: boolean;
  setState(state: OrbState): void;
  setDocked(docked: boolean): void;
}

const OrbPresenceContext = createContext<OrbPresence | null>(null);

export const ORB_LAYOUT_ID = "elise-orb";
export const ORB_FLIGHT = { duration: 0.48, ease: [0.22, 1, 0.36, 1] as const };

export function OrbPresenceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OrbState>("idle");
  const [docked, setDocked] = useState(false);
  const value = useMemo(() => ({ state, docked, setState, setDocked }), [state, docked]);
  return (
    <OrbPresenceContext.Provider value={value}>
      <LayoutGroup>{children}</LayoutGroup>
    </OrbPresenceContext.Provider>
  );
}

export function useOrbPresence(): OrbPresence {
  const value = useContext(OrbPresenceContext);
  if (!value) throw new Error("useOrbPresence must be used inside OrbPresenceProvider");
  return value;
}
