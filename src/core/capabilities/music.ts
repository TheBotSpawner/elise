import type { MusicRequest, RankedCandidate } from "./music-match";

/**
 * Music (ADR-042): a canonical ELISE capability. The model and the UI speak this contract —
 * search, play, pause, skip, seek, volume, devices — and provider adapters (Spotify, YouTube,
 * later Deezer or a Desktop Companion's media session) implement what they can. Each adapter
 * declares its features; an operation it doesn't support fails honestly, never faked.
 */

export const MUSIC_FEATURES = [
  "search",
  /** The user's own playlists ("mi playlist Workout"). */
  "playlists",
  /** Playback lives in the provider (its apps, speakers…): ELISE controls it remotely. */
  "remote_playback",
  /** ELISE itself can be a playback device in this browser (e.g. Spotify Web Playback SDK). */
  "browser_player",
  /** Playback is an embedded player on ELISE's screen (YouTube IFrame): the browser holds it. */
  "embedded_playback",
  "devices",
  "transfer",
  "volume",
  "seek",
  "queue",
] as const;
export type MusicFeature = (typeof MUSIC_FEATURES)[number];

export type MusicProviderKey = "spotify" | "youtube" | "deezer" | "device";

export type MusicKind = "track" | "album" | "artist" | "playlist" | "video";

/** Something playable, as any provider describes it. `ref` is opaque (a URI, a video id). */
export interface MusicItem {
  ref: string;
  kind: MusicKind;
  title: string;
  /** Artists, owner or channel. */
  subtitle: string | null;
  artwork: string | null;
  durationMs: number | null;
  /** Open it at the provider. */
  url: string | null;
  provider: MusicProviderKey;
}

export interface MusicDevice {
  id: string;
  name: string;
  type: "computer" | "smartphone" | "speaker" | "tv" | "browser" | "other";
  active: boolean;
  /** 0–100, when the device reports it. */
  volume: number | null;
  supportsVolume: boolean;
  /** The device rejects remote commands (provider-side restriction). */
  restricted: boolean;
}

/** What is playing now. Times are milliseconds; `at` is when this was read. */
export interface Playback {
  provider: MusicProviderKey;
  playing: boolean;
  item: MusicItem | null;
  context: { kind: MusicKind; title: string | null; ref: string } | null;
  progressMs: number;
  durationMs: number;
  device: MusicDevice | null;
  volume: number | null;
  at: string;
  /** Embedded playback: whether video is shown (a music request stays compact). */
  video?: boolean;
  /**
   * What the player is really doing (ADR-044). `playing` is true only in "playing": a play
   * that was requested, blocked by the browser or still buffering is never "playing".
   */
  state?: PlayerState;
}

/** The truthful phases of playback, from the provider's own player (ADR-044). */
export const PLAYER_STATES = [
  "idle",
  "loading",
  "ready",
  "play_requested",
  "autoplay_blocked",
  "buffering",
  "playing",
  "paused",
  "ended",
  "error",
] as const;
export type PlayerState = (typeof PLAYER_STATES)[number];

/**
 * For embedded players (the browser holds playback): what the browser must do. The server
 * can't reach the player; the tool's result carries the command and the page executes it.
 */
export type MusicCommand =
  | {
      action: "load";
      items: MusicItem[];
      index: number;
      video: boolean;
      /** Next-best matches to try, in order, if the chosen one can't play (ADR-044 §L). */
      fallbacks?: MusicItem[];
    }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "next" }
  | { action: "previous" }
  | { action: "seek"; ms: number }
  | { action: "volume"; percent: number };

export interface PlayTarget {
  /** A track, album, artist or playlist (a context plays from its start). */
  item?: MusicItem;
  /** Several tracks in order (a curated queue). */
  tracks?: MusicItem[];
  deviceId?: string | null;
}

/**
 * The provider contract. Control operations return a command when the browser holds the
 * player (embedded), or nothing when the provider was told directly (remote).
 */
export interface MusicProvider {
  readonly key: MusicProviderKey;
  readonly features: ReadonlySet<MusicFeature>;
  search(q: { query: string; kinds: MusicKind[]; limit: number }): Promise<MusicItem[]>;
  myPlaylists?(): Promise<MusicItem[]>;
  playback(): Promise<Playback | null>;
  play(target: PlayTarget): Promise<MusicCommand | void>;
  pause(): Promise<MusicCommand | void>;
  resume(): Promise<MusicCommand | void>;
  next(): Promise<MusicCommand | void>;
  previous(): Promise<MusicCommand | void>;
  seek(ms: number): Promise<MusicCommand | void>;
  setVolume(percent: number): Promise<MusicCommand | void>;
  devices?(): Promise<MusicDevice[]>;
  transfer?(deviceId: string, play: boolean): Promise<void>;
  /**
   * Exact resolution with the provider's own bounded retries and music-specific ranking
   * (ADR-044): best first, only playable candidates.
   */
  resolve?(req: MusicRequest): Promise<{ ranked: RankedCandidate[]; attempts: number }>;
}

/** The browser's own view of an embedded player, sent with each turn (never stored). */
export type ClientPlayback = Playback;

// ── Pure decisions (tested) ──────────────────────────────────────────────────

/** Lowercase, accent-free, punctuation-free. */
export function musicKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How well a candidate matches what the user named (0–1). */
export function matchScore(item: MusicItem, query: string): number {
  const q = musicKey(query);
  if (!q) return 0;
  const title = musicKey(item.title);
  const full = musicKey(`${item.title} ${item.subtitle ?? ""}`);
  if (title === q) return 1;
  if (full === q || musicKey(`${item.subtitle ?? ""} ${item.title}`) === q) return 0.95;
  const words = q.split(" ");
  const hits = words.filter((w) => full.split(" ").includes(w)).length;
  return (hits / words.length) * 0.8;
}

/** A named thing must match this well to start without asking. */
export const EXACT_CONFIDENCE = 0.75;

export type PickResult =
  | { kind: "play"; item: MusicItem; confidence: number }
  | { kind: "ambiguous"; candidates: MusicItem[] }
  | { kind: "none" };

/**
 * Exact requests ("Poné Daft Punk", "Poné Random Access Memories"): the best named match,
 * preferring an artist (their music, not one song) over an album, a track or a playlist when
 * the name fits equally well. Nothing confident → ask among the best few, never guess.
 * Discovery requests ("algo tranquilo para estudiar"): the most relevant playlist (or track).
 */
export function pickToPlay(
  items: readonly MusicItem[],
  query: string,
  mode: "exact" | "discovery",
  kind?: MusicKind,
): PickResult {
  const pool = kind ? items.filter((i) => i.kind === kind) : items;
  if (!pool.length) return { kind: "none" };
  if (mode === "discovery") {
    const order: MusicKind[] = ["playlist", "album", "track", "video", "artist"];
    const best = [...pool].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0]!;
    return { kind: "play", item: best, confidence: 0.6 };
  }
  const rank: Record<MusicKind, number> = { artist: 4, album: 3, track: 2, playlist: 1, video: 2 };
  const scored = pool
    .map((item, i) => ({ item, score: matchScore(item, query), i }))
    .sort((a, b) => b.score - a.score || rank[b.item.kind] - rank[a.item.kind] || a.i - b.i);
  const top = scored[0]!;
  if (top.score >= EXACT_CONFIDENCE) return { kind: "play", item: top.item, confidence: top.score };
  // The provider's own first result for an explicit kind is a reasonable, honest pick.
  if (kind && top.score >= 0.5) return { kind: "play", item: top.item, confidence: top.score };
  return { kind: "ambiguous", candidates: scored.slice(0, 5).map((s) => s.item) };
}

/** "Bajalo un poco" → −15; "al 30%" → 30. Always 0–100. */
export function nextVolume(
  current: number | null,
  request: { percent?: number; change?: "up" | "down" | "mute"; by?: number },
): number {
  if (request.percent !== undefined) return clampVolume(request.percent);
  if (request.change === "mute") return 0;
  const base = current ?? 50;
  const step = request.by ?? 15;
  return clampVolume(request.change === "up" ? base + step : base - step);
}

export const clampVolume = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** A device named in words ("el parlante del living", "otro dispositivo"). */
export function pickDevice(
  devices: readonly MusicDevice[],
  ref: string | null,
):
  | { kind: "found"; device: MusicDevice }
  | { kind: "ask"; options: MusicDevice[] }
  | { kind: "none" } {
  const usable = devices.filter((d) => !d.restricted);
  if (!usable.length) return { kind: "none" };
  if (!ref || /^(otro|another|other)/i.test(ref.trim())) {
    const others = usable.filter((d) => !d.active);
    return others.length === 1
      ? { kind: "found", device: others[0]! }
      : { kind: "ask", options: others.length ? others : usable };
  }
  const key = musicKey(ref);
  const exact = usable.filter((d) => musicKey(d.name) === key);
  if (exact.length === 1) return { kind: "found", device: exact[0]! };
  const words = key.split(" ").filter((w) => w.length > 2 && !STOP.has(w));
  const partial = usable.filter((d) => {
    const name = musicKey(d.name);
    return (
      words.some((w) => name.includes(w)) || (TYPE_WORDS[d.type] ?? []).some((w) => key.includes(w))
    );
  });
  if (partial.length === 1) return { kind: "found", device: partial[0]! };
  return { kind: "ask", options: partial.length ? partial : usable };
}

const STOP = new Set(["del", "the", "los", "las", "una", "uno", "mandalo", "ponelo", "pasalo"]);
const TYPE_WORDS: Partial<Record<MusicDevice["type"], string[]>> = {
  speaker: ["parlante", "speaker", "altavoz"],
  smartphone: ["celu", "telefono", "phone", "movil"],
  computer: ["compu", "computadora", "computer", "laptop", "notebook"],
  tv: ["tele", "tv", "television"],
  browser: ["elise", "aca", "aqui", "here", "navegador", "browser"],
};

/**
 * Ducking (ADR-042 §J): the volume to use while ELISE speaks, and what to restore after.
 * Null when the device can't be set precisely — then nothing is ducked (never faked).
 */
export function duckedVolume(current: number | null, supportsVolume: boolean): number | null {
  if (!supportsVolume || current === null || current <= 15) return null;
  return Math.max(10, Math.round(current * 0.35));
}
