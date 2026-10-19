import { afterEach, describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import {
  collapseSpelled,
  decideChannel,
  latestVideo,
  parseChannelRef,
  randomVideo,
  type ChannelVideo,
  type YouTubeChannel,
} from "@/core/capabilities/youtube-channel";
import { channelChoice } from "@/core/tools/music";
import { YouTubeMusicProvider } from "@/infrastructure/providers/youtube/music";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * YouTube channels (ADR-085), with Firbot Academy (@firbot.academy) as the real fixture: a
 * channel resolves as a channel — name, handle, link, spelling or a speech slip — and every
 * video comes from that channel only. Mocked API; never the live one.
 */
const FIRBOT = "UCkn9OSrsXvy07b82FbnMR7w";
const OTHER = "UCxxxxxxxxxxxxxxxxxxxxxx";

interface FakeVideo {
  id: string;
  title: string;
  channelId: string;
  publishedAt: string;
  duration: string;
  live?: string;
  privacy?: string;
}
const VIDEOS: FakeVideo[] = [
  {
    id: "short000001",
    title: "Qué es RPA en 1 minuto #shorts",
    channelId: FIRBOT,
    publishedAt: "2026-10-15T10:00:00Z",
    duration: "PT55S",
  },
  {
    id: "latest00001",
    title: "Automatiza EXCEL con Power Automate Desktop",
    channelId: FIRBOT,
    publishedAt: "2026-10-10T10:00:00Z",
    duration: "PT14M2S",
  },
  {
    id: "older000001",
    title: "Curso de BOTS para EXCEL",
    channelId: FIRBOT,
    publishedAt: "2026-09-01T10:00:00Z",
    duration: "PT1H2M",
  },
  {
    id: "privat00001",
    title: "Privado",
    channelId: FIRBOT,
    publishedAt: "2026-10-16T10:00:00Z",
    duration: "PT9M",
    privacy: "private",
  },
  {
    id: "intrud00001",
    title: "Power Automate en otro canal",
    channelId: OTHER,
    publishedAt: "2026-10-17T10:00:00Z",
    duration: "PT9M",
  },
];

function fakeYouTube() {
  const calls: string[] = [];
  const channel = (id: string, title: string, handle: string) => ({
    id,
    snippet: { title, customUrl: `@${handle}` },
    contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } },
    statistics: { videoCount: "64" },
  });
  const CHANNELS = [
    channel(FIRBOT, "Firbot Academy", "firbot.academy"),
    channel(OTHER, "Fit Arshia", "fitarshia"),
  ];
  const fetchImpl = async (raw: string) => {
    const u = new URL(raw);
    const path = u.pathname.split("/").at(-1)!;
    const p = u.searchParams;
    calls.push(
      `${path}:${p.get("forHandle") ?? p.get("q") ?? p.get("id") ?? p.get("playlistId") ?? ""}`,
    );
    const json = (body: unknown) => new Response(JSON.stringify(body));
    if (path === "channels") {
      const handle = p.get("forHandle")?.slice(1);
      const ids = p.get("id")?.split(",") ?? [];
      return json({
        items: CHANNELS.filter((c) =>
          handle ? c.snippet.customUrl === `@${handle}` : ids.includes(c.id),
        ),
      });
    }
    if (path === "search" && p.get("type") === "channel") {
      const q = (p.get("q") ?? "").toLowerCase();
      // YouTube's own search: finds "Firbot Academy", not the heard "Firebot Academy".
      const hits = q.includes("firbot") ? [FIRBOT, OTHER] : [OTHER];
      return json({ items: hits.map((channelId) => ({ id: { channelId } })) });
    }
    if (path === "search" && p.get("channelId")) {
      const q = (p.get("q") ?? "").toLowerCase();
      // Even a channel-scoped search may return a stray: it's dropped by videos.list's check.
      const hits = VIDEOS.filter((v) => v.title.toLowerCase().includes(q.split(" ")[0]!));
      return json({
        items: hits.map((v) => ({
          id: { kind: "youtube#video", videoId: v.id },
          snippet: { title: v.title, channelTitle: "" },
        })),
      });
    }
    if (path === "playlistItems")
      return json({
        items: VIDEOS.filter((v) => v.channelId === FIRBOT).map((v) => ({
          contentDetails: { videoId: v.id },
        })),
      });
    if (path === "videos") {
      const ids = p.get("id")!.split(",");
      return json({
        items: VIDEOS.filter((v) => ids.includes(v.id)).map((v) => ({
          id: v.id,
          snippet: {
            title: v.title,
            channelId: v.channelId,
            channelTitle: v.channelId === FIRBOT ? "Firbot Academy" : "Otro",
            publishedAt: v.publishedAt,
            liveBroadcastContent: v.live ?? "none",
          },
          status: {
            embeddable: true,
            privacyStatus: v.privacy ?? "public",
            uploadStatus: "processed",
          },
          contentDetails: { duration: v.duration },
        })),
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, yt: new YouTubeMusicProvider("key", fetchImpl) };
}

const CONN = "66666666-6666-4666-8666-666666666666";
function setup() {
  const { calls, yt } = fakeYouTube();
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
  const call = (args: unknown, ctx = makeCtx()) =>
    executeToolCall(ports, ctx, { name: "music.channel", args }) as Promise<{
      status: string;
      output: Record<string, unknown>;
      display?: {
        music: { item: { ref: string } | null; channel?: { id: string; title: string } };
      };
    }>;
  return { calls, yt, call };
}

afterEach(() => {
  channelChoice.random = Math.random;
});

describe("channel references", () => {
  it("links, handles, ids and spelled names are read as the user meant them", () => {
    expect(parseChannelRef("https://www.youtube.com/@firbot.academy")).toEqual({
      kind: "handle",
      handle: "firbot.academy",
    });
    expect(parseChannelRef("youtube.com/@firbot.academy/videos")).toEqual({
      kind: "handle",
      handle: "firbot.academy",
    });
    expect(parseChannelRef("@Firbot.Academy")).toEqual({
      kind: "handle",
      handle: "firbot.academy",
    });
    expect(parseChannelRef(`https://youtube.com/channel/${FIRBOT}`)).toEqual({
      kind: "id",
      id: FIRBOT,
    });
    expect(parseChannelRef("F-I-R-B-O-T Academy")).toEqual({
      kind: "name",
      name: "Firbot Academy",
    });
    expect(collapseSpelled("f i r b o t academy")).toBe("Firbot academy");
    expect(collapseSpelled("Daft Punk")).toBe("Daft Punk");
  });

  it("a small exact channel beats a large unrelated one; equal matches are a question", () => {
    const ch = (channelId: string, title: string, handle: string): YouTubeChannel => ({
      provider: "youtube",
      channelId,
      title,
      handle,
      url: "",
      thumbnailUrl: null,
      videoCount: 1,
      uploadsPlaylistId: "UU",
    });
    expect(
      decideChannel(
        [ch("a", "Fit Arshia", "fit"), ch(FIRBOT, "Firbot Academy", "firbot.academy")],
        "Firbot Academy",
      ),
    ).toMatchObject({ kind: "resolved", channel: { channelId: FIRBOT } });
    expect(
      decideChannel(
        [ch("a", "Lofi Girl", "lofigirl"), ch("b", "Lofi Girl", "lofigirl2")],
        "Lofi Girl",
      ).kind,
    ).toBe("ambiguous");
    expect(decideChannel([ch("a", "Fit Arshia", "fit")], "Firbot Academy").kind).toBe("not_found");
  });

  it("latest = newest playable regular video (no Shorts, live or private); random never repeats", () => {
    const v = (videoId: string, o: Partial<ChannelVideo>): ChannelVideo => ({
      videoId,
      title: videoId,
      channelId: FIRBOT,
      channelTitle: "F",
      publishedAt: "2026-01-01",
      durationMs: 600_000,
      thumbnailUrl: null,
      url: "",
      isLive: false,
      isShort: false,
      playable: true,
      ...o,
    });
    const list = [
      v("short", { publishedAt: "2026-10-15", isShort: true }),
      v("live", { publishedAt: "2026-10-16", isLive: true }),
      v("private", { publishedAt: "2026-10-17", playable: false }),
      v("regular", { publishedAt: "2026-10-10" }),
      v("older", { publishedAt: "2026-09-01" }),
    ];
    expect(latestVideo(list)?.videoId).toBe("regular");
    expect(latestVideo([v("onlyShort", { isShort: true })])?.videoId).toBe("onlyShort");
    expect(randomVideo(list, () => 0)?.videoId).toBe("regular");
    expect(randomVideo(list, () => 0, ["regular"])?.videoId).toBe("older");
  });
});

describe("music.channel", () => {
  it("“Buscá el canal Firbot Academy”: the channel itself, its videos on screen — no web search", async () => {
    const { call, calls } = setup();
    const r = await call({ channel: "Firbot Academy", action: "find" });
    expect(r.status).toBe("succeeded");
    expect(r.output.channel).toEqual({
      title: "Firbot Academy",
      handle: "@firbot.academy",
      url: "https://www.youtube.com/@firbot.academy",
    });
    expect(calls.every((c) => !c.includes("http"))).toBe(true);
  });

  it("“el último video de Firbot Academy”: newest regular upload of THAT channel, sent to the player", async () => {
    const { call } = setup();
    const r = await call({ channel: "Firbot Academy", action: "latest" });
    expect(r.output).toMatchObject({
      found: true,
      playing: false,
      title: "Automatiza EXCEL con Power Automate Desktop",
    });
    expect(r.display?.music.item?.ref).toBe("yt:video:latest00001");
    expect(r.display?.music.channel).toMatchObject({ id: FIRBOT, title: "Firbot Academy" });
  });

  it("spelled (F-I-R-B-O-T) and @handle/link forms resolve the same channel", async () => {
    const { call } = setup();
    for (const channel of [
      "F-I-R-B-O-T Academy",
      "@firbot.academy",
      "https://www.youtube.com/@firbot.academy",
    ]) {
      const r = await call({ channel, action: "latest" });
      expect(r.output.channel, channel).toMatchObject({ handle: "@firbot.academy" });
    }
  });

  it("a speech slip (“Firebot Academy”) still finds Firbot Academy, and says so", async () => {
    const { call } = setup();
    const r = await call({ channel: "Firebot Academy", action: "random" });
    expect(r.output).toMatchObject({
      found: true,
      correctedTo: "Firbot Academy",
      channel: { handle: "@firbot.academy" },
    });
  });

  it("a video search stays inside the channel: another channel's video is never played", async () => {
    const { call } = setup();
    const r = await call({ channel: "@firbot.academy", action: "search", query: "Power Automate" });
    expect(r.display?.music.item?.ref).toBe("yt:video:latest00001");
  });

  it("random picks a playable regular video; “otro de ese canal” reuses the channel and skips the current one", async () => {
    const { call, calls } = setup();
    channelChoice.random = () => 0;
    const first = await call({ channel: "Firbot Academy", action: "random" });
    expect(first.display?.music.item?.ref).toBe("yt:video:latest00001");
    const ctx = makeCtx({
      music: { ...(first.display!.music as object), provider: "youtube" },
      workspace: { state: () => ({ surfaces: [{ payload: first.display!.music }] }) } as never,
    } as never);
    const searchesBefore = calls.filter((c) => c.startsWith("search:")).length;
    const again = await call({ action: "random" }, ctx);
    expect(again.display?.music.item?.ref).toBe("yt:video:older000001");
    expect(calls.filter((c) => c.startsWith("search:")).length).toBe(searchesBefore); // no new channel search
  });

  it("no channel → says so honestly (no guessing, no playback)", async () => {
    const { call } = setup();
    const r = await call({ channel: "Zzyzx Qwrtp", action: "latest" });
    expect(r.output).toMatchObject({ found: false });
    expect(r.display).toBeUndefined();
  });
});
