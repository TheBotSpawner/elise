"use client";

import type { ToolDisplay } from "@/core/agents/tools";
import { duckedVolume, type MusicCommand } from "@/core/capabilities/music";

import { musicAction } from "./actions";
import { setSpotifyLocalVolume, spotifyLocalVolume, startSpotifyPlayer } from "./spotify-player";
import { musicStore } from "./store";
import { applyYouTube, setYouTubeVolume, youTubeVolume } from "./youtube-player";

/**
 * The page's music controller (ADR-042): applies what music tools returned (from the
 * conversation or from a button), follows the provider by polling, and ducks while ELISE
 * speaks. One state (musicStore), one path for changes (the canonical tools).
 */

type MusicDisplay = Extract<ToolDisplay, { kind: "music" }>;
export type MusicOp = "pause" | "resume" | "next" | "previous" | "seek" | "setVolume" | "transfer";

/** A music tool's result: an embedded command runs here; a remote state becomes the state. */
export async function receiveMusic(display: MusicDisplay) {
  const p = display.music;
  if (p.provider === "youtube") {
    if (display.command) await applyYouTube(display.command, p.video ?? false);
    if (p.results || p.devices)
      musicStore.patchPlayback({ results: p.results, devices: p.devices });
    return;
  }
  const current = musicStore.get().payload;
  musicStore.setPayload({
    ...p,
    // A later poll keeps the choices a search or device list showed.
    results: p.results ?? (current?.provider === p.provider ? current.results : undefined),
  });
  if (p.provider === "spotify") void startSpotifyPlayer();
  pollSoon();
}

const COMMANDS: Partial<Record<MusicOp, (args: Record<string, unknown>) => MusicCommand>> = {
  pause: () => ({ action: "pause" }),
  resume: () => ({ action: "resume" }),
  next: () => ({ action: "next" }),
  previous: () => ({ action: "previous" }),
  seek: (a) => ({ action: "seek", ms: Number(a.ms ?? 0) }),
  setVolume: (a) => ({ action: "volume", percent: Number(a.percent ?? 50) }),
};

/**
 * A button on the Music Surface or the mini-player. The embedded player is the state, so it
 * acts locally; a remote provider goes through the canonical tool (user_ui origin).
 */
export async function controlMusic(op: MusicOp, args: Record<string, unknown> = {}) {
  const p = musicStore.get().payload;
  if (p?.provider === "youtube") {
    const command = COMMANDS[op]?.(args);
    if (command) await applyYouTube(command);
    return { ok: true as const };
  }
  // Optimistic: the button answers at once; the provider's state confirms it.
  if (op === "pause" || op === "resume") musicStore.patchPlayback({ playing: op === "resume" });
  const r = await musicAction(op, args);
  if (r.ok && r.display) await receiveMusic(r.display);
  if (!r.ok) pollSoon();
  return r;
}

export async function listMusicDevices() {
  const r = await musicAction("listDevices");
  if (r.ok && r.display) await receiveMusic(r.display);
  return r;
}

// ── Following the provider (changes made in its own app) ─────────────────────

let timer = 0;
let polling = false;
let stopped = false;

async function poll() {
  window.clearTimeout(timer);
  if (stopped) return;
  const res = await fetch("/api/music/playback", { cache: "no-store" }).catch(() => null);
  if (res?.status === 204 || res?.status === 401) {
    // No remote music provider: nothing to follow until a music tool runs.
    polling = false;
    return;
  }
  if (res?.ok) {
    const body = (await res.json()) as { provider: string; payload: MusicDisplay["music"] | null };
    const current = musicStore.get();
    if (body.payload && current.payload?.provider !== "youtube") {
      const ducking = current.ducked !== null;
      musicStore.setPayload({
        ...body.payload,
        results: current.payload?.results,
        devices: current.payload?.devices,
        // While ducked, the user's volume is the one to show.
        ...(ducking ? { volume: current.ducked!.restore } : {}),
      });
    }
    if (body.provider === "spotify") void startSpotifyPlayer();
  }
  const playing = musicStore.get().payload?.playing ?? false;
  const visible = document.visibilityState === "visible";
  timer = window.setTimeout(poll, visible ? (playing ? 4_000 : 12_000) : 30_000);
}

/** Starts following once per page (the shell mounts it). */
export function startMusicPolling() {
  stopped = false;
  if (polling) return;
  polling = true;
  void poll();
}

export function stopMusicPolling() {
  stopped = true;
  polling = false;
  window.clearTimeout(timer);
}

/** After a change: read the provider's state again shortly (it applies commands async). */
export function pollSoon() {
  polling = true;
  stopped = false;
  window.clearTimeout(timer);
  timer = window.setTimeout(poll, 1_200);
}

// ── Ducking while ELISE speaks (ADR-042 §J) ──────────────────────────────────

const DUCK_PREF = "elise.music.duck";

export function duckingEnabled(): boolean {
  try {
    return window.localStorage.getItem(DUCK_PREF) !== "0";
  } catch {
    return true;
  }
}

export function setDuckingEnabled(on: boolean) {
  try {
    window.localStorage.setItem(DUCK_PREF, on ? "1" : "0");
  } catch {
    // Storage unavailable: the default (on) stays.
  }
}

let ducking: Promise<void> = Promise.resolve();

/**
 * Lowers the music while ELISE speaks and restores exactly the previous volume after. Only
 * where the volume can be set precisely (the embedded player, ELISE's own Spotify device, or a
 * remote device that supports volume); otherwise nothing is done — never faked.
 */
export function duckMusic(on: boolean) {
  ducking = ducking.then(() => applyDuck(on)).catch(() => undefined);
  return ducking;
}

async function applyDuck(on: boolean) {
  const s = musicStore.get();
  const p = s.payload;
  if (on) {
    if (s.ducked || !p?.playing || !duckingEnabled()) return;
    if (p.provider === "youtube") {
      const v = youTubeVolume();
      const target = duckedVolume(v, true);
      if (target === null || v === null) return;
      setYouTubeVolume(target);
      musicStore.set({ ducked: { restore: v } });
      return;
    }
    if (p.provider === "spotify" && s.browserDevice && p.device?.id === s.browserDevice) {
      const v = await spotifyLocalVolume();
      const target = duckedVolume(v, true);
      if (target === null || v === null) return;
      await setSpotifyLocalVolume(target);
      musicStore.set({ ducked: { restore: v } });
      return;
    }
    const target = duckedVolume(p.volume, Boolean(p.device?.supportsVolume));
    if (target === null || p.volume === null) return;
    musicStore.set({ ducked: { restore: p.volume } });
    await musicAction("setVolume", { percent: target });
    return;
  }
  if (!s.ducked) return;
  const restore = s.ducked.restore;
  musicStore.set({ ducked: null });
  if (p?.provider === "youtube") return setYouTubeVolume(restore);
  if (p?.provider === "spotify" && s.browserDevice && p.device?.id === s.browserDevice)
    return setSpotifyLocalVolume(restore);
  await musicAction("setVolume", { percent: restore });
}
