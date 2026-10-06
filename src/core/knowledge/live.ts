import { chunkDocument } from "./chunking";
import type { KnowledgeItemType, KnowledgeSourceType, NormalizedDocument } from "./model";
import { keywordQuery, RETRIEVAL } from "./retrieval";
import { matchKey } from "../history/links";

/**
 * Federated Knowledge (ADR-046): connected is not mirrored. Drive and Notion stay the source of
 * truth; ELISE keeps a metadata catalog of what they hold and, when a question needs them,
 * asks the provider (its own search, filters and sorts), reads only the few candidates that
 * can answer, and cites the original. Uploads and notes are ELISE's own copy: fully indexed.
 */

export type SourceMode = "native_indexed" | "external_live";

export function sourceMode(type: KnowledgeSourceType): SourceMode {
  return type === "upload" || type === "note" ? "native_indexed" : "external_live";
}

/** Bounds of one live search: a question never fans out into the whole repository. */
export const LIVE = {
  /** Connected roots (a Notion database or page, a Drive folder or file) asked per search. */
  maxRoots: 4,
  /** Records/files each root's provider search returns. */
  candidatesPerRoot: 5,
  /** Documents whose content is actually read per search. */
  maxFetches: 4,
  passagesPerDocument: 2,
  /** Recently read content, keyed by the provider's revision (never served once it changes). */
  cacheTtlMs: 10 * 60_000,
  cacheEntries: 64,
} as const;

/** "el último proyecto", "lo más reciente", "latest": newest first instead of best match. */
const RECENT = /\b(ultim[oa]s?|m[aá]s recientes?|reci[eé]n|latest|newest|most recent|last)\b/i;

export function wantsRecent(text: string): boolean {
  return RECENT.test(text.normalize("NFD").replace(/\p{M}/gu, ""));
}

/** The question's significant words, accent-free (what providers are searched for). */
export function searchTerms(text: string): string[] {
  const words = keywordQuery(text).split(" | ").filter(Boolean).map(matchKey);
  return [...new Set(words)].filter((w) => w.length >= 3 && !RECENT.test(w)).slice(0, 6);
}

/** A word matches a term exactly or by a shared stem ("proyecto" ~ "proyectos"). */
function wordMatches(word: string, term: string): boolean {
  if (word === term) return true;
  const stem = Math.min(term.length, word.length) >= 5 ? 5 : 0;
  return stem > 0 && word.slice(0, stem) === term.slice(0, stem);
}

/** How many of the terms a text contains. */
export function termScore(text: string, terms: readonly string[]): number {
  const words = matchKey(text).split(" ");
  return terms.filter((t) => words.some((w) => wordMatches(w, t))).length;
}

/**
 * What to search the provider for: the question's terms minus the words that only name where to
 * look. In "el cronograma de Análisis Matemático II" inside the AMII Drive folder, every file
 * says "Análisis Matemático II" — the subject is "cronograma". Empty when the question is only
 * the scope ("¿qué hay en la Pipeline?"): the provider then lists the newest.
 */
export function subjectTerms(terms: readonly string[], scopeNames: readonly string[]): string[] {
  const scope = scopeNames.join(" ");
  return terms.filter((t) => termScore(scope, [t]) === 0);
}

/** One thing the user connected that ELISE can ask: a Notion database or page, a Drive folder or file. */
export interface LiveRoot {
  sourceId: string;
  spaceId: string;
  sourceType: "google_drive" | "notion";
  connectionId: string;
  id: string;
  kind: "database" | "page" | "folder" | "file";
  name: string;
}

/**
 * Which roots to ask (Part F: resolve candidate sources). Roots whose name the question uses
 * come first ("la Pipeline" → Pipeline de Proyectos); the rest keep their order. Bounded.
 */
export function rankRoots<R extends Pick<LiveRoot, "name">>(
  roots: readonly R[],
  terms: readonly string[],
  max: number = LIVE.maxRoots,
): R[] {
  const scored = roots.map((r, i) => ({ r, i, s: termScore(r.name, terms) }));
  const best = Math.max(0, ...scored.map((x) => x.s));
  // A root the question names narrows the search to it: "el último proyecto de la Pipeline"
  // names Pipeline de Proyectos better than Pipeline Marketing, so only the former is asked.
  const pool = best > 0 ? scored.filter((x) => x.s === best) : scored;
  return pool
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.r);
}

/** A record or file the provider returned for a root, before its content is read. */
export interface LiveCandidate {
  root: LiveRoot;
  externalId: string;
  title: string;
  itemType: KnowledgeItemType;
  mimeType: string | null;
  url: string | null;
  modifiedAt: string | null;
  /** Provider revision (Drive version, Notion last_edited_time): the cache key. */
  revision: string;
  path: string[];
}

/** Best of every root first, then the next of each: one busy root can't take every fetch. */
export function pickCandidates(
  perRoot: readonly (readonly LiveCandidate[])[],
  max: number = LIVE.maxFetches,
): LiveCandidate[] {
  const out: LiveCandidate[] = [];
  const seen = new Set<string>();
  for (let rank = 0; out.length < max; rank++) {
    let any = false;
    for (const list of perRoot) {
      const c = list[rank];
      if (!c) continue;
      any = true;
      if (seen.has(c.externalId) || out.length >= max) continue;
      seen.add(c.externalId);
      out.push(c);
    }
    if (!any) break;
  }
  return out;
}

export interface LivePassage {
  content: string;
  headingPath: string[];
  page: number | null;
  /** Shares the question's terms (else it is the document's opening, kept as context). */
  matched: boolean;
}

/**
 * The passages of a fetched document worth handing to the model: those that share the most
 * terms; a candidate the provider chose without a matching passage (a "most recent" record, a
 * file found by its name) keeps its opening instead.
 */
export function selectPassages(
  doc: NormalizedDocument,
  terms: readonly string[],
  max: number = LIVE.passagesPerDocument,
): LivePassage[] {
  const chunks = chunkDocument(doc);
  if (!chunks.length) return [];
  const scored = chunks
    .map((c) => ({ c, s: termScore(c.content, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.c.index - b.c.index)
    .slice(0, max);
  const picked = scored.length ? scored.map((x) => x.c) : chunks.slice(0, 1);
  return picked.map((c) => ({
    content: c.content.slice(0, RETRIEVAL.perPassageChars * 2),
    headingPath: c.headingPath,
    page: c.page,
    matched: scored.length > 0,
  }));
}

/**
 * Live passages ranked next to indexed ones: the provider already ranked the documents, so a
 * live passage scores just under a strong hybrid hit and in its provider order.
 * ponytail: rank-based score, not a common relevance scale; good enough for ≤ 8 passages.
 */
export function liveScore(rank: number, matched: boolean): number {
  return (matched ? 0.033 : 0.02) - rank * 0.001;
}

/** A small time-bounded cache (cache ≠ source of truth: keys carry the provider revision). */
export class TtlCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly ttlMs: number = LIVE.cacheTtlMs,
    private readonly max: number = LIVE.cacheEntries,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    // Oldest first out.
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  /** Every cached revision of one resource leaves (it changed, or it is gone). */
  forget(prefix: string) {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

export const liveCacheKey = (c: Pick<LiveCandidate, "root" | "externalId" | "revision">) =>
  `${c.root.sourceType}:${c.externalId}:${c.revision}`;
