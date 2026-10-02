"use client";

import { useSyncExternalStore } from "react";

import { coarse, LOCATION_LIMITS, type LatLng } from "@/core/location/model";

/**
 * The position the user chose to share (ADR-023). Memory only — never storage, never sent
 * except with the user's own messages — coarse, and forgotten after a while or on reload.
 */
let shared: { at: number; position: LatLng } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function sharedLocation(): LatLng | null {
  if (shared && Date.now() - shared.at > LOCATION_LIMITS.sharedTtlMs) shared = null;
  return shared?.position ?? null;
}

export function stopSharing() {
  shared = null;
  emit();
}

export type LocateResult = "shared" | "denied" | "failed";

/** Asks the browser once, on the user's tap. */
export function shareLocation(): Promise<LocateResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve("failed");
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => {
        shared = {
          at: Date.now(),
          position: coarse({ lat: p.coords.latitude, lng: p.coords.longitude }),
        };
        emit();
        resolve("shared");
      },
      (e) => resolve(e.code === e.PERMISSION_DENIED ? "denied" : "failed"),
      // Coarse is enough (and it's rounded anyway); a recent fix is fine.
      { enableHighAccuracy: false, maximumAge: 5 * 60_000, timeout: 15_000 },
    ),
  );
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
