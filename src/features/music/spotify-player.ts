"use client";

import { musicStore } from "./store";

/**
 * ELISE as a Spotify Connect device in this browser (Spotify Web Playback SDK, ADR-042). It
 * appears in the user's device list as "ELISE"; the Web API plays on it like on any device.
 * Requires Premium (the SDK reports account_error otherwise — then ELISE simply controls the
 * user's other devices). The token comes from ELISE's server, short-lived, never the refresh
 * token. Browsers need a tap before audio: `activate()` runs on the first interaction.
 */

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (arg: never) => void): boolean;
  getVolume(): Promise<number>;
  setVolume(v: number): Promise<void>;
  activateElement?(): Promise<void>;
}

declare global {
  interface Window {
    Spotify?: {
      Player: new (o: {
        name: string;
        getOAuthToken: (cb: (token: string) => void) => void;
        volume?: number;
      }) => SpotifyPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let started = false;
let player: SpotifyPlayer | null = null;
let available = true;

async function token(): Promise<string | null> {
  const res = await fetch("/api/music/token", { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  return ((await res.json()) as { token: string }).token;
}

function load(): Promise<void> {
  if (window.Spotify?.Player) return Promise.resolve();
  return new Promise((resolve) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    document.head.appendChild(s);
  });
}

/** Starts ELISE's Spotify device once per page (only for a connected Spotify account). */
export async function startSpotifyPlayer(name = "ELISE") {
  if (started || !available) return;
  started = true;
  await load();
  const p = new window.Spotify!.Player({
    name,
    getOAuthToken: (cb) => void token().then((t) => t && cb(t)),
    volume: 0.7,
  });
  p.addListener("ready", ({ device_id }: { device_id: string }) =>
    musicStore.set({ browserDevice: device_id }),
  );
  p.addListener("not_ready", () => musicStore.set({ browserDevice: null }));
  // Not Premium, or blocked by the browser: ELISE keeps controlling other devices.
  for (const e of ["account_error", "initialization_error", "authentication_error"])
    p.addListener(e, () => {
      available = false;
      musicStore.set({ browserDevice: null });
    });
  p.addListener("autoplay_failed", () => musicStore.set({ autoplayBlocked: true }));
  p.addListener(
    "player_state_changed",
    (s: { paused: boolean; position: number; duration: number } | null) => {
      if (!s) return;
      // Precise local state between polls (the canonical read still comes from the Web API).
      musicStore.patchPlayback({
        playing: !s.paused,
        progressMs: Math.round(s.position),
        durationMs: Math.round(s.duration),
      });
      if (!s.paused) musicStore.set({ autoplayBlocked: false });
    },
  );
  player = p;
  await p.connect();
  // The first tap anywhere unlocks audio for this page (mobile browsers need it).
  const unlock = () => void player?.activateElement?.();
  window.addEventListener("pointerdown", unlock, { once: true });
}

/** Ducking on ELISE's own device: precise and local. */
export async function spotifyLocalVolume(): Promise<number | null> {
  return player ? Math.round((await player.getVolume()) * 100) : null;
}

export async function setSpotifyLocalVolume(percent: number) {
  await player?.setVolume(percent / 100);
}

export function stopSpotifyPlayer() {
  player?.disconnect();
  player = null;
  started = false;
}
