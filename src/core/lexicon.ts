/**
 * Canonical names (ADR-065): how ELISE writes product and brand names, and how it recognizes a
 * known name that speech recognition misheard ("mielist" → "Mi ELISE"). Pure functions; the
 * per-user part of the vocabulary (Spaces, lists, contexts…) is passed in by the caller.
 */

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** ELISE's own names: always written this way, whatever casing the input had. */
export const PRODUCT_TERMS = ["Mi ELISE", "ELISE"] as const;

/**
 * Names whose casing is part of the name. Only unambiguous ones: "Make" or "Notion" are also
 * everyday words, so they are never re-cased automatically.
 */
export const BRAND_TERMS = [
  ...PRODUCT_TERMS,
  "ChatGPT",
  "OpenAI",
  "WhatsApp",
  "Power Automate",
  "UiPath",
  "RSFA",
  "UTN",
  "GPT",
] as const;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (term: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(term).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
const CASING = [...BRAND_TERMS]
  .sort((a, b) => b.length - a.length)
  .map((term) => ({ term, re: wordRe(term) }));

/**
 * "cargar finanzas en mi elise" → "cargar finanzas en Mi ELISE", "whatsapp a Juan" →
 * "WhatsApp a Juan". Whole words only; longest name first.
 * ponytail: a person called "Elise" is written "ELISE" too; per-user exceptions when it matters.
 */
export function applyCanonicalCasing(text: string): string {
  let out = text;
  for (const { term, re } of CASING) out = out.replace(re, term);
  return out;
}

// ── Recognizing a known name in a misheard one ───────────────────────────────

/**
 * A Spanish-first sound key: accents, silent h, b/v, s/z/soft c, k/qu/hard c, ll/y and doubled
 * letters sound alike, so "mi elise", "mielis" and "Mi Elis" share most of their key.
 */
export function phoneticKey(text: string): string {
  return fold(text)
    .replace(/[^a-z]/g, "")
    .replace(/(?<!c)h/g, "")
    .replace(/v/g, "b")
    .replace(/z/g, "s")
    .replace(/c([ei])/g, "s$1")
    .replace(/qu/g, "k")
    .replace(/c/g, "k")
    .replace(/ll/g, "y")
    .replace(/(.)\1+/g, "$1");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** 0–1: how alike two names sound (and read). */
export function soundSimilarity(a: string, b: string): number {
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (!ka || !kb) return 0;
  const sound = 1 - distance(ka, kb) / Math.max(ka.length, kb.length);
  const fa = fold(a).replace(/[^a-z0-9]/g, "");
  const fb = fold(b).replace(/[^a-z0-9]/g, "");
  const text = 1 - distance(fa, fb) / Math.max(fa.length, fb.length);
  return Math.max(sound, text);
}

/** "como tu nombre", "your name": the user is pointing at ELISE's own name. */
const SELF_NAME = /\b(como tu nombre|tu nombre|como vos|como te llam[aá]s|your name|like you)\b/i;

/** "se llama Mielist", "con T al final", "una app externa": the name is meant literally. */
const LITERAL =
  /\b(se llama|llamad[oa]|as[ií] se llama|con (una |la )?\p{L} al final|app externa|aplicaci[oó]n externa|otra app|literal(mente)?|as[ií] como (lo )?(dije|escrib[ií])|is called|named|spelled with|external app|another app)\b/iu;

export interface CanonicalReference {
  raw: string;
  resolved: string;
  /** 0–1. Resolved automatically only at AUTO_RESOLVE or above. */
  confidence: number;
  source: "product_lexicon" | "user_vocabulary";
}

export type CanonicalMatch =
  | { kind: "resolved"; ref: CanonicalReference }
  | { kind: "suggested"; ref: CanonicalReference }
  | { kind: "ambiguous"; raw: string; candidates: string[] };

export const AUTO_RESOLVE = 0.9;
const SUGGEST = 0.85;
const MIN_LENGTH = 5;

/**
 * Words in a message that are probably a known name heard wrong ("Mielist" for "Mi ELISE"), or
 * that name several known things ("Firbot": Firbot Solutions or Firbot Academy?). A word the user
 * says is literal is left alone, and so is anything that is already exactly a known name.
 * Sound and spelling alike are not enough on their own for an automatic fix: context ("como tu
 * nombre") has to back it.
 */
export function findCanonicalReferences(
  message: string,
  vocabulary: readonly string[] = [],
): CanonicalMatch[] {
  if (LITERAL.test(message)) return [];
  const terms = [
    ...PRODUCT_TERMS.map((t) => ({ term: t, source: "product_lexicon" as const })),
    ...vocabulary
      .filter((v) => v.trim().length >= 3)
      .map((t) => ({ term: t.trim(), source: "user_vocabulary" as const })),
  ];
  const known = new Set(terms.map((t) => fold(t.term)));
  const words = message.match(/[\p{L}\p{N}]+/gu) ?? [];
  const selfName = SELF_NAME.test(message);
  const out: CanonicalMatch[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < words.length; i++) {
    for (const size of [2, 1]) {
      const raw = words.slice(i, i + size).join(" ");
      if (size > words.length - i || seen.has(fold(raw))) continue;
      const folded = fold(raw);
      if (known.has(folded) || raw.replace(/\s/g, "").length < MIN_LENGTH) continue;
      // Part of a longer name the user already said exactly ("mi elise" contains "elise").
      if ([...known].some((k) => k.includes(folded) && fold(message).includes(k))) continue;

      // One word naming several known things: ask.
      const prefixed = terms.filter((t) => fold(t.term).split(/\s+/)[0] === folded);
      if (size === 1 && prefixed.length > 1) {
        seen.add(folded);
        out.push({ kind: "ambiguous", raw, candidates: prefixed.map((t) => t.term) });
        continue;
      }

      // Two words are compared only with names of several words ("mi elis" → "Mi ELISE"), so
      // "a compraz" never stands for a one-word name.
      const best = terms
        .filter((t) => size === 1 || /\s/.test(t.term))
        .map((t) => ({ ...t, score: soundSimilarity(raw, t.term) }))
        .sort((a, b) => b.score - a.score)[0];
      if (!best || best.score < SUGGEST) continue;
      const productHint = best.source === "product_lexicon" && selfName ? 0.1 : 0;
      const confidence = Math.min(0.99, best.score + productHint);
      const ref = { raw, resolved: best.term, confidence, source: best.source };
      seen.add(folded);
      out.push({ kind: confidence >= AUTO_RESOLVE ? "resolved" : "suggested", ref });
    }
  }
  return out;
}

/** Replaces each resolved reference in a text, whole words only, keeping everything else. */
export function applyAliases(
  text: string,
  aliases: readonly { from: string; to: string }[],
): string {
  let out = text;
  for (const a of aliases) out = out.replace(wordRe(a.from), a.to);
  return out;
}
