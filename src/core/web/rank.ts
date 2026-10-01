import type { WebResult } from "./model";
import { domainOf, normalizeUrl } from "./url";
import { keywordQuery } from "../knowledge/retrieval";

/**
 * Source quality without a fixed whitelist (ADR-015). Signals, not verdicts:
 * - first-party: the site belongs to what's asked about ("notion" → notion.com, developers.notion.com);
 * - documentation hosts (docs., developer(s)., help., support., learn.) for technical questions;
 * - recency for news and "latest" questions;
 * - diversity: at most two results per site, so one domain can't fill the evidence.
 * The model still judges the evidence; these only order what it reads first.
 */

export const queryTerms = (q: string) =>
  keywordQuery(q)
    .split(" | ")
    .filter((t) => t.length >= 3);

const DOC_HOST = /^(docs|developers?|dev|help|support|learn|api|platform|kb|knowledge)\./;

export interface RankOptions {
  preferRecent: boolean;
  now: Date;
}

export function rankResults(results: WebResult[], query: string, opts: RankOptions): WebResult[] {
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const key = normalizeUrl(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const terms = queryTerms(query);
  const scored = unique.map((r) => {
    const host = r.domain || domainOf(r.url);
    const labels = host.split(".");
    const registrable = labels.slice(-2).join(".");
    let score = 10 - r.rank * 0.8;
    if (terms.some((t) => registrable.startsWith(t) || labels.slice(0, -1).includes(t))) score += 4;
    if (DOC_HOST.test(host)) score += 2;
    if (opts.preferRecent && r.publishedAt) {
      const days = (opts.now.getTime() - Date.parse(r.publishedAt)) / 86_400_000;
      score += days <= 1 ? 4 : days <= 7 ? 2 : days <= 31 ? 0.5 : -1;
    }
    if (!r.snippet) score -= 1;
    return { r, score, host: registrable };
  });
  scored.sort((a, b) => b.score - a.score);
  const perSite = new Map<string, number>();
  return scored
    .filter(({ host }) => {
      const n = perSite.get(host) ?? 0;
      perSite.set(host, n + 1);
      return n < 2;
    })
    .map(({ r }) => r);
}

export interface NewsEvent {
  headline: string;
  items: WebResult[];
}

const titleTokens = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );

/**
 * The same story from several outlets becomes one event (not ten versions of it): titles that
 * share enough words are grouped; the newest item leads.
 */
export function groupNews(results: WebResult[], threshold = 0.34): NewsEvent[] {
  const events: { tokens: Set<string>; items: WebResult[] }[] = [];
  for (const r of results) {
    const tokens = titleTokens(r.title);
    const match = events.find((e) => {
      const shared = [...tokens].filter((t) => e.tokens.has(t)).length;
      const union = new Set([...tokens, ...e.tokens]).size || 1;
      return shared / union >= threshold;
    });
    if (match) {
      match.items.push(r);
      for (const t of tokens) match.tokens.add(t);
    } else events.push({ tokens, items: [r] });
  }
  return events.map((e) => {
    const items = [...e.items].sort((a, b) =>
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
    );
    return { headline: items[0]!.title, items };
  });
}

/** Results clearly older than the question's window are flagged, never silently used as current. */
export function isStale(
  r: WebResult,
  recency: "day" | "week" | "month" | "year" | null,
  now: Date,
): boolean {
  if (!recency || !r.publishedAt) return false;
  const limit = { day: 2, week: 9, month: 35, year: 400 }[recency];
  return (now.getTime() - Date.parse(r.publishedAt)) / 86_400_000 > limit;
}
