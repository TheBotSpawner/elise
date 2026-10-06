import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ToolDisplay } from "@/core/agents/tools";
import {
  parseMusicRequest,
  PLAY_CONFIDENCE,
  rankCandidates,
  youtubeVideoId,
  type MusicCandidate,
} from "@/core/capabilities/music-match";
import { emptyWorkspace } from "@/core/workspace/model";
import { resolveQueries, YouTubeMusicProvider } from "@/infrastructure/providers/youtube/music";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/** YouTube reliability (ADR-044): exact resolution, ranking, and "requested ≠ playing". */

const cand = (
  title: string,
  channel: string,
  id = title,
  durationMs = 240_000,
): MusicCandidate => ({
  item: {
    ref: `yt:video:${id}`,
    kind: "video",
    title,
    subtitle: channel,
    artwork: null,
    durationMs,
    url: null,
    provider: "youtube",
  },
  channel,
  durationMs,
});

const best = (cs: MusicCandidate[], q: string) =>
  rankCandidates(cs, parseMusicRequest({ query: q }))[0]!;

const DAFT = [
  cand("How Daft Punk made One More Time", "Music Explained", "explain"),
  cand("One More Time - Daft Punk (Karaoke Version)", "Sing King", "karaoke"),
  cand("Daft Punk - One More Time (Live at Alive 2007)", "Fan uploads", "live"),
  cand("One More Time (cover) by Ana", "Ana Music", "cover"),
  cand("Daft Punk - One More Time (Official Video)", "Daft Punk", "official"),
  cand("One More Time", "Daft Punk - Topic", "topic"),
];

describe("parsing an exact request", () => {
  it("reads track/artist from Spanish and dashed forms, dropping the provider", () => {
    expect(parseMusicRequest({ query: "One More Time de Daft Punk en YouTube" })).toMatchObject({
      track: "one more time",
      artist: "daft punk",
    });
    expect(parseMusicRequest({ query: "Queen - Bohemian Rhapsody" })).toMatchObject({
      artist: "queen",
      track: "bohemian rhapsody",
    });
  });

  it("keeps the asked version as a want and in the search", () => {
    const live = parseMusicRequest({ query: "una versión en vivo de Hotel California" });
    expect(live.track).toBe("hotel california");
    expect([...live.wants]).toEqual(["live"]);
    expect(live.query).toContain("live");
  });

  it("bounds fallback searches: artist track → official → track artist", () => {
    const req = parseMusicRequest({ artist: "Daft Punk", track: "Get Lucky" });
    expect(resolveQueries(req)).toEqual([
      "daft punk get lucky",
      "daft punk get lucky official",
      "get lucky daft punk",
    ]);
  });
});

describe("music ranking", () => {
  it("One More Time de Daft Punk → the official video, confidently", () => {
    const top = best(DAFT, "One More Time de Daft Punk");
    expect(top.item.ref).toBe("yt:video:official");
    expect(top.confidence).toBeGreaterThanOrEqual(PLAY_CONFIDENCE);
  });

  it("penalizes karaoke, covers, live and explainers unless asked", () => {
    const ranked = rankCandidates(DAFT, parseMusicRequest({ query: "One More Time de Daft Punk" }));
    const pos = (id: string) => ranked.findIndex((r) => r.item.ref === `yt:video:${id}`);
    for (const bad of ["karaoke", "cover", "live", "explain"])
      expect(pos(bad)).toBeGreaterThan(pos("topic"));
  });

  it("an asked version wins: karaoke, live", () => {
    expect(best(DAFT, "One More Time de Daft Punk karaoke").item.ref).toBe("yt:video:karaoke");
    expect(best(DAFT, "One More Time de Daft Punk en vivo").item.ref).toBe("yt:video:live");
  });

  it("official audio and Topic beat a random upload; Shorts lose", () => {
    const cs = [
      cand("Billie Jean #shorts", "Dance Clips", "short", 30_000),
      cand("Michael Jackson - Billie Jean (Official Audio)", "Michael Jackson", "audio"),
      cand("billie jean michael jackson", "random", "random"),
    ];
    expect(best(cs, "Billie Jean de Michael Jackson").item.ref).toBe("yt:video:audio");
    expect(best(cs, "Billie Jean de Michael Jackson").item.ref).not.toBe("yt:video:short");
  });

  it("youtube links in every shape", () => {
    const id = "FGBhQbmPwH8";
    for (const u of [
      `https://www.youtube.com/watch?v=${id}&t=3`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/embed/${id}`,
    ])
      expect(youtubeVideoId(u)).toBe(id);
    expect(youtubeVideoId("https://vimeo.com/123")).toBeNull();
  });
});

// ── The adapter against a fake Data API ──────────────────────────────────────

const OFFICIAL = "FGBhQbmPwH8";
const BLOCKED = "aaaaaaaaaaa";

function fakeApi(pages: Record<string, { id: string; title: string; channel: string }[]>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/videos"))
      return new Response(
        JSON.stringify({
          items: u.searchParams
            .get("id")!
            .split(",")
            .map((id) => ({
              id,
              // A video whose owner forbids embedding never reaches the player.
              status: {
                embeddable: id !== BLOCKED,
                privacyStatus: "public",
                uploadStatus: "processed",
              },
              contentDetails: { duration: "PT5M20S" },
            })),
        }),
      );
    const q = u.searchParams.get("q")!;
    return new Response(
      JSON.stringify({
        items: (pages[q] ?? []).map((v) => ({
          id: { kind: "youtube#video", videoId: v.id },
          snippet: { title: v.title, channelTitle: v.channel },
        })),
      }),
    );
  };
  return { calls, fetchImpl };
}

const CONN = "55555555-5555-4555-8555-555555555555";

function setupYouTube(fetchImpl: (url: string) => Promise<Response>) {
  const yt = new YouTubeMusicProvider("key", fetchImpl);
  const { ports } = makePorts(
    [
      binding({
        connectionId: CONN,
        capability: "music",
        providerKey: "youtube",
        label: "YouTube",
        isDefault: true,
      }),
    ],
    { [CONN]: yt },
  );
  return (args: unknown, ctx = makeCtx()) =>
    executeToolCall(ports, ctx, { name: "music.play", args });
}

const display = (out: unknown) =>
  (out as { display: Extract<ToolDisplay, { kind: "music" }> }).display;
const output = (out: unknown) => (out as { output: Record<string, unknown> }).output;

describe("YouTube exact resolution", () => {
  it("plays the official video, with the next matches as fallbacks; never claims playing", async () => {
    const api = fakeApi({
      "daft punk one more time": [
        { id: BLOCKED, title: "Daft Punk - One More Time (Official Audio)", channel: "Daft Punk" },
        { id: OFFICIAL, title: "Daft Punk - One More Time (Official Video)", channel: "Daft Punk" },
        { id: "bbbbbbbbbbb", title: "One More Time", channel: "Daft Punk - Topic" },
      ],
    });
    const out = await setupYouTube(api.fetchImpl)({
      query: "One More Time de Daft Punk en YouTube",
      mode: "exact",
    });
    expect(output(out)).toMatchObject({
      found: true,
      confirmed: false,
      playing: false,
      from: "search",
      attempts: 1,
    });
    expect(String(output(out).instructions)).toMatch(/never say it is playing/);
    expect(display(out).command).toMatchObject({
      action: "load",
      items: [{ ref: `yt:video:${OFFICIAL}` }],
      fallbacks: [{ ref: "yt:video:bbbbbbbbbbb" }],
    });
    // The non-embeddable upload was filtered by videos.list, never offered.
    expect(JSON.stringify(display(out).command)).not.toContain(BLOCKED);
    expect(display(out).music).toMatchObject({ state: "play_requested", playing: false });
  });

  it("retries with the next query only while nothing is confident", async () => {
    const api = fakeApi({
      "daft punk get lucky official": [
        {
          id: OFFICIAL,
          title: "Daft Punk - Get Lucky (Official Audio) ft. Pharrell",
          channel: "Daft Punk",
        },
      ],
    });
    const out = await setupYouTube(api.fetchImpl)({
      artist: "Daft Punk",
      track: "Get Lucky",
      mode: "exact",
    });
    expect(output(out)).toMatchObject({ attempts: 2 });
    expect(api.calls.filter((c) => c.includes("/search")).length).toBe(2);
  });

  it("nothing playable → not found, after the bounded attempts", async () => {
    const api = fakeApi({});
    const out = await setupYouTube(api.fetchImpl)({
      query: "Bohemian Rhapsody de Queen",
      mode: "exact",
    });
    expect(JSON.stringify(out)).toMatch(/NOT_FOUND/);
    expect(api.calls.filter((c) => c.includes("/search")).length).toBe(3);
  });

  it("a link already found plays directly, without searching", async () => {
    const api = fakeApi({});
    const out = await setupYouTube(api.fetchImpl)({
      url: `https://youtu.be/${OFFICIAL}`,
      track: "One More Time",
    });
    expect(api.calls).toEqual([]);
    expect(display(out).command).toMatchObject({ items: [{ ref: `yt:video:${OFFICIAL}` }] });
  });

  it("reuses a video already on screen instead of searching again", async () => {
    const api = fakeApi({});
    const ws = emptyWorkspace();
    const state = {
      ...ws,
      surfaces: [
        {
          id: "s1",
          payload: {
            results: [
              {
                title: "Daft Punk - One More Time (Official Video)",
                url: `https://www.youtube.com/watch?v=${OFFICIAL}`,
              },
            ],
          },
        },
      ],
    } as unknown as ReturnType<typeof emptyWorkspace>;
    const ctx = makeCtx({
      workspace: { state: () => state, apply: () => undefined, activity: () => undefined },
    });
    const out = await setupYouTube(api.fetchImpl)(
      { query: "One More Time de Daft Punk", mode: "exact" },
      ctx,
    );
    expect(api.calls).toEqual([]);
    expect(output(out)).toMatchObject({ from: "screen" });
  });
});
