"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { HomeAmbient } from "./chat-surface";

/**
 * Home's ambient items (Morning Brief, Continuar, Vencidas…) shared with the phone header
 * (ADR-077): on phones they live behind a bell next to the profile, not under the Orb. Home
 * publishes them while it's on screen; elsewhere there is nothing to show.
 */
let current: HomeAmbient | null = null;
const listeners = new Set<() => void>();

function publish(value: HomeAmbient | null) {
  current = value;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useHomeNotices(): HomeAmbient | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Home: keep the header's bell in step with what Home knows. */
export function usePublishHomeNotices(ambient: HomeAmbient | undefined) {
  useEffect(() => {
    publish(ambient ?? null);
    return () => publish(null);
  }, [ambient]);
}

/** How many things the bell has (the unread brief counts as one). */
export function noticeCount(a: HomeAmbient | null): number {
  if (!a) return 0;
  return (
    (a.brief && !a.brief.read ? 1 : 0) +
    (a.resume ? 1 : 0) +
    (a.dueToday > 0 ? 1 : 0) +
    (a.overdue > 0 ? 1 : 0) +
    (a.pendingApprovals > 0 ? 1 : 0)
  );
}
