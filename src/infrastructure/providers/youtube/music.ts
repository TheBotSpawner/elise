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
import {
  channelKey,
  decideChannel,
  handleGuesses,
  looksLikeShort,
  parseChannelRef,
  slipVariants,
  type ChannelDecision,
  type ChannelVideo,
  type YouTubeChannel,
} from "@/core/capabilities/youtube-channel";
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

interface ChannelResource {
  id: string;
  snippet: { title: string; customUrl?: string; thumbnails?: Record<string, { url: string }> };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: { videoCount?: string };
}

interface VideoResource {
  id: string;
  snippet?: {
    title: string;
    channelId: string;
    channelTitle: string;
    publishedAt?: string;
    liveBroadcastContent?: string;
    thumbnails?: Record<string, { url: string }>;
  };
  status?: { embeddable?: boolean; privacyStatus?: string; uploadStatus?: string };
  contentDetails?: { duration?: string };
}

/** Resolved channels, per server instance: a channel id doesn't change (quota: search is 100). */
const CHANNEL_CACHE = new Map<
  string,
  { at: number; decision: ChannelDecision & { corrected?: boolean } }
>();
const CHANNEL_CACHE_MS = 6 * 60 * 60_000;

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

  // ── Channels (ADR-085) ──────────────────────────────────────────────────────

  /** Channel details by id or handle (channels.list: 1 quota unit). */
  private async channels(by: { id: string[] } | { forHandle: string }): Promise<YouTubeChannel[]> {
    if ("id" in by && !by.id.length) return [];
    const json = await this.get<{ items?: ChannelResource[] }>("channels", {
      part: "snippet,contentDetails,statistics",
      ...("id" in by
        ? { id: by.id.join(","), maxResults: "50" }
        : { forHandle: `@${by.forHandle}` }),
    });
    return (json.items ?? []).flatMap((c) => {
      const uploads = c.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return [];
      const thumb = c.snippet.thumbnails;
      const handle = c.snippet.customUrl?.startsWith("@") ? c.snippet.customUrl.slice(1) : null;
      return [
        {
          provider: "youtube" as const,
          channelId: c.id,
          handle,
          title: decodeEntities(c.snippet.title),
          url: handle
            ? `https://www.youtube.com/@${handle}`
            : `https://www.youtube.com/channel/${c.id}`,
          thumbnailUrl: (thumb?.high ?? thumb?.medium ?? thumb?.default)?.url ?? null,
          videoCount: c.statistics?.videoCount ? Number(c.statistics.videoCount) : null,
          uploadsPlaylistId: uploads,
        },
      ];
    });
  }

  private async byHandles(handles: string[]): Promise<YouTubeChannel[]> {
    const found = await Promise.all(
      handles.map((h) => this.channels({ forHandle: h }).catch(() => [] as YouTubeChannel[])),
    );
    return found.flat();
  }

  /**
   * A channel from what the user said (ADR-085), in a fixed order: link/handle/id exactly; a
   * name → handles it could have (1 unit each) + YouTube's channel search (100 units); only if
   * nothing is close, the name with one letter less (speech slips) as handles. Never a web page.
   */
  async resolveChannel(raw: string): Promise<ChannelDecision & { corrected?: boolean }> {
    const started = Date.now();
    const ref = parseChannelRef(raw);
    const cacheKey = `${ref.kind}:${ref.kind === "id" ? ref.id : ref.kind === "handle" ? ref.handle : channelKey(ref.name)}`;
    const hit = CHANNEL_CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < CHANNEL_CACHE_MS) return hit.decision;

    let decision: ChannelDecision & { corrected?: boolean };
    if (ref.kind === "id" || ref.kind === "handle") {
      const found = await this.channels(
        ref.kind === "id" ? { id: [ref.id] } : { forHandle: ref.handle },
      );
      decision = found[0]
        ? { kind: "resolved", channel: found[0], confidence: 1 }
        : { kind: "not_found", candidates: [] };
    } else {
      const [guessed, searched] = await Promise.all([
        this.byHandles(handleGuesses(ref.name)),
        this.get<{ items?: { id: { channelId?: string } }[] }>("search", {
          part: "snippet",
          q: ref.name,
          type: "channel",
          maxResults: "8",
        }).then((r) => (r.items ?? []).flatMap((i) => (i.id.channelId ? [i.id.channelId] : []))),
      ]);
      const details = await this.channels({
        id: searched.filter((id) => !guessed.some((g) => g.channelId === id)),
      });
      decision = decideChannel([...guessed, ...details], ref.name);
      if (decision.kind === "not_found") {
        // "Lumena Academy" (heard) → "Lumen Academy" (the channel): only as exact handles,
        // and only kept when the channel is still a near match for what was said.
        const slips = slipVariants(ref.name).flatMap(handleGuesses).slice(0, 24);
        const near = decideChannel(
          [...(await this.byHandles(slips)), ...decision.candidates],
          ref.name,
        );
        if (near.kind !== "not_found") decision = { ...near, corrected: true };
      }
    }
    logger.info("youtube_channel_resolution", {
      ref: ref.kind,
      outcome: decision.kind,
      candidate_count: decision.kind === "resolved" ? 1 : decision.candidates.length,
      confidence: decision.kind === "resolved" ? decision.confidence : null,
      corrected: Boolean(decision.corrected),
      latency_ms: Date.now() - started,
    });
    if (decision.kind !== "not_found") {
      CHANNEL_CACHE.set(cacheKey, { at: Date.now(), decision });
      if (CHANNEL_CACHE.size > 500) CHANNEL_CACHE.delete(CHANNEL_CACHE.keys().next().value!);
    }
    return decision;
  }

  /**
   * A channel's videos (ADR-085): its newest uploads (uploads playlist, 1 unit per 50), or a
   * search inside the channel only. Each confirmed by videos.list — public, processed,
   * embeddable, and really from this channel (anything else is dropped).
   */
  async channelVideos(
    channel: YouTubeChannel,
    opts: { query?: string; limit?: number } = {},
  ): Promise<ChannelVideo[]> {
    const started = Date.now();
    const limit = Math.min(100, opts.limit ?? 50);
    let ids: string[] = [];
    if (opts.query) {
      const json = await this.get<{ items?: SearchItem[] }>("search", {
        part: "snippet",
        channelId: channel.channelId,
        q: opts.query,
        type: "video",
        maxResults: "25",
      });
      ids = (json.items ?? []).flatMap((i) => (i.id.videoId ? [i.id.videoId] : []));
    } else {
      let pageToken: string | undefined;
      while (ids.length < limit) {
        const page = await this.get<{
          items?: { contentDetails?: { videoId?: string } }[];
          nextPageToken?: string;
        }>("playlistItems", {
          part: "contentDetails",
          playlistId: channel.uploadsPlaylistId,
          maxResults: "50",
          ...(pageToken ? { pageToken } : {}),
        });
        ids.push(
          ...(page.items ?? []).flatMap((i) =>
            i.contentDetails?.videoId ? [i.contentDetails.videoId] : [],
          ),
        );
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
      ids = ids.slice(0, limit);
    }
    const videos: ChannelVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const json = await this.get<{ items?: VideoResource[] }>("videos", {
        part: "snippet,status,contentDetails",
        id: ids.slice(i, i + 50).join(","),
        maxResults: "50",
      });
      for (const v of json.items ?? []) {
        if (v.snippet?.channelId !== channel.channelId) continue; // never another channel's
        const durationMs = isoDurationMs(v.contentDetails?.duration);
        const title = decodeEntities(v.snippet.title);
        const thumb = v.snippet.thumbnails;
        videos.push({
          videoId: v.id,
          title,
          channelId: v.snippet.channelId,
          channelTitle: decodeEntities(v.snippet.channelTitle),
          publishedAt: v.snippet.publishedAt ?? null,
          durationMs,
          thumbnailUrl: (thumb?.high ?? thumb?.medium ?? thumb?.default)?.url ?? null,
          url: `https://www.youtube.com/watch?v=${v.id}`,
          isLive: (v.snippet.liveBroadcastContent ?? "none") !== "none",
          isShort: looksLikeShort(title, durationMs),
          playable:
            v.status?.embeddable !== false &&
            (v.status?.privacyStatus ?? "public") === "public" &&
            (!v.status?.uploadStatus || v.status.uploadStatus === "processed"),
        });
      }
    }
    logger.info("youtube_video_search", {
      scope: opts.query ? "channel_search" : "channel_uploads",
      candidate_count: ids.length,
      playable: videos.filter((v) => v.playable).length,
      latency_ms: Date.now() - started,
    });
    return videos;
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
