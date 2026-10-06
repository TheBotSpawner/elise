import type {
  MusicCommand,
  MusicFeature,
  MusicItem,
  MusicKind,
  MusicProvider,
  PlayTarget,
} from "@/core/capabilities/music";
import { AppError } from "@/core/errors";

/**
 * YouTube as a MusicProvider (ADR-042): search through the official YouTube Data API v3 (a
 * server-side key, no user account), playback through the official IFrame Player API on
 * ELISE's screen. YouTube's developer policies forbid background players and separating audio
 * from video, so the player is always visible while it plays (a compact video in the Music
 * Surface) and stops when that page closes. The browser holds the player: controls come back
 * as commands the page executes.
 */

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const FEATURES: ReadonlySet<MusicFeature> = new Set([
  "search",
  "embedded_playback",
  "volume",
  "seek",
  "queue",
]);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
export const decodeEntities = (s: string) =>
  s.replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m]!);

interface SearchItem {
  id: { kind: string; videoId?: string; playlistId?: string };
  snippet: {
    title: string;
    channelTitle: string;
    thumbnails?: Record<string, { url: string }>;
  };
}

export function youtubeItem(r: SearchItem): MusicItem | null {
  const video = r.id.videoId;
  const list = r.id.playlistId;
  if (!video && !list) return null;
  const thumb = r.snippet.thumbnails;
  return {
    ref: video ? `yt:video:${video}` : `yt:playlist:${list}`,
    kind: video ? "video" : "playlist",
    title: decodeEntities(r.snippet.title),
    subtitle: decodeEntities(r.snippet.channelTitle),
    artwork: (thumb?.high ?? thumb?.medium ?? thumb?.default)?.url ?? null,
    durationMs: null,
    url: video
      ? `https://www.youtube.com/watch?v=${video}`
      : `https://www.youtube.com/playlist?list=${list}`,
    provider: "youtube",
  };
}

export class YouTubeMusicProvider implements MusicProvider {
  readonly key = "youtube" as const;
  readonly features = FEATURES;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async search(q: { query: string; kinds: MusicKind[]; limit: number }): Promise<MusicItem[]> {
    const wantVideos = q.kinds.some((k) => k !== "playlist");
    const wantLists = q.kinds.includes("playlist");
    const run = async (type: "video" | "playlist") => {
      const params = new URLSearchParams({
        part: "snippet",
        q: q.query,
        type,
        maxResults: String(Math.min(10, q.limit)),
        key: this.apiKey,
        ...(type === "video" ? { videoCategoryId: "10", videoEmbeddable: "true" } : {}),
      });
      let res: Response;
      try {
        res = await this.fetchImpl(`${YOUTUBE_API}/search?${params}`, {
          signal: AbortSignal.timeout(12_000),
        });
      } catch (cause) {
        throw new AppError("PROVIDER_UNAVAILABLE", "YouTube did not respond", { cause });
      }
      if (res.status === 403)
        throw new AppError("RATE_LIMITED", "YouTube's daily search quota is used up.");
      if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", `YouTube error ${res.status}`);
      const json = (await res.json()) as { items?: SearchItem[] };
      return (json.items ?? []).map(youtubeItem).filter((x): x is MusicItem => x !== null);
    };
    const [videos, lists] = await Promise.all([
      wantVideos ? run("video") : [],
      wantLists ? run("playlist") : [],
    ]);
    // The asked kind first.
    return q.kinds[0] === "playlist" ? [...lists, ...videos] : [...videos, ...lists];
  }

  /** The browser holds the player: its state comes with each turn, never from here. */
  async playback() {
    return null;
  }

  async play(t: PlayTarget): Promise<MusicCommand> {
    const items = t.tracks?.length ? t.tracks : t.item ? [t.item] : [];
    if (!items.length) throw new AppError("VALIDATION_ERROR", "Nothing to play");
    return { action: "load", items: items.slice(0, 50), index: 0, video: false };
  }
  async pause(): Promise<MusicCommand> {
    return { action: "pause" };
  }
  async resume(): Promise<MusicCommand> {
    return { action: "resume" };
  }
  async next(): Promise<MusicCommand> {
    return { action: "next" };
  }
  async previous(): Promise<MusicCommand> {
    return { action: "previous" };
  }
  async seek(ms: number): Promise<MusicCommand> {
    return { action: "seek", ms };
  }
  async setVolume(percent: number): Promise<MusicCommand> {
    return { action: "volume", percent };
  }
}
