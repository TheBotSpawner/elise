"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { LOCATION_SIGNAL } from "@/core/agents/tool-selection";
import {
  coarse,
  DEVICE_LOCATION_LIMITS,
  deviceLocationPlan,
  LOCATION_LIMITS,
  usableDeviceLocation,
  type DeviceLocation,
  type DeviceLocationStatus,
  type LatLng,
} from "@/core/location/model";

/**
 * The device's position in the browser (ADR-023, ADR-028). One sample in memory — never
 * storage, never a history, never watched — coarse, and sent only with the user's own
 * messages. It exists after the user taps "Share my location", or on every location question
 * when they turned on "Use my current location" (a per-device preference; the browser keeps
 * the permission itself). getCurrentPosition only: nothing runs in the background.
 */

const PREF = "elise.location.device";

let sample: DeviceLocation | null = null;
/** Shared by a tap on a map: lasts the usual share window even with the setting off. */
let tapped = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const supported = () => typeof navigator !== "undefined" && "geolocation" in navigator;

export function deviceLocationEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) === "1";
  } catch {
    return false;
  }
}

export function setDeviceLocationEnabled(on: boolean) {
  try {
    if (on) localStorage.setItem(PREF, "1");
    else localStorage.removeItem(PREF);
  } catch {
    // Storage blocked: the setting lasts for this page only.
  }
  if (!on && !tapped) sample = null;
  emit();
}

/** The browser's permission, without prompting. */
export async function permissionStatus(): Promise<DeviceLocationStatus> {
  if (!supported()) return "unavailable";
  try {
    const p = await navigator.permissions.query({ name: "geolocation" });
    return p.state === "granted"
      ? "allowed"
      : p.state === "denied"
        ? "blocked"
        : "needs_permission";
  } catch {
    // Safari before 16 has no Permissions API for geolocation: asking is the only way to know.
    return "needs_permission";
  }
}

export type LocateResult = "shared" | "denied" | "failed";

/** One fix (prompts the first time). The coordinates are rounded before they're kept. */
function capture(timeout: number): Promise<LocateResult> {
  if (!supported()) return Promise.resolve("failed");
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const c = coarse({ lat: p.coords.latitude, lng: p.coords.longitude });
        sample = {
          status: "allowed",
          latitude: c.lat,
          longitude: c.lng,
          accuracyMeters: Math.round(p.coords.accuracy),
          capturedAt: Date.now(),
          source: "device",
        };
        emit();
        resolve("shared");
      },
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : "failed"),
      // Coarse is enough (it's rounded anyway); a fix up to a minute old is fine.
      { enableHighAccuracy: false, maximumAge: 60_000, timeout },
    ),
  );
}

/** The position to send with a message, if any (refreshed first for location questions). */
export async function locationForTurn(message: string): Promise<LatLng | null> {
  const enabled = deviceLocationEnabled();
  if (
    enabled &&
    deviceLocationPlan(sample, Date.now(), LOCATION_SIGNAL.test(message)) === "refresh"
  )
    await capture(DEVICE_LOCATION_LIMITS.captureTimeoutMs);
  return sharedLocation();
}

export function sharedLocation(): LatLng | null {
  if (!sample) return null;
  const ok = deviceLocationEnabled()
    ? usableDeviceLocation(sample, Date.now())
    : // A tap shares whatever the browser gave, for the usual window.
      tapped && Date.now() - sample.capturedAt <= LOCATION_LIMITS.sharedTtlMs;
  return ok ? { lat: sample.latitude, lng: sample.longitude } : null;
}

export function stopSharing() {
  tapped = false;
  sample = null;
  setDeviceLocationEnabled(false);
}

/** Asks the browser once, on the user's tap ("Share my location" on a map). */
export async function shareLocation(): Promise<LocateResult> {
  const result = await capture(15_000);
  if (result === "shared") tapped = true;
  emit();
  return result;
}

/** Turning the setting on asks the browser at once, so permission is settled up front. */
export async function enableDeviceLocation(): Promise<LocateResult> {
  setDeviceLocationEnabled(true);
  const result = await capture(15_000);
  if (result === "denied") setDeviceLocationEnabled(false);
  return result;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useSharedLocation(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sharedLocation() !== null,
    () => false,
  );
}

/** Settings: the preference, the browser's permission and the last fix's accuracy. */
export function useDeviceLocation() {
  const enabled = useSyncExternalStore(subscribe, deviceLocationEnabled, () => false);
  const accuracy = useSyncExternalStore(
    subscribe,
    () => sample?.accuracyMeters ?? null,
    () => null,
  );
  const [status, setStatus] = useState<DeviceLocationStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => void permissionStatus().then((s) => live && setStatus(s));
    read();
    const off = (() => {
      listeners.add(read);
      return () => void listeners.delete(read);
    })();
    return () => {
      live = false;
      off();
    };
  }, []);
  return { enabled, status, accuracy };
}
