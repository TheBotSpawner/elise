import type { WebItem } from "./items";

/**
 * Web (ADR-015): the current external world, as evidence. Distinct from Knowledge (the user's
 * own sources), Recall (past interactions) and structured providers (private live data).
 * Canonical, vendor-free: the Core knows "Web", never the search provider behind it.
 */

export type WebResultKind = "web" | "news";
export type Recency = "day" | "week" | "month" | "year";

export interface WebResult {
  url: string;
  title: string;
  domain: string;
  snippet: string;
  /** Publication or last-update date, when the source states it (ISO date or date-time). */
  publishedAt: string | null;
  retrievedAt: string;
  kind: WebResultKind;
  /** Which provider found it (provenance, never shown as a score). */
  provider: string;
  /** Provider order, 0 = first (internal ranking input only). */
  rank: number;
}

export interface WebSearchQuery {
  query: string;
  kind: WebResultKind;
  recency: Recency | null;
  limit: number;
  language: "es" | "en" | null;
  /** Restrict to these domains (e.g. official docs), when the request calls for it. */
  domains?: string[];
}

/** A search provider (OpenAI web search, Tavily…), isolated in infrastructure. */
export interface WebSearchProvider {
  readonly id: string;
  search(query: WebSearchQuery, signal?: AbortSignal): Promise<WebResult[]>;
}

/** A page ELISE actually read: enough to cite exactly what was used. */
export interface WebPage {
  requestedUrl: string;
  /** After redirects. */
  url: string;
  domain: string;
  title: string;
  siteName: string | null;
  description: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  /** Readable text (boilerplate removed), capped. */
  text: string;
  truncated: boolean;
  /** Concrete items the page publishes as structured data (ADR-028). */
  items?: WebItem[];
  /** Same-site links that look like item pages, when the page has no structured items. */
  itemLinks?: string[];
}

/**
 * What tools use: search, read, keep within budget, and (only when asked) save to Knowledge.
 * Implemented by the application around the provider, the safe fetcher and a short cache.
 */
export interface WebCapability {
  search(query: WebSearchQuery): Promise<WebResult[]>;
  open(url: string): Promise<WebPage>;
  saveToKnowledge(page: WebPage, space: string | null): Promise<{ itemId: string; space: string }>;
}

/** Deterministic limits (ADR-015). ELISE never searches or reads without bounds. */
export const WEB_LIMITS = {
  resultsPerSearch: 8,
  /** Quick search: pages read to confirm the answer. */
  quickFetch: 2,
  researchSubquestions: 4,
  researchFetchPerQuestion: 2,
  researchFetchTotal: 8,
  /** One follow-up search per question that found nothing. */
  researchRetries: 1,
  pageBytes: 1_500_000,
  pageChars: 60_000,
  passagesPerSource: 3,
  passageChars: 600,
  fetchTimeoutMs: 9_000,
  searchTimeoutMs: 20_000,
  researchTimeoutMs: 45_000,
  maxRedirects: 4,
  /** Per workspace per day (cost control; resets at UTC midnight). */
  dailySearches: 300,
  dailyFetches: 600,
  cacheSearchMs: 10 * 60_000,
  cacheNewsMs: 5 * 60_000,
  cachePageMs: 30 * 60_000,
} as const;
