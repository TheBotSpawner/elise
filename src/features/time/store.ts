"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  DEFAULT_TIME_PREFERENCES,
  isActive,
  remainingMs,
  type TimePreferences,
} from "@/core/timers/model";
import { timerFromPayload, type TimerPayload } from "@/core/workspace/time";

/**
 * The page's view of the user's timers (ADR-045): loaded from the server, refreshed by Realtime
 * on every state change, counted down locally from timestamps. Never a source of truth: the
 * server's timer is. `offset` corrects this device's clock to the server's.
 */

interface TimeState {
  timers: TimerPayload[];
  prefs: TimePreferences;
  /** serverNow − Date.now(), measured on each load. */
  offset: number;
  /** The timer shown in the global Focus view, if any. */
  focusId: string | null;
  loaded: boolean;
}

let state: TimeState = {
  timers: [],
  prefs: DEFAULT_TIME_PREFERENCES,
  offset: 0,
  focusId: null,
  loaded: false,
};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const newer = (a: TimerPayload, b: TimerPayload | undefined) => !b || a.version >= b.version;

export const timeStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** A full load from the server (replaces the list). */
  load(timers: TimerPayload[], prefs: TimePreferences, serverNow: string) {
    state = {
      ...state,
      timers,
      prefs,
      offset: Date.parse(serverNow) - Date.now(),
      loaded: true,
    };
    emit();
  },
  /** One timer changed (a tool result, a button): newer versions win, order kept. */
  upsert(t: TimerPayload) {
    const old = state.timers.find((x) => x.id === t.id);
    if (!newer(t, old)) return;
    state = {
      ...state,
      timers: old ? state.timers.map((x) => (x.id === t.id ? t : x)) : [t, ...state.timers],
    };
    emit();
  },
  setPrefs(prefs: TimePreferences) {
    state = { ...state, prefs };
    emit();
  },
  focus(id: string | null) {
    state = { ...state, focusId: id };
    emit();
  },
  /** Now, on the server's clock. */
  now: () => new Date(Date.now() + state.offset),
};

const server = () => state;
export function useTime(): TimeState {
  return useSyncExternalStore(timeStore.subscribe, timeStore.get, server);
}

/** The live version of a timer (the store's, if it knows a newer one). */
export function useLiveTimer(p: TimerPayload): TimerPayload {
  const s = useTime();
  const live = s.timers.find((t) => t.id === p.id);
  return live && live.version >= p.version ? live : p;
}

/** Re-renders every second while `active` (the clock reads from timestamps, never counts). */
export function useTick(active: boolean): Date {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((n) => n + 1), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return timeStore.now();
}

export const activeTimers = (timers: readonly TimerPayload[]) => timers.filter(isActive);

/** The next to end first (running before paused). */
export function nearest(timers: readonly TimerPayload[], now: Date): TimerPayload | null {
  const active = activeTimers(timers);
  const left = (t: TimerPayload) =>
    t.kind === "stopwatch" || t.state === "paused"
      ? Number.MAX_SAFE_INTEGER
      : remainingMs(timerFromPayload(t), now);
  return [...active].sort((a, b) => left(a) - left(b))[0] ?? null;
}
