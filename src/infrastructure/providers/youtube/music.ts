import type {
  MusicCommand,
  MusicFeature,
  MusicItem,
  MusicKind,
  MusicProvider,
  PlayTarget,
} from "@/core/capabilities/music";
import {
  PLAY_CONFIDENCE,
  rankCandidates,
  type MusicCandidate,
  type MusicRequest,
  type RankedCandidate,
} from "@/core/capabilities/music-match";
import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

/**
 * YouTube as a MusicProvider (ADR-042, ADR-044): search through the official YouTube Data API
 * v3 (a server-side key, no user account), playback through the official IFrame Player API on
 * ELISE's screen, always visible (YouTube forbids background or hidden players).
 *
 * Exact requests resolve with music-specific ranking over several candidates, with bounded
 * retries ("artist track" → "artist track official" → "track artist"), and only videos that
 * videos.list confirms embeddable and public are chosen. The browser holds the player:
 * controls come back as commands the page executes, and only the player says "playing".
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

interface VideoDetails {
  id: string;
  status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
  contentDetails?: { duration?: string };
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

/** ISO 8601 durations as the Data API returns them ("PT4M21S", "PT1H2M"). */
export function isoDurationMs(d: string | undefined): number | null {
  const m = d ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d) : null;
  if (!m) return null;
  const [, days, h, min, s] = m.map((x) => Number(x ?? 0));
  return ((((days ?? 0) * 24 + (h ?? 0)) * 60 + (min ?? 0)) * 60 + (s ?? 0)) * 1000;
}

const idOf = (ref: string) => ref.split(":").at(-1)!;

/** Search attempts for an exact request, strongest first (bounded: at most three). */
export function resolveQueries(req: MusicRequest): string[] {
  const variant = req.query
    .replace(req.artist ?? "", "")
    .replace(req.track ?? "", "")
    .trim();
  const tail = variant ? ` ${variant}` : "";
  if (req.artist && req.track)
    return [
      `${req.artist} ${req.track}${tail}`,
      `${req.artist} ${req.track} official${tail}`,
      `${req.track} ${req.artist}${tail}`,
    ];
  return [req.query, `${req.query} official`];
}

export class YouTubeMusicProvider implements MusicProvider {
  readonly key = "youtube" as const;
  readonly features = FEATURES;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, key: this.apiKey });
    let res: Response;
    try {
      res = await this.fetchImpl(`${YOUTUBE_API}/${path}?${qs}`, {
        signal: AbortSignal.timeout(12_000),
      });
    } catch (cause) {
      throw new AppError("PROVIDER_UNAVAILABLE", "YouTube did not respond", { cause });
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { errors?: { reason?: string }[] };
      };
      const reason = body.error?.errors?.[0]?.reason;
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
        throw new AppError("RATE_LIMITED", "YouTube's daily search quota is used up.", {
          details: { reason },
        });
      throw new AppError("PROVIDER_UNAVAILABLE", `YouTube error ${res.status}`, {
        details: { reason: reason ?? null },
      });
    }
    return (await res.json()) as T;
  }

  /** Videos (embeddable and syndicated: playable outside youtube.com) or playlists. */
  private async searchRaw(query: string, type: "video" | "playlist", max: number) {
    const json = await this.get<{ items?: SearchItem[] }>("search", {
      part: "snippet",
      q: query,
      type,
      maxResults: String(Math.min(25, max)),
      ...(type === "video" ? { videoEmbeddable: "true", videoSyndicated: "true" } : {}),
    });
    return (json.items ?? []).map(youtubeItem).filter((x): x is MusicItem => x !== null);
  }

  async search(q: { query: string; kinds: MusicKind[]; limit: number }): Promise<MusicItem[]> {
    const wantVideos = q.kinds.some((k) => k !== "playlist");
    const wantLists = q.kinds.includes("playlist");
    const [videos, lists] = await Promise.all([
      wantVideos ? this.searchRaw(q.query, "video", Math.max(10, q.limit)) : [],
      wantLists ? this.searchRaw(q.query, "playlist", Math.min(10, q.limit)) : [],
    ]);
    // The asked kind first.
    return q.kinds[0] === "playlist" ? [...lists, ...videos] : [...videos, ...lists];
  }

  /**
   * Status and length of candidates (videos.list, 1 quota unit): only public, processed,
   * embeddable videos can be chosen, so the player never gets one that can't play here.
   */
  private async details(items: MusicItem[]): Promise<MusicCandidate[]> {
    if (!items.length) return [];
    const json = await this.get<{ items?: VideoDetails[] }>("videos", {
      part: "status,contentDetails",
      id: items.map((i) => idOf(i.ref)).join(","),
      maxResults: "50",
    });
    const byId = new Map((json.items ?? []).map((v) => [v.id, v]));
    return items.flatMap((item) => {
      const v = byId.get(idOf(item.ref));
      if (
        !v ||
        v.status?.embeddable === false ||
        (v.status?.privacyStatus ?? "public") !== "public"
      )
        return [];
      if (v.status?.uploadStatus && v.status.uploadStatus !== "processed") return [];
      const durationMs = isoDurationMs(v.contentDetails?.duration);
      return [{ item: { ...item, durationMs }, channel: item.subtitle ?? "", durationMs }];
    });
  }

  async resolve(req: MusicRequest): Promise<{ ranked: RankedCandidate[]; attempts: number }> {
    const started = Date.now();
    let pool: MusicCandidate[] = [];
    let ranked: RankedCandidate[] = [];
    let attempts = 0;
    for (const query of resolveQueries(req)) {
      attempts++;
      const found = await this.searchRaw(query, "video", 15);
      const fresh = found.filter((f) => !pool.some((p) => p.item.ref === f.ref));
      pool = [...pool, ...(await this.details(fresh))];
      ranked = rankCandidates(pool, req);
      logger.info("music.youtube.search", {
        attempt: attempts,
        query: query.slice(0, 80),
        candidate_count: found.length,
        playable: pool.length,
        chosen_candidate_index: ranked[0]
          ? pool.indexOf(pool.find((p) => p.item.ref === ranked[0]!.item.ref)!)
          : null,
        confidence: ranked[0] ? Number(ranked[0].confidence.toFixed(2)) : 0,
        latency_ms: Date.now() - started,
      });
      if ((ranked[0]?.confidence ?? 0) >= PLAY_CONFIDENCE) break;
    }
    return { ranked, attempts };
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
