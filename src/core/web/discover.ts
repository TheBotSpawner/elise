import { itemKey, type WebItem } from "./items";
import { domainOf } from "./url";

/**
 * Discovery (ADR-028): "buscame publicaciones / opciones / departamentos…" asks for several
 * concrete items, not a page about them. Search finds candidate sources; discovery reads them,
 * extracts items, checks coverage against what was asked and continues — within strict bounds —
 * until it has enough or can say exactly why not. Pure policy, no I/O.
 */

export const DISCOVERY_LIMITS = {
  /** Search or follow steps. */
  rounds: 3,
  /** Pages read in total. */
  pages: 8,
  /** Pages read per step, in parallel. */
  perStep: 4,
  /** Item links followed from one listing page without structured items. */
  follow: 4,
  /** Without a named site, no site fills more than this many slots. */
  perDomain: 6,
  maxItems: 12,
  /** Purposeful query variants the model may add (never dozens). */
  variants: 2,
  timeoutMs: 40_000,
} as const;

export interface CollectionRequest {
  count: number;
  /** A site the user named: only its items count, nothing is substituted. */
  domain: string | null;
  /** Words the items should match ("2019", "automático", a neighbourhood). */
  terms: string[];
  minPrice: number | null;
  maxPrice: number | null;
  currency: string | null;
}

export type CoverageStatus = "sufficient" | "partial" | "insufficient";

export const onDomain = (url: string, domain: string) => {
  const d = domainOf(url);
  return d === domain || d.endsWith(`.${domain}`);
};

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * How well an item fits the request (higher is better), or null when it breaks a hard
 * constraint (another site than the one named, a price outside the range, another currency).
 */
export function itemScore(
  req: CollectionRequest,
  item: WebItem & { fromIndex?: boolean },
): number | null {
  if (req.domain && !onDomain(item.url, req.domain)) return null;
  if (item.price !== null) {
    const sameCurrency = !req.currency || !item.currency || item.currency === req.currency;
    if (sameCurrency && req.maxPrice !== null && item.price > req.maxPrice) return null;
    if (sameCurrency && req.minPrice !== null && item.price < req.minPrice) return null;
  }
  const hay = fold(`${item.title} ${item.attributes.map((a) => a.value).join(" ")}`);
  const matched = req.terms.filter((t) => hay.includes(fold(t))).length;
  const terms = req.terms.length ? matched / req.terms.length : 1;
  const complete =
    (item.price !== null ? 0.5 : 0) + (item.image ? 0.25 : 0) + (item.attributes.length ? 0.25 : 0);
  // Read from the item's own structured data beats a search-index title.
  return terms * 0.6 + complete * 0.3 + (item.fromIndex ? 0 : 0.1);
}

/** Matching items, best first (search order only breaks ties), deduplicated, site-balanced. */
export function rankItems<T extends WebItem & { fromIndex?: boolean }>(
  req: CollectionRequest,
  items: T[],
): T[] {
  const seen = new Set<string>();
  const scored = items
    .map((item, i) => ({ item, i, score: itemScore(req, item) }))
    .filter((x): x is { item: T; i: number; score: number } => x.score !== null)
    .filter((x) => !seen.has(itemKey(x.item)) && Boolean(seen.add(itemKey(x.item))))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const perDomain = new Map<string, number>();
  const out: T[] = [];
  for (const { item } of scored) {
    const n = perDomain.get(item.domain) ?? 0;
    if (!req.domain && n >= DISCOVERY_LIMITS.perDomain) continue;
    perDomain.set(item.domain, n + 1);
    out.push(item);
    if (out.length >= DISCOVERY_LIMITS.maxItems) break;
  }
  return out;
}

/** Requested vs retrieved: a relevant site with no concrete item is not task completion. */
export function coverageOf(req: CollectionRequest, found: number): CoverageStatus {
  if (found >= req.count) return "sufficient";
  return found >= Math.min(3, req.count) ? "partial" : "insufficient";
}

/** The original query first, then at most two distinct variants; a named site is kept in each. */
export function queryPlan(query: string, variants: readonly string[]): string[] {
  const seen = new Set<string>();
  return [query, ...variants.slice(0, DISCOVERY_LIMITS.variants)].filter((q) => {
    const k = fold(q.trim());
    return k && !seen.has(k) && Boolean(seen.add(k));
  });
}

/** Price facts computed in code, per currency (never mixed). */
export function priceFacts(items: WebItem[], locale: "es" | "en"): string[] {
  const byCurrency = new Map<string, number[]>();
  for (const i of items)
    if (i.price !== null && i.currency)
      byCurrency.set(i.currency, [...(byCurrency.get(i.currency) ?? []), i.price]);
  const fmt = (v: number) => v.toLocaleString(locale === "es" ? "es-AR" : "en-US");
  return [...byCurrency.entries()].map(([c, v]) =>
    v.length === 1
      ? `${c} ${fmt(v[0]!)} (1)`
      : `${c} ${fmt(Math.min(...v))}–${fmt(Math.max(...v))} (${v.length})`,
  );
}
