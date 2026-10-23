/**
 * Presentation discipline (ADR-048): a tool call is not a Surface. Within one turn the Canvas
 * shows what helps the user understand or act on the answer — not ELISE's retrieval plumbing.
 *
 *   plumbing     resolution and schema lookups never become Surfaces;
 *   consolidate  a search repeated in the same turn replaces its earlier result (retrieval
 *                rounds are one object, the last one);
 *   supersede    a database analysis replaces document searches of the same turn — the
 *                explicit source answered; so does email on an explicit email request
 *                (ADR-098), where document matches stay off the Canvas;
 *   budget       at most `maxPerTurn` new Surfaces per turn (approvals always show).
 */
export const PRESENTATION = { maxPerTurn: 4 } as const;

const PLUMBING: ReadonlySet<string> = new Set([
  "structured.listSources",
  "structured.getSchema",
  "knowledge.listSources",
  "tasks.listLists",
]);

const CONSOLIDATE: ReadonlySet<string> = new Set([
  "knowledge.search",
  "history.search",
  "web.search",
  "structured.query",
  "structured.analyze",
]);

/** What a finished analysis makes obsolete in the same turn. */
const SUPERSEDES: Readonly<Record<string, readonly string[]>> = {
  "structured.analyze": ["knowledge.search", "structured.query"],
  // "El último publicado" answered: the turn's searches and listings were the way there.
  "structured.latest": ["knowledge.search", "structured.query", "structured.analyze"],
};

export interface TurnPresentation {
  tool: string;
  ids: string[];
}

/** Resolution and schema lookups: never a card, in the Canvas or in the chat thread. */
export const isPlumbing = (tool: string) => PLUMBING.has(tool);

/** Before presenting: whether to, and which of this turn's Surfaces it replaces. */
export function beforePresenting(
  tool: string,
  earlier: readonly TurnPresentation[],
  /** The user asked about their email and named no document (tool-selection explicitEmail). */
  request: { email?: boolean } = {},
): { present: boolean; dismiss: string[] } {
  if (PLUMBING.has(tool)) return { present: false, dismiss: [] };
  if (request.email && tool === "knowledge.search") return { present: false, dismiss: [] };
  const replaced = new Set([
    ...(CONSOLIDATE.has(tool) ? [tool] : []),
    ...(SUPERSEDES[tool] ?? []),
    ...(request.email && tool.startsWith("email.") ? ["knowledge.search"] : []),
  ]);
  return {
    present: true,
    dismiss: earlier.filter((e) => replaced.has(e.tool)).flatMap((e) => e.ids),
  };
}

/**
 * After presenting: new Surfaces beyond the turn's budget are withdrawn (the earliest-kept are
 * the ones ELISE presented first). Ids already on screen before the turn don't count.
 */
export function overBudget(
  shownThisTurn: readonly string[],
  added: readonly string[],
  max: number = PRESENTATION.maxPerTurn,
): string[] {
  const kept = new Set(shownThisTurn);
  const fresh = added.filter((id) => !kept.has(id));
  const room = Math.max(0, max - kept.size);
  return fresh.slice(room);
}
