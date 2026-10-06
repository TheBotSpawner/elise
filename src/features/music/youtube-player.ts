"use client";

import type { MusicCommand, MusicItem, PlayerState } from "@/core/capabilities/music";
import type { MusicPayload } from "@/core/workspace/music";

import { musicStore } from "./store";

/**
 * YouTube playback through the official IFrame Player API (ADR-042, ADR-044).
 *
 * - Truth: the Music state says "playing" only when the YT.Player reports PLAYING. A load is
 *   "play_requested"; a browser refusal is "autoplay_blocked" (with a one-tap Play); buffering,
 *   paused, ended and errors are their own states. Progress comes from the player's clock.
 * - One player: created once per page and kept (track changes use loadVideoById), so the
 *   permission a first tap gives carries over to later voice-driven changes.
 * - Visible: the player is never hidden. It docks into the Music Surface's video slot when one
 *   is on screen and floats in a corner otherwise (≥ 200×200 px, YouTube's minimum), across pages.
 * - Recovery: a video that can't play here (removed, embedding disabled) is replaced by the next
 *   confident match the tool sent, automatically.
 */

interface YTPlayer {
  loadVideoById(id: string): void;
  loadPlaylist(o: { list: string; listType: "playlist"; index?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  getVolume(): number;
  isMuted(): boolean;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  nextVideo(): void;
  previousVideo(): void;
  getVideoData?(): { title?: string; author?: string; video_id?: string };
  destroy(): void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        o: {
          host?: string;
          height: string;
          width: string;
          playerVars: Record<string, number | string>;
          events: Record<string, (e: { data: number; target: YTPlayer }) => void>;
        },
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
    /** Music diagnostics for real-browser validation (ADR-044 §U): events, never content. */
    __eliseMusic?: { at: number; event: string; [k: string]: unknown }[];
  }
}

/** YT.PlayerState */
export const YT = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/** The API script plus the player's onReady: past this, loading failed (never "starting" forever). */
export const PLAYER_LOAD_TIMEOUT_MS = 10_000;

/** A load that hasn't started (nor been reported blocked) after this long is treated as blocked. */
export const AUTOPLAY_WATCHDOG_MS = 3_500;

/** What a player event means for ELISE's state. */
export function stateFromPlayer(code: number, current: PlayerState): PlayerState {
  switch (code) {
    case YT.PLAYING:
      return "playing";
    case YT.PAUSED:
      return "paused";
    case YT.BUFFERING:
      return "buffering";
    case YT.ENDED:
      return "ended";
    case YT.CUED:
      return "ready";
    case YT.UNSTARTED:
      // Unstarted after a load: still waiting for the player (or the browser) to start it.
      return current === "autoplay_blocked" ? current : "play_requested";
    default:
      return current;
  }
}

/** The player's error codes, in words (official IFrame API codes). */
export function playerErrorText(code: number, locale: "es" | "en"): string {
  const es = locale === "es";
  if (code === 100)
    return es
      ? "Ese video ya no está disponible (eliminado o privado)."
      : "That video is no longer available (removed or private).";
  if (code === 101 || code === 150 || code === 153)
    return es
      ? "Su dueño no permite reproducirlo fuera de YouTube."
      : "Its owner doesn't allow playing it outside YouTube.";
  if (code === 5)
    return es
      ? "El navegador no puede reproducir ese video."
      : "The browser can't play that video.";
  return es ? "YouTube no pudo reproducir ese video." : "YouTube couldn't play that video.";
}

let api: Promise<void> | null = null;
let player: YTPlayer | null = null;
let ready: Promise<YTPlayer> | null = null;
let queue: MusicItem[] = [];
let fallbacks: MusicItem[] = [];
let index = 0;
let host: HTMLElement | null = null;
let ticker = 0;
let watchdog = 0;
let state: PlayerState = "idle";
let loadedAt = 0;
let readyAt = 0;
let locale: "es" | "en" = "es";
/** The user asked to watch (a larger player) rather than just listen. */
let wantVideo = false;

export function trace(event: string, data: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  const log = (window.__eliseMusic ??= []);
  log.push({ at: Math.round(performance.now()), event, ...data });
  if (log.length > 200) log.splice(0, log.length - 200);
  let debug = process.env.NODE_ENV !== "production";
  try {
    debug ||= window.localStorage.getItem("elise.musicDebug") === "1";
  } catch {
    // Storage unavailable.
  }
  if (debug) console.info(`[music.youtube.player] ${event}`, data);
}

export function setYouTubeLocale(l: "es" | "en") {
  locale = l;
}

function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  api ??= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    // Blocked (CSP, an extension, offline): fail now instead of waiting forever.
    s.onerror = () => reject(new Error("The YouTube player script could not load"));
    document.head.appendChild(s);
  });
  api.catch(() => {
    api = null;
  });
  return api;
}

/** The floating frame registers its container here (one per page). */
export function setYouTubeHost(el: HTMLElement | null) {
  host = el;
}

const idOf = (ref: string) => ref.split(":").at(-1) ?? ref;

function publish(p: YTPlayer | null, next: PlayerState, notice: string | null = null) {
  state = next;
  const item = queue[index] ?? null;
  const data = p?.getVideoData?.();
  const duration = Math.round((p?.getDuration() || 0) * 1000);
  const payload: MusicPayload = {
    provider: "youtube",
    playing: next === "playing",
    state: next,
    item: item
      ? {
          ...item,
          title: item.kind === "playlist" && data?.title ? data.title : item.title,
          durationMs: duration || item.durationMs,
        }
      : null,
    context:
      item?.kind === "playlist" ? { kind: "playlist", title: item.title, ref: item.ref } : null,
    progressMs: Math.round((p?.getCurrentTime() || 0) * 1000),
    durationMs: duration || item?.durationMs || 0,
    device: null,
    volume: p ? p.getVolume() : null,
    at: new Date().toISOString(),
    video: wantVideo,
    features: ["search", "embedded_playback", "volume", "seek", "queue"],
    queue,
    index,
    notice,
  };
  musicStore.setPayload(payload);
  musicStore.set({ autoplayBlocked: next === "autoplay_blocked" });
}

function armWatchdog() {
  window.clearTimeout(watchdog);
  watchdog = window.setTimeout(() => {
    // Some browsers refuse silently: never leave "loading" looking like music.
    if (state === "play_requested" && player) {
      trace("autoplay_blocked", { via: "watchdog" });
      publish(player, "autoplay_blocked");
    }
  }, AUTOPLAY_WATCHDOG_MS);
}

function ensurePlayer(): Promise<YTPlayer> {
  if (ready) return ready;
  let timeout = 0;
  const limit = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(
      () => reject(new Error("The YouTube player did not get ready")),
      PLAYER_LOAD_TIMEOUT_MS,
    );
  });
  const startup = loadApi().then(
    () =>
      new Promise<YTPlayer>((resolve, reject) => {
        if (!host) return reject(new Error("No YouTube host on this page"));
        const el = document.createElement("div");
        host.replaceChildren(el);
        trace("create");
        const p = new window.YT!.Player(el, {
          host: "https://www.youtube-nocookie.com",
          height: "100%",
          width: "100%",
          // The API adds allow="autoplay" to the iframe; the browser still decides.
          playerVars: { playsinline: 1, autoplay: 1, rel: 0 },
          events: {
            onReady: () => {
              readyAt = performance.now();
              trace("ready");
              resolve(p);
            },
            onStateChange: (e) => {
              const next = stateFromPlayer(e.data, state);
              trace(next, {
                code: e.data,
                currentTime: Number((e.target.getCurrentTime() || 0).toFixed(1)),
                muted: e.target.isMuted(),
                volume: e.target.getVolume(),
                ...(next === "playing" && loadedAt
                  ? { load_to_playing_ms: Math.round(performance.now() - loadedAt) }
                  : {}),
              });
              if (next === "playing" || next === "paused" || next === "ended")
                window.clearTimeout(watchdog);
              if (e.data === YT.ENDED && index < queue.length - 1) return void playIndex(index + 1);
              publish(e.target, next);
            },
            onAutoplayBlocked: () => {
              window.clearTimeout(watchdog);
              trace("autoplay_blocked", { via: "event" });
              publish(p, "autoplay_blocked");
            },
            onError: (e) => {
              trace("error", { code: e.data });
              // Can't play here: the next confident match, without asking again.
              const next = fallbacks.shift();
              if (next) {
                trace("fallback", { remaining: fallbacks.length });
                queue[index] = next;
                return void playIndex(index);
              }
              publish(p, "error", playerErrorText(e.data, locale));
            },
          },
        });
        player = p;
        window.clearInterval(ticker);
        // Progress from the player's own clock, only while it really plays.
        ticker = window.setInterval(() => {
          if (player && player.getPlayerState() === YT.PLAYING) publish(player, "playing");
        }, 5_000);
      }),
  );
  ready = Promise.race([startup, limit]).finally(() => window.clearTimeout(timeout));
  ready.catch((error: unknown) => {
    trace("player_failed", { reason: error instanceof Error ? error.message : "unknown" });
    ready = null;
  });
  return ready;
}

async function playIndex(i: number) {
  index = Math.max(0, Math.min(i, queue.length - 1));
  const item = queue[index];
  if (!item) return;
  publish(player, player ? "play_requested" : "loading");
  let p: YTPlayer;
  try {
    p = await ensurePlayer();
  } catch {
    return publish(
      null,
      "error",
      locale === "es"
        ? "No pude cargar el reproductor de YouTube en esta página."
        : "The YouTube player couldn't load on this page.",
    );
  }
  loadedAt = performance.now();
  trace("load", {
    kind: item.kind,
    ...(readyAt ? { ready_ms: Math.round(loadedAt - readyAt) } : {}),
  });
  if (item.kind === "playlist")
    p.loadPlaylist({ list: idOf(item.ref), listType: "playlist", index: 0 });
  else p.loadVideoById(idOf(item.ref));
  publish(p, "play_requested");
  armWatchdog();
}

/** Executes a command a music tool returned for the embedded player. */
export async function applyYouTube(command: MusicCommand, video = false) {
  trace("command", { action: command.action });
  if (command.action === "load") {
    queue = [...command.items];
    fallbacks = [...(command.fallbacks ?? [])];
    wantVideo = command.video || video;
    return playIndex(command.index);
  }
  const p = await ensurePlayer();
  switch (command.action) {
    case "pause":
      p.pauseVideo();
      break;
    case "resume":
      p.playVideo();
      armWatchdog();
      break;
    case "next":
      if (queue[index]?.kind === "playlist") p.nextVideo();
      else if (index < queue.length - 1) await playIndex(index + 1);
      else
        publish(p, state, locale === "es" ? "No hay más en la cola." : "Nothing else is queued.");
      return;
    case "previous":
      if (queue[index]?.kind === "playlist") p.previousVideo();
      else if (p.getCurrentTime() > 5 || index === 0) p.seekTo(0, true);
      else await playIndex(index - 1);
      return;
    case "seek":
      p.seekTo(command.ms / 1000, true);
      break;
    case "volume":
      p.setVolume(command.percent);
      if (command.percent > 0 && p.isMuted()) p.unMute();
      break;
  }
  // State follows from the player's own events; volume and position are read now.
  publish(p, state);
}

/**
 * The Play button (a real tap): starts the player from a user gesture, which the browser
 * accepts where it refused autoplay. The same player keeps that permission for later tracks.
 */
export function playFromTap() {
  if (!player) return;
  trace("tap_play");
  if (player.isMuted()) player.unMute();
  player.playVideo();
  armWatchdog();
}

/** Ducking: the exact volume now (null before the player exists). */
export function youTubeVolume(): number | null {
  return player ? player.getVolume() : null;
}

export function setYouTubeVolume(v: number) {
  player?.setVolume(v);
}

/** Closing the frame stops playback (it never continues hidden). */
export function stopYouTube() {
  trace("closed");
  window.clearTimeout(watchdog);
  window.clearInterval(ticker);
  player?.stopVideo();
  player?.destroy();
  player = null;
  ready = null;
  queue = [];
  fallbacks = [];
  index = 0;
  state = "idle";
  musicStore.setPayload(null);
  musicStore.set({ autoplayBlocked: false });
}

export const isYouTubeActive = () => player !== null;

/** For tests: the module's player instance (one per page). */
export const currentYouTubePlayer = () => player;

/** Video slots in Music Surfaces: the floating frame docks onto the visible one. */
const slots = new Set<HTMLElement>();
export function registerYouTubeSlot(el: HTMLElement) {
  slots.add(el);
  return () => void slots.delete(el);
}

/**
 * Where the player should be: the first Music Surface slot that is on screen and big enough,
 * or null (float in a corner). Never zero-size or off-screen.
 */
export function visibleSlot(
  viewport = { w: window.innerWidth, h: window.innerHeight },
): DOMRect | null {
  for (const el of slots) {
    const r = el.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.right > 0 && r.top < viewport.h && r.left < viewport.w;
    if (onScreen && r.width >= 200 && r.height >= 200) return r;
  }
  return null;
}
