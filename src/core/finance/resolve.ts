/**
 * Account and category resolution for imports (ADR-073): each distinct name of a file is
 * placed once — on an existing account/category, a new one, or "the user decides" — and every
 * row reuses that decision. Deterministic first (exact, the user's own aliases, common
 * bilingual synonyms, conservative look-alikes); the model only weighs what's left, and a
 * name that could be two different things is never guessed.
 */

export interface Named {
  id: string;
  name: string;
}

export type ResolutionHow =
  "exact" | "alias" | "synonym" | "similar" | "semantic" | "created" | "review";

export interface Resolution {
  /** The name as the file writes it (first spelling seen). */
  raw: string;
  /** Stable identity of the name: decisions and aliases are keyed by it. */
  key: string;
  how: ResolutionHow;
  /** Matched existing record (absent: create, or review). */
  id?: string;
  /** What ELISE will show: the existing name, or the new one. */
  name: string;
  /** For review: the plausible existing records. */
  candidates?: Named[];
}

/**
 * A name's identity for matching: no emoji or symbols, no accents or case, single spaces.
 * "🍜 Food", "food" and " FOOD " are the same category; "Banco Nación" is "banco nacion".
 */
export function entityKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}\u{200d}\u{e000}-\u{f8ff}]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

/** The name to create: the file's label without decorative symbols ("🍜 Food" → "Food"). */
export function displayName(raw: string): string {
  const clean = raw
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}\u{200d}\u{e000}-\u{f8ff}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || raw.trim()).slice(0, 80);
}

/**
 * Names that mean the same in personal finance, across Spanish and English. Each group is one
 * meaning; a file's name matches an existing one when both fall in the same group.
 * ponytail: a fixed list; the model covers what it misses (semantic pass).
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ["efectivo", "cash", "billetes", "contado", "cash wallet"],
  ["comida", "food", "alimentos", "comidas", "restaurantes", "restaurants", "dining", "delivery"],
  ["supermercado", "groceries", "super", "almacen", "grocery"],
  ["transporte", "transport", "transportation", "movilidad"],
  ["auto", "car", "vehiculo", "vehicle", "coche"],
  ["entretenimiento", "entertainment", "ocio", "diversion"],
  ["regalos", "regalo", "gifts", "gift"],
  ["salud", "health", "medicina", "medical"],
  ["alquiler", "rent", "renta"],
  ["sueldo", "sueldos", "salario", "salary", "wages", "wage", "payroll"],
  ["servicios", "services", "utilities"],
  ["educacion", "education", "estudios", "cursos"],
  ["viajes", "viaje", "travel", "trips"],
  ["ropa", "indumentaria", "apparel", "clothing", "clothes"],
  ["belleza", "beauty", "cuidado personal", "personal care"],
  ["hogar", "household", "casa", "home"],
  ["herramientas", "tools"],
  ["prestamos", "prestamo", "lending", "loans", "loan"],
  ["ventas", "sales", "venta"],
  ["pasatiempos", "hobbies", "hobby"],
  ["salidas", "social"],
  ["otros", "otro", "other", "others", "varios", "misc", "miscellaneous"],
  ["impuestos", "taxes", "tax"],
  ["suscripciones", "subscriptions", "subscription"],
  ["ganancias", "profit", "profits", "rendimientos", "returns"],
  ["inversiones", "investments", "investment"],
  ["mascotas", "pets", "pet"],
  ["networking", "relaciones"],
  ["mercado pago", "mercadopago", "mp"],
  ["banco nacion", "bna", "banco de la nacion", "banco de la nacion argentina"],
  ["naranja x", "naranjax"],
];

const groupOf = new Map<string, number>();
SYNONYMS.forEach((g, i) => g.forEach((w) => groupOf.set(w, i)));

const tokens = (key: string) => key.split(" ").filter(Boolean);
const compact = (key: string) => key.replace(/ /g, "");

/**
 * One name → its resolution among `existing`. `aliases` are the user's own past decisions
 * (key → id). Returns null when nothing deterministic applies (the semantic pass decides,
 * else a new record is created).
 */
export function resolveName(
  raw: string,
  existing: readonly Named[],
  aliases: Readonly<Record<string, string>> = {},
): Resolution | null {
  const key = entityKey(raw);
  const base = { raw, key };
  const keyed = existing.map((e) => ({ ...e, key: entityKey(e.name) }));
  const exact = keyed.filter((e) => e.key === key);
  if (exact.length === 1) return { ...base, how: "exact", id: exact[0]!.id, name: exact[0]!.name };
  if (exact.length > 1)
    return { ...base, how: "review", name: displayName(raw), candidates: exact };
  const alias = aliases[key] ? existing.find((e) => e.id === aliases[key]) : undefined;
  if (alias) return { ...base, how: "alias", id: alias.id, name: alias.name };
  const group = groupOf.get(key);
  if (group !== undefined) {
    const same = keyed.filter((e) => groupOf.get(e.key) === group);
    if (same.length === 1) return { ...base, how: "synonym", id: same[0]!.id, name: same[0]!.name };
    if (same.length > 1)
      return { ...base, how: "review", name: displayName(raw), candidates: same };
  }
  // Look-alikes: the same letters without spaces ("NaranjaX" / "Naranja X"), or one name
  // contained in the other ("Galicia" / "Banco Galicia"). Several → the user decides; a short,
  // generic word ("Banco") → the user decides too.
  const glued = keyed.filter((e) => compact(e.key) === compact(key));
  if (glued.length === 1)
    return { ...base, how: "similar", id: glued[0]!.id, name: glued[0]!.name };
  const mine = tokens(key);
  const contains = keyed.filter((e) => {
    const theirs = tokens(e.key);
    const [short, long] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    return short.length > 0 && short.every((t) => t.length >= 3 && long.includes(t));
  });
  if (contains.length === 1) {
    const shorter = Math.min(key.length, contains[0]!.key.length);
    const specific = Math.min(mine.length, tokens(contains[0]!.key).length) >= 2 || shorter >= 7;
    return specific
      ? { ...base, how: "similar", id: contains[0]!.id, name: contains[0]!.name }
      : { ...base, how: "review", name: displayName(raw), candidates: contains };
  }
  if (contains.length > 1)
    return { ...base, how: "review", name: displayName(raw), candidates: contains };
  return null;
}

/** Distinct names of a list, by key, keeping the first spelling (and how often each appears). */
export function distinctNames(values: readonly (string | null | undefined)[]) {
  const seen = new Map<string, { raw: string; count: number }>();
  for (const v of values) {
    const raw = v?.trim();
    if (!raw) continue;
    const key = entityKey(raw);
    if (!key) continue;
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { raw, count: 1 });
  }
  return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
}
