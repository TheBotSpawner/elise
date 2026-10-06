import type { KnowledgeHit } from "./model";

/**
 * Retrieval policy (docs/architecture/09 §30-37): scope first, hybrid candidates, then a
 * deterministic evidence budget. The model only ever sees the selected passages.
 */
export const RETRIEVAL = {
  candidates: 16,
  /**
   * Candidates searched separately in what a Section inherits from its Space, so a large
   * Section can't crowd the parent's material out of the candidate list.
   */
  inheritedCandidates: 8,
  maxEvidence: 8,
  /** Total characters of evidence handed to the model per search. */
  budgetChars: 9000,
  perPassageChars: 1400,
  /** Below this cosine similarity a semantic-only hit is not evidence on its own. */
  minSimilarity: 0.3,
} as const;

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can de del did do does el en es esta este for from has have how i in is it la las " +
    "lo los me my of on or para por que qué se sobre su the this to un una was what when where which who why with y " +
    "cómo cuál cuando donde dónde dice dicen say says about our nuestro nuestra " +
    // Requests, not subjects ("buscame el cronograma", "mostrame…", "find me…").
    "buscame búscame buscá busca mostrame decime dame contame encontrame find show tell give"
  ).split(" "),
);

/**
 * Keywords for full-text search: significant words joined with OR, so natural-language
 * questions still match documents that share their key terms. Safe for to_tsquery.
 */
export function keywordQuery(question: string): string {
  const words = question
    .toLowerCase()
    .normalize("NFC")
    .match(/[\p{L}\p{N}]{3,}/gu);
  const unique = [...new Set((words ?? []).filter((w) => !STOPWORDS.has(w)))].slice(0, 12);
  return unique.join(" | ");
}

/** A hit counts as evidence when it shares key terms or is semantically close enough. */
export function isEvidence(hit: KnowledgeHit): boolean {
  return hit.keywordMatched || (hit.similarity ?? 0) >= RETRIEVAL.minSimilarity;
}

/**
 * Keeps the strongest passages within the budget, at most two per document so one long file
 * cannot crowd out the others.
 */
/** Inherited (parent Space) passages weigh a little less than the Section's own. */
export const INHERITED_WEIGHT = 0.85;

/** Two candidate lists as one, each chunk once (the Section's own copy first). */
export function mergeHits(
  own: readonly KnowledgeHit[],
  inherited: readonly KnowledgeHit[],
): KnowledgeHit[] {
  const seen = new Set(own.map((h) => h.chunkId));
  return [...own, ...inherited.filter((h) => !seen.has(h.chunkId))];
}

/** Section-first ordering: same evidence, the Section's own sources ahead on near-ties. */
export function preferPrimary(hits: readonly KnowledgeHit[], primary: readonly string[] | null) {
  if (!primary) return [...hits];
  const own = new Set(primary);
  return hits.map((h) => (own.has(h.spaceId) ? h : { ...h, score: h.score * INHERITED_WEIGHT }));
}

export function selectEvidence(hits: readonly KnowledgeHit[]): KnowledgeHit[] {
  const perItem = new Map<string, number>();
  const selected: KnowledgeHit[] = [];
  let used = 0;
  for (const hit of [...hits].filter(isEvidence).sort((a, b) => b.score - a.score)) {
    if (selected.length >= RETRIEVAL.maxEvidence) break;
    const count = perItem.get(hit.itemId) ?? 0;
    if (count >= 2) continue;
    const size = Math.min(hit.content.length, RETRIEVAL.perPassageChars);
    if (used + size > RETRIEVAL.budgetChars && selected.length > 0) break;
    perItem.set(hit.itemId, count + 1);
    selected.push(hit);
    used += size;
  }
  return selected;
}

export function citationLabel(hit: Pick<KnowledgeHit, "title" | "headingPath" | "page">): string {
  const where = hit.page ? `page ${hit.page}` : hit.headingPath.at(-1);
  return where ? `${hit.title} · ${where}` : hit.title;
}
