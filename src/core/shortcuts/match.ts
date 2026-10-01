import { phraseKey, type Shortcut } from "./model";

/**
 * Shortcut matching (ADR-017 §11): an accelerator, never a replacement for understanding.
 * Only an exact (or near-exact) phrase runs automatically; anything else goes to normal
 * reasoning. "¿A qué hora arrancamos mañana?" never runs "Arrancamos".
 */

/** Words that may surround the phrase without changing what it means. */
const POLITE = new Set(
  "elise liz hey ey oye ok okay hola che por favor please porfa dale bueno".split(" "),
);

function strip(words: string[]): string[] {
  let a = 0;
  let b = words.length;
  while (a < b && POLITE.has(words[a]!)) a++;
  while (b > a && POLITE.has(words[b - 1]!)) b--;
  return words.slice(a, b);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length]![b.length]!;
}

export type ShortcutMatch =
  | { kind: "match"; shortcut: Shortcut; exact: boolean }
  | { kind: "ambiguous"; shortcuts: Shortcut[] }
  | { kind: "none" };

export function matchShortcut(utterance: string, shortcuts: Shortcut[]): ShortcutMatch {
  // A question is a question, not a command ("¿arrancamos?").
  if (/[?¿]/.test(utterance)) return { kind: "none" };
  const said = strip(phraseKey(utterance).split(" ").filter(Boolean)).join(" ");
  if (said.length < 3) return { kind: "none" };
  const hits: { s: Shortcut; exact: boolean }[] = [];
  for (const s of shortcuts.filter((x) => x.enabled)) {
    for (const p of s.phrases) {
      const key = strip(phraseKey(p).split(" ")).join(" ");
      if (key === said) hits.push({ s, exact: true });
      // One small slip of the recognizer on a long enough phrase ("mornig brief").
      else if (
        key.length >= 8 &&
        Math.abs(key.length - said.length) <= 1 &&
        distance(key, said) <= 1
      )
        hits.push({ s, exact: false });
    }
  }
  const unique = [...new Map(hits.map((h) => [h.s.id, h])).values()];
  if (unique.length > 1) return { kind: "ambiguous", shortcuts: unique.map((h) => h.s) };
  const only = unique[0];
  return only ? { kind: "match", shortcut: only.s, exact: only.exact } : { kind: "none" };
}

/** Two enabled shortcuts can't share a phrase (checked again in the database). */
export function phraseConflicts(phrases: string[], others: Shortcut[]): string[] {
  const keys = new Set(phrases.map(phraseKey));
  return others
    .filter((s) => s.enabled)
    .flatMap((s) => s.phrases.filter((p) => keys.has(phraseKey(p))));
}
