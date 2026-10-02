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
