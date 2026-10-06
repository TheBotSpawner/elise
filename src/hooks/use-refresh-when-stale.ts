"use client";

import { useEffect, useRef } from "react";

/**
 * Freshness for data whose source of truth is elsewhere (Google Tasks, ADR-046): Google offers
 * no push notifications for Tasks, so correctness comes from reading again when the data is
 * about to be trusted — never from polling every few seconds.
 *
 *   on open        a snapshot older than `staleAfterMs` (e.g. served by the router cache when
 *                  coming back) is refreshed at once; a fresh server render is not;
 *   on return      focusing the tab/window again after that long refreshes it.
 */
export const FRESHNESS = { staleAfterMs: 30_000 } as const;

export function isStale(
  fetchedAt: number,
  now: number,
  staleAfterMs: number = FRESHNESS.staleAfterMs,
) {
  return !Number.isFinite(fetchedAt) || now - fetchedAt > staleAfterMs;
}

export function useRefreshWhenStale(
  fetchedAt: string | number | null,
  refresh: () => void,
  staleAfterMs: number = FRESHNESS.staleAfterMs,
) {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (fetchedAt === null) return;
    const at = typeof fetchedAt === "number" ? fetchedAt : Date.parse(fetchedAt);
    // One refresh per snapshot: the new render brings a new fetchedAt.
    let asked = false;
    const check = () => {
      if (asked || document.visibilityState !== "visible") return;
      if (!isStale(at, Date.now(), staleAfterMs)) return;
      asked = true;
      latest.current();
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [fetchedAt, staleAfterMs]);
}
