"use client";

import type { MusicCommand, MusicItem } from "@/core/capabilities/music";
import { MUSIC_FEATURES } from "@/core/capabilities/music";
import type { MusicPayload } from "@/core/workspace/music";

import { musicStore } from "./store";

/**
 * YouTube playback through the official IFrame Player API (ADR-042). The player is always
 * visible while it plays (YouTube forbids background or audio-only players): ELISE shows it in
 * a small floating frame that stays on screen across pages, and closing it stops playback.
 * ELISE plays a controlled queue (the matching videos), so next/previous work.
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
          height: string;
          width: string;
          playerVars: Record<string, number | string>;
          events: Record<string, (e: { data: number; target: YTPlayer }) => void>;
        },
      ) => YTPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const PLAYING = 1;
const PAUSED = 2;
const ENDED = 0;

let api: Promise<void> | null = null;
let player: YTPlayer | null = null;
let ready: Promise<YTPlayer> | null = null;
let queue: MusicItem[] = [];
let index = 0;
let host: HTMLElement | null = null;
let ticker = 0;

function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  api ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    document.head.appendChild(s);
  });
  return api;
}

/** The floating frame registers its container here (one per page). */
export function setYouTubeHost(el: HTMLElement | null) {
  host = el;
}

const idOf = (ref: string) => ref.split(":").at(-1) ?? ref;

function publish(p: YTPlayer, playing: boolean) {
  const item = queue[index] ?? null;
  const data = p.getVideoData?.();
  const payload: MusicPayload = {
    provider: "youtube",
    playing,
    item: item
      ? {
          ...item,
          title: item.kind === "playlist" && data?.title ? data.title : item.title,
          durationMs: Math.round((p.getDuration() || 0) * 1000) || item.durationMs,
        }
      : null,
    context:
      item?.kind === "playlist" ? { kind: "playlist", title: item.title, ref: item.ref } : null,
    progressMs: Math.round((p.getCurrentTime() || 0) * 1000),
    durationMs: Math.round((p.getDuration() || 0) * 1000),
    device: null,
    volume: p.getVolume?.() ?? null,
    at: new Date().toISOString(),
    video: musicStore.get().payload?.video ?? false,
    features: MUSIC_FEATURES.filter((f) =>
      ["search", "embedded_playback", "volume", "seek", "queue"].includes(f),
    ),
    queue,
    index,
  };
  musicStore.setPayload(payload);
}

function ensurePlayer(): Promise<YTPlayer> {
  if (ready) return ready;
  ready = loadApi().then(
    () =>
      new Promise<YTPlayer>((resolve) => {
        if (!host) throw new Error("No YouTube host on this page");
        const el = document.createElement("div");
        host.replaceChildren(el);
        const p = new window.YT!.Player(el, {
          height: "100%",
          width: "100%",
          // Autoplay may be blocked until the user taps: then the frame's own play button works.
          playerVars: { playsinline: 1, autoplay: 1, rel: 0 },
          events: {
            onReady: () => resolve(p),
            onStateChange: (e) => {
              if (e.data === ENDED && index < queue.length - 1) return void playIndex(index + 1);
              if (e.data === PLAYING) musicStore.set({ autoplayBlocked: false });
              publish(e.target, e.data === PLAYING);
            },
            onAutoplayBlocked: () => musicStore.set({ autoplayBlocked: true }),
            onError: () => {
              // An unembeddable or removed video: skip it.
              if (index < queue.length - 1) void playIndex(index + 1);
            },
          },
        });
        player = p;
        window.clearInterval(ticker);
        ticker = window.setInterval(() => {
          if (player && player.getPlayerState() === PLAYING) publish(player, true);
        }, 5_000);
      }),
  );
  return ready;
}

async function playIndex(i: number) {
  const p = await ensurePlayer();
  index = Math.max(0, Math.min(i, queue.length - 1));
  const item = queue[index];
  if (!item) return;
  if (item.kind === "playlist")
    p.loadPlaylist({ list: idOf(item.ref), listType: "playlist", index: 0 });
  else p.loadVideoById(idOf(item.ref));
}

/** Executes a command a music tool returned for the embedded player. */
export async function applyYouTube(command: MusicCommand, video = false) {
  if (command.action === "load") {
    queue = command.items;
    musicStore.patchPlayback({ video: command.video || video });
    if (!musicStore.get().payload)
      musicStore.setPayload({
        provider: "youtube",
        playing: false,
        item: command.items[command.index] ?? null,
        context: null,
        progressMs: 0,
        durationMs: 0,
        device: null,
        volume: null,
        at: new Date().toISOString(),
        video: command.video || video,
        features: ["search", "embedded_playback", "volume", "seek", "queue"],
      });
    return playIndex(command.index);
  }
  const p = await ensurePlayer();
  switch (command.action) {
    case "pause":
      p.pauseVideo();
      break;
    case "resume":
      p.playVideo();
      break;
    case "next":
      if (queue[index]?.kind === "playlist") p.nextVideo();
      else await playIndex(index + 1);
      break;
    case "previous":
      if (queue[index]?.kind === "playlist") p.previousVideo();
      else if (p.getCurrentTime() > 5) p.seekTo(0, true);
      else await playIndex(index - 1);
      break;
    case "seek":
      p.seekTo(command.ms / 1000, true);
      break;
    case "volume":
      p.setVolume(command.percent);
      break;
  }
  publish(p, command.action === "pause" ? false : p.getPlayerState() === PLAYING);
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
  player?.stopVideo();
  player?.destroy();
  player = null;
  ready = null;
  queue = [];
  index = 0;
  window.clearInterval(ticker);
  musicStore.setPayload(null);
}

export const isYouTubeActive = () => player !== null;

/** Paused or playing right now, for the controls. */
export function youTubePlaying() {
  return player?.getPlayerState() === PLAYING;
}

export const YT_STATES = { PLAYING, PAUSED, ENDED };
