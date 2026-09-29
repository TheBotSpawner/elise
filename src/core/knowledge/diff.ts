/**
 * Deterministic difference between two texts at paragraph level (docs/architecture/09 §24):
 * code finds what changed, the model explains what it means.
 */
export interface TextDiff {
  added: string[];
  removed: string[];
  unchangedCount: number;
}

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

export function diffParagraphs(before: string, after: string): TextDiff {
  const a = paragraphs(before);
  const b = paragraphs(after);
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    added: b.filter((p) => !inA.has(p)),
    removed: a.filter((p) => !inB.has(p)),
    unchangedCount: b.filter((p) => inA.has(p)).length,
  };
}

/** Caps a diff for the model: the first changes in document order, each clipped. */
export function compactDiff(
  diff: TextDiff,
  maxItems = 12,
  maxChars = 500,
): TextDiff & { truncated: boolean } {
  const clip = (p: string) => (p.length > maxChars ? `${p.slice(0, maxChars)}…` : p);
  return {
    added: diff.added.slice(0, maxItems).map(clip),
    removed: diff.removed.slice(0, maxItems).map(clip),
    unchangedCount: diff.unchangedCount,
    truncated: diff.added.length > maxItems || diff.removed.length > maxItems,
  };
}
