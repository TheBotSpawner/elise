// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MusicPayload } from "@/core/workspace/music";

const actions = vi.hoisted(() => ({ musicAction: vi.fn() }));
const youtube = vi.hoisted(() => ({
  applyYouTube: vi.fn(async () => undefined),
  setYouTubeVolume: vi.fn(),
  youTubeVolume: vi.fn(() => 80 as number | null),
}));
const spotify = vi.hoisted(() => ({
  startSpotifyPlayer: vi.fn(async () => undefined),
  spotifyLocalVolume: vi.fn(async () => 60 as number | null),
  setSpotifyLocalVolume: vi.fn(async () => undefined),
}));
vi.mock("@/features/music/actions", () => actions);
vi.mock("@/features/music/youtube-player", () => youtube);
vi.mock("@/features/music/spotify-player", () => spotify);

const { controlMusic, duckMusic, receiveMusic, setDuckingEnabled } =
  await import("@/features/music/controller");
const { embeddedSnapshot, liveProgress, musicStore } = await import("@/features/music/store");

function payload(over: Partial<MusicPayload> = {}): MusicPayload {
  return {
    provider: "spotify",
    playing: true,
    item: {
      ref: "spotify:track:1",
      kind: "track",
      title: "Get Lucky",
      subtitle: "Daft Punk",
      artwork: null,
      durationMs: 240_000,
      url: null,
      provider: "spotify",
    },
    context: null,
    progressMs: 10_000,
    durationMs: 240_000,
    device: {
      id: "d1",
      name: "Living Room",
      type: "speaker",
      active: true,
      volume: 80,
      supportsVolume: true,
      restricted: false,
    },
    volume: 80,
    at: new Date().toISOString(),
    features: ["search", "remote_playback", "volume"],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.musicAction.mockResolvedValue({ ok: true, display: null });
  musicStore.set({
    payload: null,
    at: 0,
    autoplayBlocked: false,
    browserDevice: null,
    ducked: null,
  });
  setDuckingEnabled(true);
});

describe("one canonical music state", () => {
  it("progress advances while playing and stops at the end; paused stays put", () => {
    const p = payload();
    expect(liveProgress(p, 1_000, 6_000)).toBe(15_000);
    expect(liveProgress(p, 0, 10_000_000)).toBe(240_000);
    expect(liveProgress({ ...p, playing: false }, 1_000, 6_000)).toBe(10_000);
  });

  it("a tool result becomes the state; a later poll keeps a search's choices", async () => {
    await receiveMusic({ kind: "music", music: payload({ results: [payload().item!] }) });
    await receiveMusic({ kind: "music", music: payload({ playing: false }) });
    expect(musicStore.get().payload).toMatchObject({
      playing: false,
      results: [{ title: "Get Lucky" }],
    });
  });

  it("an embedded player's command runs in the page; its state is only reported for YouTube", async () => {
    await receiveMusic({
      kind: "music",
      music: payload({ provider: "youtube" }),
      command: { action: "pause" },
    });
    expect(youtube.applyYouTube).toHaveBeenCalledWith({ action: "pause" }, false);
    expect(embeddedSnapshot()).toBeNull(); // the page's player publishes its own state
    musicStore.setPayload(payload({ provider: "youtube" }));
    expect(embeddedSnapshot()).toMatchObject({ provider: "youtube", item: { title: "Get Lucky" } });
  });

  it("buttons on a remote provider go through the canonical tool (and answer at once)", async () => {
    musicStore.setPayload(payload());
    await controlMusic("pause");
    expect(musicStore.get().payload?.playing).toBe(false);
    expect(actions.musicAction).toHaveBeenCalledWith("pause", {});
  });
});

describe("ducking while ELISE speaks", () => {
  it("lowers a remote device that supports volume, then restores exactly what it was", async () => {
    musicStore.setPayload(payload());
    await duckMusic(true);
    expect(actions.musicAction).toHaveBeenLastCalledWith("setVolume", { percent: 28 });
    await duckMusic(false);
    expect(actions.musicAction).toHaveBeenLastCalledWith("setVolume", { percent: 80 });
    expect(musicStore.get().ducked).toBeNull();
  });

  it("never fakes it: a device without volume control is left alone", async () => {
    musicStore.setPayload(payload({ device: { ...payload().device!, supportsVolume: false } }));
    await duckMusic(true);
    await duckMusic(false);
    expect(actions.musicAction).not.toHaveBeenCalled();
  });

  it("ELISE's own Spotify player and YouTube duck locally, precisely", async () => {
    musicStore.set({ browserDevice: "d1" });
    musicStore.setPayload(payload());
    await duckMusic(true);
    expect(spotify.setSpotifyLocalVolume).toHaveBeenLastCalledWith(21);
    await duckMusic(false);
    expect(spotify.setSpotifyLocalVolume).toHaveBeenLastCalledWith(60);

    musicStore.set({ browserDevice: null });
    musicStore.setPayload(payload({ provider: "youtube" }));
    await duckMusic(true);
    expect(youtube.setYouTubeVolume).toHaveBeenLastCalledWith(28);
    await duckMusic(false);
    expect(youtube.setYouTubeVolume).toHaveBeenLastCalledWith(80);
    expect(actions.musicAction).not.toHaveBeenCalled();
  });

  it("does nothing when paused, or when the user turned it off", async () => {
    musicStore.setPayload(payload({ playing: false }));
    await duckMusic(true);
    setDuckingEnabled(false);
    musicStore.setPayload(payload());
    await duckMusic(true);
    expect(actions.musicAction).not.toHaveBeenCalled();
  });
});

describe("following the provider", () => {
  it("a song changed in Spotify's own app reaches the state on the next poll", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            provider: "spotify",
            payload: payload({ item: { ...payload().item!, title: "Instant Crush" } }),
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const { pollSoon, stopMusicPolling } = await import("@/features/music/controller");
    musicStore.setPayload(payload());
    pollSoon();
    await vi.advanceTimersByTimeAsync(1_300);
    expect(musicStore.get().payload?.item?.title).toBe("Instant Crush");
    stopMusicPolling();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
