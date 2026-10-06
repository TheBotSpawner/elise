import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { selectTools } from "@/core/agents/tool-selection";
import type { ToolDisplay } from "@/core/agents/tools";
import {
  duckedVolume,
  matchScore,
  nextVolume,
  pickDevice,
  pickToPlay,
  type MusicCommand,
  type MusicDevice,
  type MusicFeature,
  type MusicItem,
  type MusicProvider,
  type Playback,
  type PlayTarget,
} from "@/core/capabilities/music";
import { AppError } from "@/core/errors";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { applyOps, emptyWorkspace } from "@/core/workspace/model";
import {
  SpotifyMusicProvider,
  SpotifyTokenProvider,
  spotifyError,
} from "@/infrastructure/providers/spotify/music";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  refreshSpotifyToken,
  SPOTIFY_SCOPES,
} from "@/infrastructure/providers/spotify/oauth";
import { decodeEntities, YouTubeMusicProvider } from "@/infrastructure/providers/youtube/music";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const item = (
  kind: MusicItem["kind"],
  title: string,
  subtitle: string | null = null,
): MusicItem => ({
  ref: `spotify:${kind}:${title.toLowerCase().replace(/\W+/g, "")}`,
  kind,
  title,
  subtitle,
  artwork: "https://i.scdn.co/image/x",
  durationMs: kind === "track" ? 240_000 : null,
  url: "https://open.spotify.com/x",
  provider: "spotify",
});

const device = (id: string, name: string, over: Partial<MusicDevice> = {}): MusicDevice => ({
  id,
  name,
  type: "speaker",
  active: false,
  volume: 60,
  supportsVolume: true,
  restricted: false,
  ...over,
});

/** A remote provider in memory: a queue, a position, devices, volume. */
class FakeMusic implements MusicProvider {
  readonly key = "spotify" as const;
  features: ReadonlySet<MusicFeature> = new Set([
    "search",
    "playlists",
    "remote_playback",
    "devices",
    "transfer",
    "volume",
    "seek",
  ]);
  catalog: MusicItem[] = [];
  queue: MusicItem[] = [];
  index = 0;
  playing = false;
  volume = 70;
  progress = 0;
  devicesList: MusicDevice[] = [device("d1", "Notebook", { active: true, type: "computer" })];
  plays: PlayTarget[] = [];
  premium = true;
  async search(q: { query: string; kinds: MusicItem["kind"][] }) {
    return this.catalog.filter((i) => q.kinds.includes(i.kind) && matchScore(i, q.query) > 0);
  }
  async myPlaylists() {
    return this.catalog.filter((i) => i.kind === "playlist" && i.subtitle === "me");
  }
  private guard() {
    if (!this.premium) throw spotifyError(403, "PREMIUM_REQUIRED", "Premium required");
  }
  async playback(): Promise<Playback | null> {
    const it = this.queue[this.index] ?? null;
    const active = this.devicesList.find((d) => d.active) ?? null;
    return {
      provider: "spotify",
      playing: this.playing,
      item: it,
      context: null,
      progressMs: this.progress,
      durationMs: it?.durationMs ?? 0,
      device: active,
      volume: this.volume,
      at: new Date().toISOString(),
    };
  }
  async play(t: PlayTarget): Promise<MusicCommand | void> {
    this.guard();
    this.plays.push(t);
    const tracks = (
      t.item?.kind === "artist"
        ? this.catalog.filter((i) => i.kind === "track" && i.subtitle === t.item!.title)
        : t.item
          ? [t.item]
          : (t.tracks ?? [])
    ).map((x) => x);
    this.queue = tracks.length ? tracks : t.item ? [t.item] : [];
    this.index = 0;
    this.playing = true;
  }
  async pause() {
    this.guard();
    this.playing = false;
  }
  async resume() {
    this.guard();
    this.playing = true;
  }
  async next() {
    this.guard();
    this.index = Math.min(this.index + 1, this.queue.length - 1);
  }
  async previous() {
    this.guard();
    this.index = Math.max(0, this.index - 1);
  }
  async seek(ms: number) {
    this.progress = ms;
  }
  async setVolume(v: number) {
    this.volume = v;
  }
  async devices() {
    return this.devicesList;
  }
  async transfer(id: string) {
    this.devicesList = this.devicesList.map((d) => ({ ...d, active: d.id === id }));
  }
}

const MUSIC_CONN = "44444444-4444-4444-8444-444444444444";

function setup(music: MusicProvider = new FakeMusic()) {
  const { ports, log } = makePorts(
    [
      binding({
        connectionId: MUSIC_CONN,
        capability: "music",
        providerKey: "spotify",
        label: "Spotify",
        isDefault: true,
      }),
    ],
    { [MUSIC_CONN]: music },
  );
  const call = (name: string, args: unknown = {}, ctx = makeCtx()) =>
    executeToolCall(ports, ctx, { name, args });
  return { ports, log, call, music };
}

const musicOf = (out: Awaited<ReturnType<ReturnType<typeof setup>["call"]>>) =>
  (out as { display: Extract<ToolDisplay, { kind: "music" }> }).display;

// ── Pure decisions ───────────────────────────────────────────────────────────

describe("what to play", () => {
  const catalog = [
    item("track", "Get Lucky", "Daft Punk, Pharrell Williams"),
    item("artist", "Daft Punk"),
    item("album", "Random Access Memories", "Daft Punk"),
    item("playlist", "Daft Punk Essentials", "Spotify"),
  ];

  it('"Poné Daft Punk" plays the artist (their music), not one song', () => {
    const r = pickToPlay(catalog, "Daft Punk", "exact");
    expect(r).toMatchObject({ kind: "play", item: { kind: "artist", title: "Daft Punk" } });
  });

  it('"Poné Random Access Memories" plays the album', () => {
    const r = pickToPlay(catalog, "random access memories", "exact");
    expect(r).toMatchObject({ kind: "play", item: { kind: "album" } });
  });

  it("an exact name that matches nothing confidently is a question, not a guess", () => {
    const r = pickToPlay(catalog, "Discovery Tokyo live 2001", "exact");
    expect(r.kind).toBe("ambiguous");
  });

  it("discovery (a mood) prefers a playlist", () => {
    const r = pickToPlay(
      [item("track", "Weightless", "Marconi Union"), item("playlist", "Deep Focus", "Spotify")],
      "calm focus",
      "discovery",
    );
    expect(r).toMatchObject({ kind: "play", item: { kind: "playlist" } });
  });

  it("volume: relative steps, absolute values, mute; always 0–100", () => {
    expect(nextVolume(70, { change: "down" })).toBe(55);
    expect(nextVolume(95, { change: "up" })).toBe(100);
    expect(nextVolume(null, { percent: 30 })).toBe(30);
    expect(nextVolume(40, { change: "down", by: 60 })).toBe(0);
    expect(nextVolume(40, { change: "mute" })).toBe(0);
  });

  it("devices by name, by kind of device, or 'another one'", () => {
    const list = [
      device("a", "Notebook", { active: true, type: "computer" }),
      device("b", "Living Room"),
      device("c", "Kitchen", { restricted: true }),
    ];
    expect(pickDevice(list, "el parlante del living")).toMatchObject({
      kind: "found",
      device: { id: "b" },
    });
    expect(pickDevice(list, "otro dispositivo")).toMatchObject({
      kind: "found",
      device: { id: "b" },
    });
    expect(pickDevice([...list, device("d", "Bedroom")], "otro")).toMatchObject({ kind: "ask" });
    expect(pickDevice([device("c", "Kitchen", { restricted: true })], null)).toEqual({
      kind: "none",
    });
  });

  it("ducking only where the volume can be set precisely, and never to silence", () => {
    expect(duckedVolume(80, true)).toBe(28);
    expect(duckedVolume(80, false)).toBeNull();
    expect(duckedVolume(null, true)).toBeNull();
    expect(duckedVolume(12, true)).toBeNull();
  });
});

// ── Spotify OAuth ────────────────────────────────────────────────────────────

const CONFIG = {
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "https://elise.app/api/connections/spotify/callback",
};

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Spotify OAuth", () => {
  it("asks for exactly the playback scopes, with PKCE", () => {
    const url = new URL(buildSpotifyAuthorizationUrl(CONFIG, { state: "s", codeChallenge: "c" }));
    expect(url.origin).toBe("https://accounts.spotify.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([...SPOTIFY_SCOPES]);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
  });

  it("exchanges the code server-side with the secret (never in the browser)", async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).authorization).toMatch(/^Basic /);
      expect(String(init!.body)).toContain("code_verifier=v");
      return json(200, {
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: "streaming",
      });
    });
    const t = await exchangeSpotifyCode(CONFIG, "code", "v", fetchImpl);
    expect(t).toMatchObject({ accessToken: "a", refreshToken: "r", scopes: ["streaming"] });
  });

  it("an expired or revoked refresh token (invalid_grant) means reconnect", async () => {
    await expect(
      refreshSpotifyToken(CONFIG, "old", async () => json(400, { error: "invalid_grant" })),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED", recovery: "reconnect" });
  });

  it("refreshes before expiry, keeps a rotated refresh token, and stores it", async () => {
    const stored = {
      accessToken: "old",
      accessTokenExpiresAt: new Date(1_000).toISOString(),
      refreshToken: "r1",
      scopes: ["streaming"],
    };
    const writes: unknown[] = [];
    const vault = {
      read: async () => stored,
      write: async (_r: unknown, c: unknown) => void writes.push(c),
      remove: async () => {},
    };
    const tokens = new SpotifyTokenProvider(
      { connectionId: "c", workspaceId: "w" },
      {
        vault,
        config: () => CONFIG,
        onReauthorizationRequired: async () => {},
        now: () => 10_000,
        fetchImpl: async () =>
          json(200, { access_token: "new", refresh_token: "r2", expires_in: 3600 }),
      },
    );
    expect(await tokens.accessToken()).toBe("new");
    expect(writes[0]).toMatchObject({
      accessToken: "new",
      refreshToken: "r2",
      scopes: ["streaming"],
    });
  });

  it("a revoked grant marks the connection for reconnection", async () => {
    const reauth = vi.fn(async () => {});
    const tokens = new SpotifyTokenProvider(
      { connectionId: "c", workspaceId: "w" },
      {
        vault: {
          read: async () => ({
            accessToken: "x",
            accessTokenExpiresAt: new Date(0).toISOString(),
            refreshToken: "r",
            scopes: [],
          }),
          write: async () => {},
          remove: async () => {},
        },
        config: () => CONFIG,
        onReauthorizationRequired: reauth,
        fetchImpl: async () => json(400, { error: "invalid_grant" }),
      },
    );
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(reauth).toHaveBeenCalledWith({ connectionId: "c", workspaceId: "w" }, "invalid_grant");
  });
});

// ── Spotify adapter ──────────────────────────────────────────────────────────

function spotify(routes: (method: string, path: string, body: unknown) => Response) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let forced = 0;
  const provider = new SpotifyMusicProvider(
    { accessToken: async (force) => (force ? (forced++, "fresh") : "token") },
    async (url, init) => {
      const path = url.replace("https://api.spotify.com/v1", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path, body });
      return routes(init?.method ?? "GET", path, body);
    },
  );
  return { provider, calls, forced: () => forced };
}

describe("Spotify adapter (current Web API)", () => {
  it("searches tracks, artists, albums and playlists within the 10-per-type limit", async () => {
    const s = spotify(() =>
      json(200, {
        artists: {
          items: [
            {
              name: "Daft Punk",
              uri: "spotify:artist:1",
              images: [{ url: "https://i.scdn.co/a" }],
            },
          ],
        },
        albums: {
          items: [
            {
              name: "Discovery",
              uri: "spotify:album:2",
              artists: [{ name: "Daft Punk" }],
              images: [],
            },
          ],
        },
        tracks: {
          items: [
            {
              name: "One More Time",
              uri: "spotify:track:3",
              duration_ms: 320_000,
              artists: [{ name: "Daft Punk" }],
              album: {
                name: "Discovery",
                uri: "spotify:album:2",
                images: [{ url: "https://i.scdn.co/t" }],
              },
            },
          ],
        },
        // Spotify can return null entries in playlist search results.
        playlists: {
          items: [
            null,
            {
              name: "Workout",
              uri: "spotify:playlist:4",
              owner: { display_name: "me" },
              images: null,
            },
          ],
        },
      }),
    );
    const r = await s.provider.search({
      query: "Daft Punk",
      kinds: ["artist", "album", "track", "playlist"],
      limit: 8,
    });
    expect(r.map((x) => x.kind).sort()).toEqual(["album", "artist", "playlist", "track"]);
    expect(r.find((x) => x.kind === "track")).toMatchObject({
      subtitle: "Daft Punk",
      durationMs: 320_000,
    });
    const url = new URL(`https://x${s.calls[0]!.path}`);
    expect(Number(url.searchParams.get("limit"))).toBeLessThanOrEqual(10);
  });

  it("current playback, or none (204)", async () => {
    const none = spotify(() => new Response(null, { status: 204 }));
    expect(await none.provider.playback()).toBeNull();
    const s = spotify(() =>
      json(200, {
        is_playing: true,
        progress_ms: 42_000,
        item: {
          name: "Get Lucky",
          uri: "spotify:track:9",
          duration_ms: 248_000,
          artists: [{ name: "Daft Punk" }],
        },
        context: { type: "artist", uri: "spotify:artist:1" },
        device: {
          id: "d1",
          name: "Living Room",
          type: "Speaker",
          is_active: true,
          is_restricted: false,
          volume_percent: 40,
          supports_volume: true,
        },
      }),
    );
    expect(await s.provider.playback()).toMatchObject({
      playing: true,
      progressMs: 42_000,
      item: { title: "Get Lucky" },
      context: { kind: "artist" },
      device: { name: "Living Room", type: "speaker", supportsVolume: true },
      volume: 40,
    });
  });

  it("plays a context (artist/album/playlist) by context_uri and tracks by uris", async () => {
    const s = spotify(() => new Response(null, { status: 204 }));
    await s.provider.play({ item: item("artist", "Daft Punk") });
    await s.provider.play({ item: item("track", "Get Lucky") });
    expect(s.calls[0]).toMatchObject({
      method: "PUT",
      path: "/me/player/play",
      body: { context_uri: "spotify:artist:daftpunk" },
    });
    expect(s.calls[1]!.body).toEqual({ uris: ["spotify:track:getlucky"] });
  });

  it("no active device: plays on ELISE's own player in this browser", async () => {
    const s = spotify((method, path) => {
      if (path === "/me/player/play")
        return json(404, {
          error: { status: 404, reason: "NO_ACTIVE_DEVICE", message: "No active device" },
        });
      if (path === "/me/player/devices")
        return json(200, {
          devices: [
            {
              id: "web",
              name: "ELISE",
              type: "Computer",
              is_active: false,
              is_restricted: false,
              volume_percent: 70,
            },
          ],
        });
      return new Response(null, { status: 204 });
    });
    // The retry on ELISE's device (device_id=web) succeeds.
    await expect(s.provider.play({ item: item("artist", "Daft Punk") })).resolves.toBeUndefined();
    expect(s.calls.map((c) => c.path)).toEqual([
      "/me/player/play",
      "/me/player/devices",
      "/me/player/play?device_id=web",
    ]);
  });

  it("a non-Premium account gets the exact reason, never a fake success", async () => {
    const s = spotify(() =>
      json(403, {
        error: { status: 403, reason: "PREMIUM_REQUIRED", message: "Premium required" },
      }),
    );
    await expect(s.provider.pause()).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: expect.stringMatching(/Premium/),
    });
  });

  it("controls map to the player endpoints", async () => {
    const s = spotify(() => new Response(null, { status: 204 }));
    await s.provider.pause();
    await s.provider.resume();
    await s.provider.next();
    await s.provider.previous();
    await s.provider.seek(30_000);
    await s.provider.setVolume(30);
    await s.provider.transfer("d2", true);
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /me/player/pause",
      "PUT /me/player/play",
      "POST /me/player/next",
      "POST /me/player/previous",
      "PUT /me/player/seek?position_ms=30000",
      "PUT /me/player/volume?volume_percent=30",
      "PUT /me/player",
    ]);
    expect(s.calls.at(-1)!.body).toEqual({ device_ids: ["d2"], play: true });
  });

  it("an expired access token is refreshed once and the call retried", async () => {
    let first = true;
    const s = spotify(() => {
      if (first) {
        first = false;
        return json(401, { error: { status: 401, message: "expired" } });
      }
      return new Response(null, { status: 204 });
    });
    await s.provider.pause();
    expect(s.forced()).toBe(1);
    expect(s.calls).toHaveLength(2);
  });
});

// ── Canonical tools through the executor ─────────────────────────────────────

describe("music.* tools", () => {
  function catalog(m: FakeMusic) {
    m.catalog = [
      item("artist", "Daft Punk"),
      item("track", "One More Time", "Daft Punk"),
      item("track", "Get Lucky", "Daft Punk"),
      item("playlist", "Workout", "me"),
      item("playlist", "Deep Focus", "Spotify"),
    ];
    return m;
  }

  it('"Poné Daft Punk" starts the artist at once, no approval, and shows the Music Surface', async () => {
    const { call, music, log } = setup(catalog(new FakeMusic()));
    const out = await call("music.play", { query: "Daft Punk" });
    expect(out.status).toBe("succeeded");
    expect((music as FakeMusic).plays[0]!.item).toMatchObject({ kind: "artist" });
    expect(musicOf(out).music).toMatchObject({ playing: true, item: { title: "One More Time" } });
    expect(log.approvals).toHaveLength(0);
  }, 10_000);

  it('"Pasá esta" updates the same Surface (one canonical identity)', async () => {
    const { call } = setup(catalog(new FakeMusic()));
    const first = await call("music.play", { query: "Daft Punk" });
    const next = await call("music.next");
    expect(musicOf(next).music.item?.title).toBe("Get Lucky");
    const a = surfacesFromOutcome("music.play", first, { key: "c1", intentId: null });
    const b = surfacesFromOutcome("music.next", next, { key: "c2", intentId: null });
    expect(a[0]!.id).toBe(b[0]!.id);
    // Presenting the second replaces the first: never Music 1, Music 2…
    const state = applyOps(emptyWorkspace(), [
      { op: "present", surface: a[0]!, at: "t1" },
      { op: "present", surface: b[0]!, at: "t2" },
    ]);
    expect(state.surfaces.filter((s) => s.type === "music")).toHaveLength(1);
  }, 10_000);

  it("pause, resume, previous, seek and relative volume", async () => {
    const { call, music } = setup(catalog(new FakeMusic()));
    await call("music.play", { query: "Daft Punk" });
    expect((await call("music.pause")).status).toBe("succeeded");
    expect((music as FakeMusic).playing).toBe(false);
    await call("music.resume");
    expect((music as FakeMusic).playing).toBe(true);
    await call("music.seek", { seconds: 90 });
    expect((music as FakeMusic).progress).toBe(90_000);
    const v = await call("music.setVolume", { change: "down" });
    expect((v as { output: { volume: number } }).output.volume).toBe(55);
    expect((await call("music.setVolume", { percent: 30 })).status).toBe("succeeded");
    expect((music as FakeMusic).volume).toBe(30);
  }, 20_000);

  it('"Poné mi playlist Workout" finds the user\'s own playlist', async () => {
    const { call, music } = setup(catalog(new FakeMusic()));
    await call("music.play", { query: "workout", mine: true });
    expect((music as FakeMusic).plays[0]!.item).toMatchObject({
      kind: "playlist",
      title: "Workout",
    });
  }, 10_000);

  it("devices: list, and move playback by name", async () => {
    const m = catalog(new FakeMusic());
    m.devicesList = [
      device("d1", "Notebook", { active: true, type: "computer" }),
      device("d2", "Living Room"),
    ];
    const { call } = setup(m);
    const listed = await call("music.listDevices");
    expect(musicOf(listed).music.devices?.map((d) => d.name)).toEqual(["Notebook", "Living Room"]);
    const moved = await call("music.transfer", { device: "el parlante del living" });
    expect((moved as { output: { moved: boolean } }).output.moved).toBe(true);
    expect(m.devicesList.find((d) => d.active)!.id).toBe("d2");
  }, 10_000);

  it("Premium required: the tool fails with the reason; nothing pretends to play", async () => {
    const m = catalog(new FakeMusic());
    m.premium = false;
    const { call } = setup(m);
    const out = await call("music.play", { query: "Daft Punk" });
    expect(out).toMatchObject({ status: "failed", error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect((out as { error: { message: string } }).error.message).toMatch(/Premium/);
  });

  it("an unsupported operation is refused honestly (no fake volume)", async () => {
    const m = new FakeMusic();
    m.features = new Set(["search", "remote_playback"]);
    const { call } = setup(m);
    expect(await call("music.setVolume", { percent: 20 })).toMatchObject({
      status: "failed",
      error: { code: "CAPABILITY_UNAVAILABLE" },
    });
  });

  it("no music provider connected: unavailable, with nothing invented", async () => {
    const { ports } = makePorts([], {});
    const out = await executeToolCall(ports, makeCtx(), { name: "music.pause", args: {} });
    expect(out).toMatchObject({ status: "failed", error: { code: "CAPABILITY_UNAVAILABLE" } });
  });
});

// ── YouTube ──────────────────────────────────────────────────────────────────

describe("YouTube (official Data API search + IFrame player)", () => {
  it("search maps videos and playlists, decoding titles", async () => {
    const yt = new YouTubeMusicProvider("key", async (url) => {
      // Only videos that can play outside youtube.com.
      expect(url).toContain("videoEmbeddable=true");
      expect(url).toContain("videoSyndicated=true");
      return json(200, {
        items: [
          {
            id: { kind: "youtube#video", videoId: "abc" },
            snippet: {
              title: "Daft Punk &amp; Pharrell - Get Lucky (Official Audio)",
              channelTitle: "Daft Punk",
              thumbnails: { high: { url: "https://i.ytimg.com/vi/abc/hq.jpg" } },
            },
          },
        ],
      });
    });
    const r = await yt.search({ query: "Get Lucky", kinds: ["video"], limit: 5 });
    expect(r[0]).toMatchObject({
      ref: "yt:video:abc",
      kind: "video",
      title: "Daft Punk & Pharrell - Get Lucky (Official Audio)",
    });
    expect(decodeEntities("It&#39;s")).toBe("It's");
  });

  it("play/pause/seek/volume become commands for the player in the page", async () => {
    const yt = new YouTubeMusicProvider("key", async () => json(200, { items: [] }));
    expect(
      await yt.play({ tracks: [{ ...item("video", "A"), provider: "youtube" }] }),
    ).toMatchObject({ action: "load", index: 0 });
    expect(await yt.pause()).toEqual({ action: "pause" });
    expect(await yt.seek(10_000)).toEqual({ action: "seek", ms: 10_000 });
    expect(await yt.setVolume(40)).toEqual({ action: "volume", percent: 40 });
  });

  it("the tools send the command, and read state from what the page reports", async () => {
    const yt = new YouTubeMusicProvider("key", async () =>
      json(200, {
        items: [
          {
            id: { kind: "youtube#video", videoId: "v1" },
            snippet: { title: "Lo-fi beats", channelTitle: "Chill" },
          },
          {
            id: { kind: "youtube#video", videoId: "v2" },
            snippet: { title: "Lo-fi beats 2", channelTitle: "Chill" },
          },
        ],
      }),
    );
    const { ports } = makePorts(
      [
        binding({
          connectionId: MUSIC_CONN,
          capability: "music",
          providerKey: "youtube",
          label: "YouTube",
          isDefault: true,
        }),
      ],
      { [MUSIC_CONN]: yt },
    );
    const played = await executeToolCall(ports, makeCtx(), {
      name: "music.play",
      args: { query: "lo-fi beats", mode: "discovery" },
    });
    const d = musicOf(played);
    // A controlled queue of the matching videos, compact (not video) unless asked.
    expect(d.command).toMatchObject({
      action: "load",
      video: false,
      items: [{ ref: "yt:video:v1" }, { ref: "yt:video:v2" }],
    });
    const snapshot: Playback = {
      provider: "youtube",
      playing: true,
      item: { ...item("video", "Lo-fi beats"), provider: "youtube" },
      context: null,
      progressMs: 30_000,
      durationMs: 180_000,
      device: null,
      volume: 80,
      at: new Date().toISOString(),
    };
    const vol = await executeToolCall(ports, makeCtx({ music: snapshot }), {
      name: "music.setVolume",
      args: { change: "down" },
    });
    expect(musicOf(vol).command).toEqual({ action: "volume", percent: 65 });
    const seek = await executeToolCall(ports, makeCtx({ music: snapshot }), {
      name: "music.seek",
      args: { by: 30 },
    });
    expect(musicOf(seek).command).toEqual({ action: "seek", ms: 60_000 });
  });
});

// ── Surface lifecycle and routing ────────────────────────────────────────────

describe("the Music Surface on the Live Canvas", () => {
  function surface(playing: boolean) {
    const out = {
      status: "succeeded" as const,
      output: null,
      actionId: null,
      providerLabel: "spotify",
      display: {
        kind: "music" as const,
        music: {
          provider: "spotify" as const,
          playing,
          item: item("track", "Get Lucky", "Daft Punk"),
          context: null,
          progressMs: 1000,
          durationMs: 248_000,
          device: null,
          volume: 50,
          at: new Date().toISOString(),
          features: ["search", "remote_playback"] as MusicFeature[],
        },
      },
    };
    return surfacesFromOutcome("music.play", out, { key: "c", intentId: null })[0]!;
  }

  it("music that is playing stays while the conversation moves on; paused music decays", () => {
    let state = applyOps(emptyWorkspace(), [{ op: "present", surface: surface(true), at: "t" }]);
    for (let i = 0; i < 6; i++) state = applyOps(state, [{ op: "turn", at: `t${i}` }]);
    expect(state.surfaces.map((s) => s.type)).toEqual(["music"]);
    let paused = applyOps(emptyWorkspace(), [{ op: "present", surface: surface(false), at: "t" }]);
    for (let i = 0; i < 6; i++) paused = applyOps(paused, [{ op: "turn", at: `t${i}` }]);
    expect(paused.surfaces).toHaveLength(0);
  });

  it("focus and back on the Music Surface", () => {
    const s = surface(true);
    let state = applyOps(emptyWorkspace(), [{ op: "present", surface: s, at: "t" }]);
    state = applyOps(state, [{ op: "focus", id: s.id, at: "t" }]);
    expect(state.focusId).toBe(s.id);
    state = applyOps(state, [{ op: "focus", id: null, at: "t" }]);
    expect(state.focusId).toBeNull();
    expect(state.surfaces).toHaveLength(1);
  });

  it("follow-ups reach the music tools while music is on screen; a Method's steps can too", () => {
    const { ports } = setup();
    const all = ports.registry.available(new Set(["music"]));
    const viaSurface = selectTools(all, { message: "pasá esta", surfaceTypes: ["music"] });
    expect(viaSurface.tools.some((t) => t.name === "music.next")).toBe(true);
    const viaMethod = selectTools(all, {
      message: "Arranquemos a estudiar\n1. Mostrá los materiales\n2. Poné mi playlist de foco",
    });
    expect(viaMethod.tools.some((t) => t.name === "music.play")).toBe(true);
  });
});

describe("errors from Spotify", () => {
  it("are explicit about what happened", () => {
    expect(spotifyError(404, "NO_ACTIVE_DEVICE", "")).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(spotifyError(429, undefined, "")).toMatchObject({ code: "RATE_LIMITED" });
    expect(spotifyError(401, undefined, "")).toBeInstanceOf(AppError);
  });
});
