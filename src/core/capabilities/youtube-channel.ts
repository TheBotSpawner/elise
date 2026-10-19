import { fold } from "./music-match";

/**
 * YouTube channels as first-class media entities (ADR-085). "Un video de Lumen Academy" is a
 * channel, not a text search: it resolves to a stable channel id, and every video after that is
 * taken from that channel only. Pure decisions here (tested); the provider talks to YouTube.
 */
export interface YouTubeChannel {
  provider: "youtube";
  channelId: string;
  handle: string | null;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  videoCount: number | null;
  /** The channel's uploads playlist (UU…): its videos, newest first, at 1 quota unit a page. */
  uploadsPlaylistId: string;
}

export type ChannelRef =
  { kind: "id"; id: string } | { kind: "handle"; handle: string } | { kind: "name"; name: string };

const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^@?([\w.-]{3,30})$/;

/**
 * Letters spelled one by one ("L-U-M-E-N Academy", "f i r b o t academy") become the word
 * they spell: a spelling is the user's strongest evidence and overrides what speech heard.
 */
export function collapseSpelled(input: string): string {
  return input.replace(/\b(\p{L})(?:[\s.-]+(\p{L})\b){2,}/gu, (m) => {
    const letters = m.replace(/[\s.-]+/g, "");
    return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
  });
}

/** A link, @handle, channel id or name, as the user gave it. */
export function parseChannelRef(raw: string): ChannelRef {
  const s = raw.trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (/(^|\.)youtube\.com$/i.test(u.hostname)) {
      const [first, second] = u.pathname.split("/").filter(Boolean);
      if (first?.startsWith("@")) return { kind: "handle", handle: first.slice(1).toLowerCase() };
      if (first === "channel" && second && CHANNEL_ID.test(second))
        return { kind: "id", id: second };
      if ((first === "c" || first === "user") && second) return { kind: "name", name: second };
    }
  } catch {
    // not a link
  }
  if (CHANNEL_ID.test(s)) return { kind: "id", id: s };
  if (s.startsWith("@") && HANDLE.test(s))
    return { kind: "handle", handle: s.slice(1).toLowerCase() };
  return { kind: "name", name: collapseSpelled(s).replace(/\s+/g, " ") };
}

/** For comparing names and handles: accents, case, dots, dashes and spaces don't matter. */
export const channelKey = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, "");

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

/** 1 = same name; falls off with each edit, relative to length. */
export function nameSimilarity(a: string, b: string): number {
  const x = channelKey(a);
  const y = channelKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  return Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length));
}

/** How well a channel answers what was asked (title or handle; size never matters). */
export function scoreChannel(c: Pick<YouTubeChannel, "title" | "handle">, asked: string): number {
  return Math.max(nameSimilarity(c.title, asked), c.handle ? nameSimilarity(c.handle, asked) : 0);
}

/** Exact or one small slip: playing this channel is safe. */
export const CHANNEL_CONFIDENT = 0.85;
/** Two candidates this close are a real question for the user. */
const AMBIGUITY_MARGIN = 0.05;

export type ChannelDecision =
  | { kind: "resolved"; channel: YouTubeChannel; confidence: number }
  | { kind: "ambiguous"; candidates: YouTubeChannel[] }
  | { kind: "not_found"; candidates: YouTubeChannel[] };

export function decideChannel(
  candidates: readonly YouTubeChannel[],
  asked: string,
): ChannelDecision {
  const unique = [...new Map(candidates.map((c) => [c.channelId, c])).values()];
  const ranked = unique
    .map((channel) => ({ channel, score: scoreChannel(channel, asked) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top || top.score < CHANNEL_CONFIDENT)
    return { kind: "not_found", candidates: ranked.slice(0, 3).map((r) => r.channel) };
  const close = ranked.filter(
    (r) => r.score >= CHANNEL_CONFIDENT && top.score - r.score <= AMBIGUITY_MARGIN,
  );
  if (close.length > 1)
    return { kind: "ambiguous", candidates: close.slice(0, 4).map((r) => r.channel) };
  return { kind: "resolved", channel: top.channel, confidence: Number(top.score.toFixed(2)) };
}

/** Handles a name could have ("Lumen Academy" → lumenacademy, lumen.academy, lumen_academy…). */
export function handleGuesses(name: string): string[] {
  const words = fold(name)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length) return [];
  return [...new Set(["", ".", "_", "-"].map((sep) => words.join(sep)))].filter(
    (h) => h.length >= 3 && h.length <= 30,
  );
}

/**
 * Speech slips ("Lumena" for "Lumen"): the name with one letter dropped from one long word.
 * Bounded; only ever used as handle guesses, and a hit must still score as confident.
 */
export function slipVariants(name: string, max = 12): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  words.forEach((w, i) => {
    if (w.length < 5) return;
    for (let k = 1; k < w.length - 1; k++) {
      const variant = [...words];
      variant[i] = w.slice(0, k) + w.slice(k + 1);
      out.add(variant.join(" "));
    }
  });
  return [...out].slice(0, max);
}

// ── Which video ──────────────────────────────────────────────────────────────

export interface ChannelVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string | null;
  durationMs: number | null;
  thumbnailUrl: string | null;
  url: string;
  isLive: boolean;
  isShort: boolean;
  /** Public, processed, embeddable: it can play on ELISE's screen. */
  playable: boolean;
}

/** YouTube Shorts are vertical clips up to three minutes; #shorts in the title says so too. */
export const looksLikeShort = (title: string, durationMs: number | null) =>
  /#shorts?\b/i.test(title) || (durationMs !== null && durationMs <= 60_000);

/**
 * "El último video": the newest playable upload that's a regular video (not a Short, not a live
 * or upcoming stream). Only when a channel has nothing but Shorts does the newest Short count.
 */
export function latestVideo(videos: readonly ChannelVideo[]): ChannelVideo | null {
  const playable = videos
    .filter((v) => v.playable && v.channelId)
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const regular = playable.filter((v) => !v.isShort && !v.isLive);
  return regular[0] ?? playable.find((v) => !v.isLive) ?? null;
}

/** "Un video aleatorio" / "otro": a random playable regular video, never one just played. */
export function randomVideo(
  videos: readonly ChannelVideo[],
  rng: () => number,
  exclude: readonly string[] = [],
): ChannelVideo | null {
  const pool = videos.filter((v) => v.playable && !v.isLive && !exclude.includes(v.videoId));
  const regular = pool.filter((v) => !v.isShort);
  const from = regular.length ? regular : pool;
  if (!from.length) return null;
  return from[Math.min(from.length - 1, Math.floor(rng() * from.length))]!;
}
