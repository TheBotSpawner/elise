"use client";

import { useSyncExternalStore } from "react";

import type {
  Alarm,
  AlarmDestination,
  AlarmOccurrence,
  DestinationStatus,
  SoundOption,
} from "@/core/timers/alarms";
import type { TimePreferences } from "@/core/timers/model";

/**
 * The alarms this person has, what rings now, their devices and sounds (ADR-100) — one client
 * store that follows the server (Realtime triggers a reload; nothing is counted here).
 */
export interface AlarmsState {
  loaded: boolean;
  alarms: Alarm[];
  live: AlarmOccurrence[];
  destinations: DestinationStatus[];
  sounds: SoundOption[];
  prefs: TimePreferences | null;
  timezone: string;
  /** This device, when it is an alarm destination. */
  me: AlarmDestination | null;
}

let state: AlarmsState = {
  loaded: false,
  alarms: [],
  live: [],
  destinations: [],
  sounds: [],
  prefs: null,
  timezone: "UTC",
  me: null,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<AlarmsState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const alarmsStore = {
  get: () => state,
  set,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export function useAlarms() {
  return useSyncExternalStore(alarmsStore.subscribe, alarmsStore.get, alarmsStore.get);
}

export async function loadAlarms(): Promise<boolean> {
  const r = await fetch("/api/time/alarms", { cache: "no-store" }).catch(() => null);
  if (!r?.ok) return false;
  const d = (await r.json()) as Omit<AlarmsState, "loaded" | "me">;
  set({ ...d, loaded: true });
  return true;
}

export async function alarmOp<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/time/alarms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(data.error?.message || "Request failed");
  return data;
}

// ── This device ─────────────────────────────────────────────────────────────

const BROWSER_KEY = "elise.alarmBrowser";

export function browserEndpoint(): string | null {
  try {
    return window.localStorage.getItem(BROWSER_KEY);
  } catch {
    return null;
  }
}

/** Which destination this runtime is: its Desktop installation, or the browser the user chose. */
export async function resolveMe(): Promise<AlarmDestination | null> {
  const bridge = (
    window as { eliseDesktop?: { getDesktopInfo?: () => Promise<{ installationId: string }> } }
  ).eliseDesktop;
  if (bridge?.getDesktopInfo) {
    const info = await bridge.getDesktopInfo().catch(() => null);
    return info ? { kind: "desktop", id: info.installationId } : null;
  }
  const id = browserEndpoint();
  return id ? { kind: "browser", id } : null;
}

function browserName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Navegador";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS/.test(ua)
      ? "Mac"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} · ${os}` : browser;
}

/**
 * The user chose this browser for alarms (their explicit action): it gets an id it keeps, and
 * becomes a default destination if there was none yet.
 */
export async function chooseThisBrowser() {
  const id = browserEndpoint() ?? crypto.randomUUID();
  await alarmOp({ op: "registerBrowser", endpointId: id, name: browserName() });
  try {
    window.localStorage.setItem(BROWSER_KEY, id);
  } catch {
    // Not kept: it registers again next time.
  }
  const prefs = state.prefs;
  if (prefs && !prefs.alarmDestinations.length)
    await alarmOp({ op: "defaultDestinations", destinations: [{ kind: "browser", id }] });
  set({ me: { kind: "browser", id } });
  await loadAlarms();
}

export async function stopUsingThisBrowser() {
  const id = browserEndpoint();
  if (!id) return;
  await alarmOp({ op: "revokeBrowser", endpointId: id });
  try {
    window.localStorage.removeItem(BROWSER_KEY);
  } catch {
    // Nothing kept.
  }
  set({ me: null });
  await loadAlarms();
}

export const targets = (o: { destinations: AlarmDestination[] }, me: AlarmDestination | null) =>
  !!me && o.destinations.some((d) => d.kind === me.kind && d.id === me.id);
