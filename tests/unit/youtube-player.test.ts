// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MusicItem } from "@/core/capabilities/music";

/** The real player decides (ADR-044): states only from its events, one persistent player. */

const {
  applyYouTube,
  playFromTap,
  setYouTubeHost,
  stopYouTube,
  stateFromPlayer,
  AUTOPLAY_WATCHDOG_MS,
  YT,
} = await import("@/features/music/youtube-player");
const { musicStore } = await import("@/features/music/store");

type Events = Record<string, (e: { data: number; target: unknown }) => void>;
let created = 0;
let events: Events = {};
const fake = {
  loaded: [] as string[],
  muted: true,
  t: 0,
  loadVideoById: vi.fn((id: string) => void fake.loaded.push(id)),
  loadPlaylist: vi.fn(),
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  stopVideo: vi.fn(),
  destroy: vi.fn(),
  seekTo: vi.fn(),
  setVolume: vi.fn(),
  getVolume: () => 80,
  isMuted: () => fake.muted,
  unMute: vi.fn(() => void (fake.muted = false)),
  getCurrentTime: () => fake.t,
  getDuration: () => 320,
  getPlayerState: () => -1,
  getVideoData: () => ({ title: "x" }),
  nextVideo: vi.fn(),
  previousVideo: vi.fn(),
};

const video = (id: string): MusicItem => ({
  ref: `yt:video:${id}`,
  kind: "video",
  title: id,
  subtitle: null,
  artwork: null,
  durationMs: null,
  url: null,
  provider: "youtube",
});

const emit = (name: string, data = 0) => events[name]!({ data, target: fake });
const state = () => musicStore.get().payload?.state;

beforeEach(() => {
  vi.useFakeTimers();
  created = 0;
  fake.loaded = [];
  fake.muted = true;
  window.YT = {
    Player: function (_el: HTMLElement, opts: { events: Events }) {
      created++;
      events = opts.events;
      queueMicrotask(() => opts.events.onReady!({ data: 0, target: fake }));
      return fake;
    },
  } as unknown as typeof window.YT;
  const host = document.createElement("div");
  document.body.append(host);
  setYouTubeHost(host);
});

afterEach(() => {
  stopYouTube();
  vi.useRealTimers();
});

describe("YouTube player state", () => {
  it("maps player codes; unstarted stays requested", () => {
    expect(stateFromPlayer(YT.PLAYING, "play_requested")).toBe("playing");
    expect(stateFromPlayer(YT.BUFFERING, "play_requested")).toBe("buffering");
    expect(stateFromPlayer(YT.UNSTARTED, "loading")).toBe("play_requested");
    expect(stateFromPlayer(YT.UNSTARTED, "autoplay_blocked")).toBe("autoplay_blocked");
  });

  it("requested is not playing until the player says so", async () => {
    await applyYouTube({ action: "load", items: [video("a")], index: 0, video: false });
    expect(state()).toBe("play_requested");
    expect(musicStore.get().payload?.playing).toBe(false);
    emit("onStateChange", YT.PLAYING);
    expect(state()).toBe("playing");
    expect(musicStore.get().payload?.playing).toBe(true);
  });

  it("autoplay blocked (event or silent watchdog) → one tap plays and unmutes", async () => {
    await applyYouTube({ action: "load", items: [video("a")], index: 0, video: false });
    emit("onAutoplayBlocked");
    expect(state()).toBe("autoplay_blocked");
    expect(musicStore.get().autoplayBlocked).toBe(true);

    await applyYouTube({ action: "load", items: [video("b")], index: 0, video: false });
    vi.advanceTimersByTime(AUTOPLAY_WATCHDOG_MS + 1);
    expect(state()).toBe("autoplay_blocked");

    playFromTap();
    expect(fake.unMute).toHaveBeenCalled();
    expect(fake.playVideo).toHaveBeenCalled();
  });

  it("an error moves to the next candidate, then reports in words", async () => {
    await applyYouTube({
      action: "load",
      items: [video("a")],
      fallbacks: [video("b")],
      index: 0,
      video: false,
    });
    emit("onError", 150);
    await vi.waitFor(() => expect(fake.loaded).toEqual(["a", "b"]));
    emit("onError", 150);
    await vi.waitFor(() => expect(state()).toBe("error"));
    expect(musicStore.get().payload?.notice).toMatch(/fuera de YouTube/);
  });

  it("one persistent player: the next track loads into it", async () => {
    await applyYouTube({ action: "load", items: [video("a")], index: 0, video: false });
    await applyYouTube({ action: "load", items: [video("b")], index: 0, video: false });
    expect(created).toBe(1);
    expect(fake.destroy).not.toHaveBeenCalled();
    expect(fake.loaded).toEqual(["a", "b"]);
  });
});
