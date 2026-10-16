import { applyCanonicalCasing } from "./lexicon";

/**
 * Text that is safe to store. Mathematical and emoji characters are two UTF-16 units; cutting
 * between them leaves a lone surrogate, which Postgres jsonb rejects — and the whole row (an
 * answer, a workspace) is lost. Clip at character boundaries and repair anything already split.
 */

/** At most `n` units with an ellipsis, never splitting a character. */
export function clipText(s: string | null | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  let cut = n - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${s.slice(0, cut)}…`;
}

/** Deep copy for storage: every string well-formed (lone surrogates become U+FFFD). */
export function wellFormed<T>(value: T): T {
  if (typeof value === "string") return value.toWellFormed() as T;
  if (Array.isArray(value)) return value.map((v) => wellFormed(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = wellFormed(v);
    return out as T;
  }
  return value;
}

/**
 * A name or title as people expect to see it (a task, a list item, a habit…), from however it
 * arrived — often a voice transcript in lowercase: "huevos" → "Huevos", "comprar huevos para la
 * semana" → "Comprar huevos para la semana". Sentence case, never Title Case, and never more:
 * - trims and collapses repeated spaces;
 * - upper-cases only the first letter, and only when the text starts with a word (leading emoji
 *   or punctuation are skipped: "🛍️ comprar leche" → "🛍️ Comprar leche"; a leading number
 *   already starts the sentence: "3 huevos" stays);
 * - leaves a first word the user capitalized on purpose alone: "iPhone", "eBay", "eLearning",
 *   "make.com", "ChatGPT", "NASA";
 * - never lower-cases anything, never fixes spelling;
 * - writes product and brand names as they are written (ADR-065): "mi elise" → "Mi ELISE",
 *   "whatsapp" → "WhatsApp".
 * For names and titles only — never descriptions, notes or long text.
 */
export function normalizeEntityTitle(text: string): string {
  const s = applyCanonicalCasing(text.trim().replace(/[ \t]+/g, " "));
  const first = s.search(/[\p{L}\p{N}]/u);
  if (first < 0) return s;
  const word = s.slice(first).split(" ")[0]!;
  const intended =
    /^\p{N}/u.test(word) || // "3 huevos": the sentence starts with the number
    /\p{Lu}/u.test(word) || // any capital already there: "iPhone", "eBay", "NASA"
    /[.@/:]\p{L}/u.test(word); // "make.com", an address or a path
  if (intended) return s;
  const letter = s[first]!;
  const upper = letter.toLocaleUpperCase();
  return upper === letter ? s : s.slice(0, first) + upper + s.slice(first + 1);
}
