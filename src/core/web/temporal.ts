import type { Recency, WebResult } from "./model";
import { queryTerms } from "./rank";
import { todayIn } from "../time";

/**
 * Temporal intent for web research (ADR-074): "hoy", "esta semana", "recientemente", "lo
 * último" are constraints on the evidence, not words to search for. Detected deterministically
 * from the user's words (not left to an optional tool field), resolved in the user's timezone,
 * and used to judge every candidate — a very relevant result from two years ago does not answer
 * "recently".
 */

export type TemporalMode =
  "today" | "yesterday" | "this_week" | "this_month" | "recent" | "latest" | "current";

export interface TemporalIntent {
  timeSensitive: boolean;
  mode: TemporalMode | null;
  /** The window the evidence must fall in (local dates, inclusive). */
  from: string | null;
  to: string | null;
  /** The provider recency that covers the window. */
  recency: Recency | null;
  /** Explicit dates ("hoy", "esta semana") are hard; "lo último" accepts the newest available. */
  hard: boolean;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Ordered: the most specific phrase wins ("hoy" before "actual"). */
const PATTERNS: [TemporalMode, RegExp][] = [
  ["yesterday", /\b(ayer|anoche|yesterday|last night)\b/],
  [
    "today",
    /\b(hoy|esta (manana|tarde|noche)|en este momento|ahora mismo|today|this (morning|afternoon|evening)|right now)\b/,
  ],
  ["this_week", /\b(esta semana|estos dias|en la semana|this week|past few days|these days)\b/],
  ["this_month", /\b(este mes|en el mes|this month)\b/],
  [
    "recent",
    /\b(recien\w*|recientes?|recientemente|ultimamente|ultimos? dias|ultimas? semanas?|hace poco|lately|recent(ly)?|in the last (few )?(days|weeks))\b/,
  ],
  [
    "latest",
    /\b(ultim[oa]s?|mas recientes?|lo mas nuevo|novedades|latest|newest|most recent|breaking)\b/,
  ],
  ["current", /\b(actual(es|mente)?|hoy en dia|vigentes?|currently|current(ly)?|now|ahora)\b/],
];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Days back each mode looks first (widened only when nothing fresh exists, and said so). */
export const WINDOW_DAYS: Record<TemporalMode, number> = {
  today: 1,
  yesterday: 2,
  this_week: 7,
  this_month: 31,
  recent: 30,
  latest: 30,
  current: 30,
};

const RECENCY: Record<TemporalMode, Recency> = {
  today: "day",
  yesterday: "week",
  this_week: "week",
  this_month: "month",
  recent: "month",
  latest: "month",
  current: "month",
};

export function temporalIntent(text: string, now: Date, timezone: string): TemporalIntent {
  const t = fold(text);
  const hit = PATTERNS.find(([, re]) => re.test(t));
  if (!hit)
    return { timeSensitive: false, mode: null, from: null, to: null, recency: null, hard: false };
  const mode = hit[0];
  const today = todayIn(timezone, now);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const from =
    mode === "today"
      ? today
      : mode === "yesterday"
        ? addDays(today, -1)
        : mode === "this_week"
          ? addDays(today, -Math.max(weekday, 6))
          : mode === "this_month"
            ? `${today.slice(0, 8)}01`
            : addDays(today, -WINDOW_DAYS[mode]);
  return {
    timeSensitive: true,
    mode,
    from,
    to: mode === "yesterday" ? addDays(today, -1) : today,
    recency: RECENCY[mode],
    hard: mode === "today" || mode === "yesterday" || mode === "this_week" || mode === "this_month",
  };
}

export type CandidateFreshness = "within_window" | "older_than_asked" | "undated";

/** A candidate's date against the window: publication dates in UTC, compared by local day. */
export function freshnessOf(
  r: Pick<WebResult, "publishedAt">,
  intent: TemporalIntent,
  /** A wider lower bound, when the window was widened. */
  from = intent.from,
): CandidateFreshness {
  if (!r.publishedAt || !from) return "undated";
  const day = r.publishedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "undated";
  // One day of slack for timezones and "published late last night".
  return day >= addDays(from, -1) ? "within_window" : "older_than_asked";
}

export type RejectionReason = "TOO_OLD" | "NO_DIRECT_SUPPORT" | "DUPLICATE";
export type SearchConfidence = "high" | "medium" | "low";

/**
 * How much the evidence answers a time-sensitive question: high with a dated in-window result
 * that mentions what was asked, medium with only undated relevant ones, low otherwise. Low is
 * what triggers another, different round — the user never has to say "buscalo de nuevo".
 */
export function assessEvidence(
  results: readonly WebResult[],
  query: string,
  intent: TemporalIntent,
): {
  confidence: SearchConfidence;
  fresh: WebResult[];
  rejected: Partial<Record<RejectionReason, number>>;
} {
  const terms = queryTerms(query).map((x) => fold(x));
  const mentions = (r: WebResult) => {
    const text = fold(`${r.title} ${r.snippet}`);
    return !terms.length || terms.some((x) => text.includes(x));
  };
  const rejected: Partial<Record<RejectionReason, number>> = {};
  const count = (reason: RejectionReason) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
  const fresh: WebResult[] = [];
  let undated = 0;
  for (const r of results) {
    const f = freshnessOf(r, intent);
    if (!mentions(r)) {
      count("NO_DIRECT_SUPPORT");
      continue;
    }
    if (f === "older_than_asked") count("TOO_OLD");
    else if (f === "within_window") fresh.push(r);
    else undated++;
  }
  const confidence: SearchConfidence = fresh.length ? "high" : undated ? "medium" : "low";
  return { confidence, fresh, rejected };
}

const MONTHS = {
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
} as const;

/**
 * Different searches for a second round, not the same words again: the subject with the
 * current month and year (what dated coverage says), and with the language's "latest" word.
 */
export function temporalVariants(
  query: string,
  intent: TemporalIntent,
  locale: "es" | "en",
): string[] {
  if (!intent.to) return [];
  const subject = queryTerms(query).slice(0, 6).join(" ") || query;
  const [y, m, d] = intent.to.split("-").map(Number) as [number, number, number];
  const month = `${MONTHS[locale][m - 1]} ${y}`;
  const dated =
    intent.mode === "today" || intent.mode === "yesterday"
      ? locale === "es"
        ? `${subject} ${d} de ${MONTHS.es[m - 1]} ${y}`
        : `${subject} ${MONTHS.en[m - 1]} ${d} ${y}`
      : `${subject} ${month}`;
  const latest = `${subject} ${locale === "es" ? "último" : "latest"}`;
  return [...new Set([dated, latest])].filter((v) => fold(v) !== fold(query));
}
