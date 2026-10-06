"use client";

import type { Playback } from "@/core/capabilities/music";
import type { MusicPayload } from "@/core/workspace/music";

/**
 * The page's one canonical music state (ADR-042). The Music Surface, the mini-player and voice
 * ducking all read it; nothing keeps a second copy. It is fed by tool results (conversation),
 * provider polling (Spotify changed from its own app), and the browser players' own events
 * (Spotify Web Playback SDK, YouTube IFrame).
 */

export interface LiveMusic {
  payload: MusicPayload | null;
  /** When `payload.progressMs` was true (ms epoch): progress advances from here while playing. */
  at: number;
  /** The browser refused to start audio without a tap (autoplay policy). */
  autoplayBlocked: boolean;
  /** ELISE's own Spotify player in this page is ready (its device id). */
  browserDevice: string | null;
  /** Lowered while ELISE speaks: the volume to restore. */
  ducked: { restore: number } | null;
}

let state: LiveMusic = {
  payload: null,
  at: 0,
  autoplayBlocked: false,
  browserDevice: null,
  ducked: null,
};
const listeners = new Set<() => void>();

export const musicStore = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  set(patch: Partial<LiveMusic>) {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  },
  /** A fresh playback read (any source): progress counts from now. */
  setPayload(payload: MusicPayload | null, now = Date.now()) {
    musicStore.set({ payload, at: now });
  },
  /** Patch what is playing without losing the rest (features, devices, results). */
  patchPlayback(patch: Partial<MusicPayload>, now = Date.now()) {
    if (!state.payload) return;
    musicStore.set({ payload: { ...state.payload, ...patch }, at: now });
  },
};

/** Progress now, advancing from the last read while playing; never past the end. */
export function liveProgress(p: MusicPayload, at: number, now: number): number {
  const ms = p.playing ? p.progressMs + Math.max(0, now - at) : p.progressMs;
  return p.durationMs ? Math.min(ms, p.durationMs) : ms;
}

/**
 * What an embedded player is doing, for the next chat turn (only YouTube reads it): the
 * server can't see a player that lives in this page.
 */
export function embeddedSnapshot(now = Date.now()): Playback | null {
  const p = state.payload;
  if (!p || p.provider !== "youtube") return null;
  return {
    provider: p.provider,
    playing: p.playing,
    item: p.item,
    context: p.context,
    progressMs: Math.round(liveProgress(p, state.at, now)),
    durationMs: p.durationMs,
    device: p.device,
    volume: p.volume,
    at: new Date(now).toISOString(),
    ...(p.video !== undefined ? { video: p.video } : {}),
  };
}

export const formatTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
