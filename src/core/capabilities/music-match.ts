import type { MusicItem } from "./music";

/**
 * Music-specific resolution (ADR-044): what an exact request names (artist, track, the version
 * the user wants) and how well a provider's candidate (a YouTube upload) matches it. Pure and
 * deterministic, so ranking is testable without a network.
 *
 * Why it exists: "One More Time de Daft Punk" against "Daft Punk - One More Time (Official
 * Video)" must score near the top. Generic word overlap failed it (the Spanish "de" counted as
 * a missing word), and kind filters ("track") excluded every YouTube video.
 */

/** Versions a user can ask for; otherwise they are penalized. */
export const VARIANTS = [
  "live",
  "karaoke",
  "cover",
  "remix",
  "acoustic",
  "instrumental",
  "slowed",
  "sped_up",
  "lyrics",
] as const;
export type Variant = (typeof VARIANTS)[number];

export interface MusicRequest {
  /** The words to search with (provider and filler words removed). */
  query: string;
  artist: string | null;
  track: string | null;
  /** Versions the user asked for ("una versión en vivo", "karaoke"). */
  wants: ReadonlySet<Variant>;
}

/** Lowercase, accent-free, punctuation as spaces, "&" as "and", feat./ft. dropped. */
export function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft|featuring)\b\.?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that never identify a song (Spanish and English connectors, request filler). */
const FILLER = new Set(
  (
    "de del la el los las un una y e by the a an of en on in por para con " +
    "pone poneme ponme pon pone reproduci reproducime reproduce play playing tocame " +
    "cancion tema song track musica music video"
  ).split(" "),
);

const VARIANT_WORDS: Record<Variant, RegExp> = {
  live: /\b(en vivo|live|concierto|concert|unplugged)\b/,
  karaoke: /\b(karaoke)\b/,
  cover: /\b(cover|covers|version de|tribute)\b/,
  remix: /\b(remix|rmx|bootleg|edit mix)\b/,
  acoustic: /\b(acustic[oa]|acoustic)\b/,
  instrumental: /\b(instrumental|piano version)\b/,
  slowed: /\b(slowed|reverb)\b/,
  sped_up: /\b(sped up|speed up|nightcore|acelerad[oa])\b/,
  lyrics: /\b(letra|lyrics|lyric)\b/,
};

const SEARCH_WORD: Record<Variant, string> = {
  live: "live",
  karaoke: "karaoke",
  cover: "cover",
  remix: "remix",
  acoustic: "acoustic",
  instrumental: "instrumental",
  slowed: "slowed",
  sped_up: "sped up",
  lyrics: "lyrics",
};

const PROVIDER_WORDS = /\b(en |on |in |de )?(youtube|you tube|spotify)\b/g;

/**
 * An exact request, structured. The model may pass artist/track; otherwise "X de Y" and
 * "Y - X" are read as track/artist. Provider words ("en YouTube") never reach the search.
 */
export function parseMusicRequest(input: {
  query?: string | null;
  artist?: string | null;
  track?: string | null;
}): MusicRequest {
  const raw = [input.query, input.track, input.artist].filter(Boolean).join(" ");
  const folded = fold(raw).replace(PROVIDER_WORDS, " ").replace(/\s+/g, " ").trim();
  const wants = new Set<Variant>(VARIANTS.filter((v) => VARIANT_WORDS[v].test(folded)));
  let artist = input.artist?.trim() || null;
  let track = input.track?.trim() || null;
  const query = (input.query ?? "")
    .replace(/\b(en|on|in) (youtube|you tube|spotify)\b/gi, "")
    .trim();
  if (!artist && !track && query) {
    // "One More Time de Daft Punk" / "One More Time by Daft Punk" / "Daft Punk - One More Time"
    const by = /^(.+?)\s+(?:de|by|del)\s+(.+)$/i.exec(query);
    const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(query);
    if (by) [track, artist] = [by[1]!.trim(), by[2]!.trim()];
    else if (dash) [artist, track] = [dash[1]!.trim(), dash[2]!.trim()];
  }
  const strip = (s: string | null) => {
    if (!s) return null;
    let x = fold(s);
    for (const v of VARIANTS) x = x.replace(new RegExp(VARIANT_WORDS[v].source, "gi"), " ");
    x = x
      .replace(/\b(una version|version|la version)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return x || null;
  };
  track = strip(track);
  artist = strip(artist);
  // "una versión en vivo de Hotel California": what's left after "de" is the song.
  if (!track && artist && !input.artist) [track, artist] = [artist, null];
  const base =
    artist && track ? `${artist} ${track}` : (artist ?? track ?? query.replace(/\s+/g, " "));
  // The asked-for version is searched for too ("Hotel California live").
  const extra = [...wants].map((v) => SEARCH_WORD[v]).filter((w) => !fold(base).includes(w));
  return { query: [base, ...extra].join(" "), artist, track, wants };
}

/** Content words of a phrase (no filler), for coverage. */
const words = (s: string) =>
  fold(s)
    .split(" ")
    .filter((w) => w && !FILLER.has(w));

function coverage(needle: string | null, haystack: string): number {
  if (!needle) return 0;
  const want = words(needle);
  if (!want.length) return 0;
  const have = new Set(fold(haystack).split(" "));
  return want.filter((w) => have.has(w)).length / want.length;
}

/** A provider's candidate: an upload with its channel and (when known) length. */
export interface MusicCandidate {
  item: MusicItem;
  channel: string;
  durationMs: number | null;
}

const PENALTIES: [
  Variant | "reaction" | "tutorial" | "interview" | "translated" | "short",
  RegExp,
  number,
][] = [
  ["karaoke", /\bkaraoke\b/, 0.6],
  ["cover", /\b(cover|tribute|versión de|version by)\b/, 0.5],
  ["reaction", /\b(reaction|reacciona\w*|reacting|reacción)\b/, 0.6],
  ["slowed", /\b(slowed|reverb)\b/, 0.5],
  ["sped_up", /\b(sped up|speed up|nightcore|8d)\b/, 0.5],
  ["remix", /\b(remix|rmx|bootleg)\b/, 0.35],
  ["live", /\b(live|en vivo|concierto|concert|unplugged)\b/, 0.3],
  [
    "tutorial",
    /\b(tutorial|lesson|how to play|how .* made|como tocar|guitar chords|piano tutorial)\b/,
    0.5,
  ],
  ["interview", /\b(interview|entrevista|documentary|documental)\b/, 0.5],
  ["instrumental", /\b(instrumental)\b/, 0.25],
  ["acoustic", /\b(acoustic|acustic)\b/, 0.2],
  ["translated", /\b(traducida|subtitulad\w*|sub espanol|sub español|subtitulos)\b/, 0.15],
  ["lyrics", /\b(lyrics|lyric video|letra)\b/, 0.12],
];

/**
 * How well one candidate answers the request. Unclamped for ranking (ties broken by how
 * official it is); `confidence` is the clamped 0–1 value.
 *
 * Favors, in order: the track in the title, the artist in title or channel, the artist's own
 * channel, "Official Video", "Official Audio", the artist's Topic channel. Penalizes versions
 * nobody asked for (covers, karaoke, reactions, slowed/sped up, remixes, live, tutorials,
 * interviews) and Shorts when a canonical upload exists.
 */
export function scoreCandidate(c: MusicCandidate, req: MusicRequest): number {
  const title = fold(c.item.title);
  const channel = fold(c.channel);
  const channelArtist = channel
    .replace(/\b(topic|vevo|official|oficial)\b/g, "")
    .replace(/\s+/g, "")
    .trim();
  const artistKey = req.artist ? fold(req.artist).replace(/\s+/g, "") : null;
  let score: number;
  if (req.track) {
    const t = coverage(req.track, title);
    const a = req.artist
      ? Math.max(
          coverage(req.artist, title),
          artistKey && channelArtist === artistKey ? 1 : coverage(req.artist, channel),
        )
      : 1;
    score = 0.6 * t + 0.3 * a;
  } else if (req.artist) {
    // Artist only ("Poné Daft Punk"): their uploads, best first.
    const a = Math.max(
      coverage(req.artist, title),
      artistKey && channelArtist === artistKey ? 1 : coverage(req.artist, channel),
    );
    score = 0.9 * a;
  } else {
    score = 0.9 * coverage(req.query, `${title} ${channel}`);
  }
  const official = artistKey !== null && channelArtist === artistKey;
  if (official) score += channel.includes("topic") ? 0.08 : 0.1;
  if (/vevo/.test(channel)) score += 0.06;
  if (/\bofficial (music )?video\b/.test(title)) score += 0.08;
  else if (/\bofficial audio\b/.test(title)) score += 0.07;
  else if (/\bofficial\b/.test(title)) score += 0.04;
  for (const [variant, re, penalty] of PENALTIES) {
    if (!re.test(title)) continue;
    const asked =
      (VARIANTS as readonly string[]).includes(variant) && req.wants.has(variant as Variant);
    score += asked ? 0.15 : -penalty;
  }
  // Asked for a version that this upload isn't.
  for (const v of req.wants) if (!VARIANT_WORDS[v].test(title)) score -= 0.2;
  // A Short (or a sub-minute clip) when a full song was asked for.
  const short =
    /#shorts?\b/.test(c.item.title.toLowerCase()) ||
    (c.durationMs !== null && c.durationMs < 60_000);
  if (short && req.track) score -= 0.4;
  return score;
}

export interface RankedCandidate extends MusicCandidate {
  score: number;
  confidence: number;
}

/** Confident enough to play without asking. */
export const PLAY_CONFIDENCE = 0.6;

export function rankCandidates(
  candidates: readonly MusicCandidate[],
  req: MusicRequest,
): RankedCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => (seen.has(c.item.ref) ? false : (seen.add(c.item.ref), true)))
    .map((c, i) => ({ c, i, score: scoreCandidate(c, req) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ c, score }) => ({ ...c, score, confidence: Math.max(0, Math.min(1, score)) }));
}

/** A YouTube video id from any of its URL shapes (watch, youtu.be, shorts, embed, music). */
export function youtubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return clean(u.pathname.slice(1));
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (u.pathname === "/watch") return clean(u.searchParams.get("v"));
    const m = /^\/(shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
    return m ? clean(m[2]!) : null;
  } catch {
    return null;
  }
}
const clean = (id: string | null) => (id && /^[\w-]{11}$/.test(id) ? id : null);
