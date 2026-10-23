import { z } from "zod";

import type { MarketplaceApi, MarketplaceMode } from "./marketplace";
import type { PriceIndex } from "./price-reference";

/**
 * Shopping prices (ADR-111): public supermarket prices in Argentina, provider-independent. The
 * Core knows products (by barcode), chains, regions and prices with their date and how they were
 * aggregated — never SEPA's files or any provider's API. Every number here is computed
 * deterministically (integer cents); the model never does the arithmetic and never decides that
 * two different barcodes are "the same product".
 */

// ── Regions ──────────────────────────────────────────────────────────────────

/** Provinces (ISO 3166-2:AR). Prices are aggregated per chain and province. */
export const AR_PROVINCES = {
  "AR-C": "Ciudad de Buenos Aires",
  "AR-B": "Buenos Aires",
  "AR-K": "Catamarca",
  "AR-H": "Chaco",
  "AR-U": "Chubut",
  "AR-X": "Córdoba",
  "AR-W": "Corrientes",
  "AR-E": "Entre Ríos",
  "AR-P": "Formosa",
  "AR-Y": "Jujuy",
  "AR-L": "La Pampa",
  "AR-F": "La Rioja",
  "AR-M": "Mendoza",
  "AR-N": "Misiones",
  "AR-Q": "Neuquén",
  "AR-R": "Río Negro",
  "AR-A": "Salta",
  "AR-J": "San Juan",
  "AR-D": "San Luis",
  "AR-Z": "Santa Cruz",
  "AR-S": "Santa Fe",
  "AR-G": "Santiago del Estero",
  "AR-V": "Tierra del Fuego",
  "AR-T": "Tucumán",
} as const;
export type Region = keyof typeof AR_PROVINCES;
export const REGIONS = Object.keys(AR_PROVINCES) as [Region, ...Region[]];
export const regionSchema = z.enum(REGIONS);

export const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Words people use for each province, beyond its name. */
const REGION_ALIASES: Partial<Record<Region, string[]>> = {
  "AR-C": ["caba", "capital", "capital federal", "ciudad autonoma de buenos aires"],
  "AR-B": ["provincia de buenos aires", "pba", "gba", "conurbano", "gran buenos aires"],
  "AR-V": ["tierra del fuego", "ushuaia"],
  "AR-X": ["cordoba"],
  "AR-S": ["santa fe", "rosario"],
  "AR-M": ["mendoza"],
  "AR-T": ["tucuman"],
};

/**
 * A place as the person said it → a province, or why not. "AMBA" or "Buenos Aires" alone span
 * the city and the province: ELISE asks which instead of guessing (prices differ).
 */
export function regionFromWords(
  said: string,
): { kind: "one"; region: Region } | { kind: "ambiguous"; options: Region[] } | { kind: "none" } {
  const s = fold(said)
    .replace(/^(en |de |la |el )+/, "")
    .trim();
  if (!s) return { kind: "none" };
  if (s === "amba" || s === "buenos aires" || s === "bs as" || s === "bsas")
    return { kind: "ambiguous", options: ["AR-C", "AR-B"] };
  if ((REGIONS as string[]).includes(said.trim().toUpperCase()))
    return { kind: "one", region: said.trim().toUpperCase() as Region };
  for (const r of REGIONS) {
    const names = [fold(AR_PROVINCES[r]), ...(REGION_ALIASES[r] ?? [])];
    if (names.includes(s)) return { kind: "one", region: r };
  }
  return { kind: "none" };
}

// ── Products ─────────────────────────────────────────────────────────────────

/** A barcode as published (EAN-8/13, UPC-12, GTIN-14), or a chain's own numeric code. */
export const eanSchema = z.string().regex(/^\d{8,14}$/, "A product code is 8 to 14 digits");

/**
 * A barcode in one canonical form: GTIN-13 (EAN-8 and UPC-12 padded with zeros, a GTIN-14 with a
 * leading zero trimmed), or null when it isn't a valid barcode. Padding never changes the check
 * digit, so the same product always gets the same key, whoever published it.
 */
export function canonicalEan(code: string): string | null {
  let d = code.replace(/[\s-]/g, "");
  if (!/^\d{8,14}$/.test(d)) return null;
  if (d.length === 14) {
    if (!d.startsWith("0")) return isGtin(d) ? d : null;
    d = d.slice(1);
  }
  d = d.padStart(13, "0");
  return isGtin(d) ? d : null;
}

/** Whether a code passes the GTIN check digit (a chain's internal code may not). */
export function isGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export type SizeUnit = "g" | "ml" | "u";

/** "1 L", "500ml", "1kg", "x 6" → base units (g, ml, units). */
export interface Size {
  amount: number;
  unit: SizeUnit;
}

const UNITS: Record<string, { unit: SizeUnit; factor: number }> = {
  g: { unit: "g", factor: 1 },
  gr: { unit: "g", factor: 1 },
  grs: { unit: "g", factor: 1 },
  gramos: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  kgs: { unit: "g", factor: 1000 },
  kilo: { unit: "g", factor: 1000 },
  kilos: { unit: "g", factor: 1000 },
  kilogramo: { unit: "g", factor: 1000 },
  kilogramos: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  cc: { unit: "ml", factor: 1 },
  cm3: { unit: "ml", factor: 1 },
  mililitros: { unit: "ml", factor: 1 },
  l: { unit: "ml", factor: 1000 },
  lt: { unit: "ml", factor: 1000 },
  lts: { unit: "ml", factor: 1000 },
  litro: { unit: "ml", factor: 1000 },
  litros: { unit: "ml", factor: 1000 },
  un: { unit: "u", factor: 1 },
  u: { unit: "u", factor: 1 },
  unidad: { unit: "u", factor: 1 },
  unidades: { unit: "u", factor: 1 },
};

/** A unit word as SEPA or a person writes it ("kg", "Litros", "UN") → base unit and factor. */
export function unitOf(word: string): { unit: SizeUnit; factor: number } | null {
  return UNITS[fold(word).replace(/\.$/, "")] ?? null;
}

/** The size written in a product name or a request ("yerba de un kilo", "leche 1 L"). */
export function sizeIn(text: string): Size | null {
  const s = fold(text)
    .replace(/\bmedio (kilo|litro)\b/g, "0.5 $1")
    .replace(/\bun (kilo|litro)\b/g, "1 $1")
    .replace(/(\d),(\d)/g, "$1.$2");
  const m =
    /(\d+(?:\.\d+)?)\s?(kgs?|kilos?|kilogramos?|grs?|gramos|g|ml|cc|cm3|mililitros|lts?|litros?|l)\b/.exec(
      s,
    );
  if (!m) return null;
  const u = unitOf(m[2]!)!;
  return { amount: round(Number(m[1]) * u.factor, 3), unit: u.unit };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** "1 L", "500 g", "6 u": a size the way people read it. */
export function sizeLabel(size: Size): string {
  if (size.unit === "ml")
    return size.amount >= 1000 ? `${round(size.amount / 1000, 3)} L` : `${size.amount} ml`;
  if (size.unit === "g")
    return size.amount >= 1000 ? `${round(size.amount / 1000, 3)} kg` : `${size.amount} g`;
  return `${size.amount} u`;
}

export interface Product {
  ean: string;
  name: string;
  brand: string | null;
  size: Size | null;
}

/**
 * Words that make a different product, never an interchangeable one: "leche entera" is not
 * "leche descremada", "deslactosada" or "en polvo". A request that names one only matches
 * products that have it; a product that has one the request didn't name is never picked for
 * the person (only offered).
 */
const VARIANTS = [
  "entera",
  "descremada",
  "parcialmente descremada",
  "semidescremada",
  "deslactosada",
  "zero lactosa",
  "sin lactosa",
  "en polvo",
  "polvo",
  "light",
  "zero",
  "sin azucar",
  "sin tacc",
  "sin sal",
  "diet",
  "organica",
  "barbacoa",
  "integral",
  "compuesta",
  "con palo",
  "sin palo",
  "suave",
  "intensa",
  "girasol",
  "oliva",
  "maiz",
  "mezcla",
  "chocolatada",
  "poleo",
  "hierbas",
  "limon",
  "naranja",
  "menta",
  "frutilla",
  "vainilla",
  "durazno",
];

const variantsOf = (text: string) => {
  const s = ` ${fold(text)} `;
  return VARIANTS.filter((v) => s.includes(` ${v} `));
};

const STOP = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "x",
  "con",
  "y",
  "en",
  "para",
  "por",
]);
/** "leches" → "lech", "panes" → "pan", "fideos" → "fideo": a plural still finds the product. */
export const stem = (w: string) => {
  const s = w.replace(/(es|s)$/, "");
  return s.length >= 3 ? s : w;
};

const words = (s: string) =>
  fold(s)
    .replace(/[^\p{L}\p{N}. ]+/gu, " ")
    .split(" ")
    .filter((w) => w && !STOP.has(w) && !/^\d/.test(w) && !unitOf(w));

/** How a list line maps to a product. */
export type MatchMethod = "barcode" | "confirmed" | "name";

export interface Candidate {
  product: Product;
  /** 0–1: how well the words, size and variant agree (never a guarantee). */
  confidence: number;
  /** Same size as asked (or no size asked). */
  sameSize: boolean;
  /** Has a variant the request didn't name ("deslactosada" for "leche"). */
  extraVariant: string[];
}

/**
 * Candidates for words the person said, best first. A product that lacks a variant they named,
 * or has a different size than they asked for, is never returned as a match (a different size
 * is a different product). Nothing here picks for them: name matches are always confirmed.
 */
export function rankCandidates(request: string, products: readonly Product[]): Candidate[] {
  const want = words(request).map(stem);
  const wantVariants = variantsOf(request);
  const wantSize = sizeIn(request);
  const out: Candidate[] = [];
  for (const p of products) {
    const text = `${p.name} ${p.brand ?? ""}`;
    const have = new Set(words(text));
    const hits = want.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w)));
    if (!want.length || hits.length < Math.ceil(want.length * 0.6)) continue;
    const variants = variantsOf(text);
    if (wantVariants.some((v) => !variants.includes(v))) continue;
    const size = p.size ?? sizeIn(p.name);
    const sameSize =
      !wantSize ||
      (size !== null && size.unit === wantSize.unit && size.amount === wantSize.amount);
    if (wantSize && !sameSize) continue;
    const extraVariant = variants.filter((v) => !wantVariants.includes(v));
    const confidence = round(
      (hits.length / want.length) * 0.7 + (wantSize ? 0.2 : 0.1) + (extraVariant.length ? 0 : 0.1),
      2,
    );
    out.push({ product: p, confidence, sameSize, extraVariant });
  }
  return out.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.product.name.length - b.product.name.length ||
      a.product.ean.localeCompare(b.product.ean),
  );
}

// ── Prices ───────────────────────────────────────────────────────────────────

export interface Chain {
  id: string;
  name: string;
}

/**
 * One chain's price for one product in one province, aggregated over its branches that
 * published it that day (never a quote from a specific store).
 */
export interface ChainPrice {
  chain: Chain;
  region: Region;
  /** Median list price over branches, in cents. */
  listCents: number;
  /** Lowest branch list price, in cents. */
  minCents: number;
  branches: number;
  /** A general promotion anyone gets (promo 1), median over branches that have it. */
  promoCents: number | null;
  promoLabel: string | null;
  /**
   * A conditional promotion (promo 2: a bank, a card, a membership): never applied to totals,
   * only mentioned with its conditions.
   */
  conditionalLabel: string | null;
  /** The day the chain published it (YYYY-MM-DD). */
  quoteDate: string;
}

/** A price older than this isn't "current": shown with its date, never used for an alert. */
export const STALE_AFTER_DAYS = 4;

export function ageDays(quoteDate: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${quoteDate}T12:00:00-03:00`)) / 86_400_000);
}

/** Cents → "$1.234,50" (es-AR). */
export function ars(cents: number): string {
  const n = cents / 100;
  return `$${n.toLocaleString("es-AR", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Price per base unit (per liter, per kilo, per unit), in cents; null without a size. */
export function perUnitCents(
  cents: number,
  size: Size | null,
): { cents: number; per: string } | null {
  if (!size || size.amount <= 0) return null;
  if (size.unit === "u") return { cents: Math.round(cents / size.amount), per: "u" };
  return { cents: Math.round((cents * 1000) / size.amount), per: size.unit === "g" ? "kg" : "L" };
}

// ── Basket ───────────────────────────────────────────────────────────────────

export interface BasketLine {
  /** The list item (or a request line) this is. */
  key: string;
  label: string;
  /** Null when it isn't mapped to a product yet: it can't be priced. */
  ean: string | null;
  /** How many of that product (packages, not liters). */
  quantity: number;
}

export interface BasketChainTotal {
  chain: Chain;
  /** Lines this chain has a price for. */
  covered: number;
  /** Sum over the lines it covers (not comparable between chains with different coverage). */
  availableCents: number;
  /** Sum over the lines every compared chain has (comparable). */
  commonCents: number;
  /** All requested lines are priced here. */
  full: boolean;
  /** Its full-basket total — only when `full`. */
  fullCents: number | null;
}

export interface BasketComparison {
  region: Region;
  lines: {
    key: string;
    label: string;
    ean: string | null;
    quantity: number;
    product: Product | null;
    /** Per chain: unit price and line cost (cents); absent where the chain doesn't have it. */
    prices: {
      chainId: string;
      unitCents: number;
      lineCents: number;
      promoLabel: string | null;
      conditionalLabel: string | null;
    }[];
    cheapestChainId: string | null;
    status: "priced" | "unresolved" | "no_price";
    /** In every compared chain. */
    common: boolean;
  }[];
  chains: BasketChainTotal[];
  /** Lines in every compared chain. */
  commonLines: number;
  /** The chain with the lowest common subtotal, when there are common lines and ≥2 chains. */
  cheapestCommon: { chainId: string; savingsCents: number; vsChainId: string } | null;
  /** Chains whose full basket is priced, cheapest first. */
  fullCoverage: { chainId: string; cents: number }[];
  /** Oldest quote used (YYYY-MM-DD). */
  oldestQuote: string | null;
  warnings: string[];
}

/**
 * The deterministic comparison: list prices (promotions are never assumed), integer cents,
 * quantities multiplied, and three honest totals — what each chain has, what all of them have in
 * common, and the full basket only where every line is priced. A chain missing a line is never
 * "cheaper" for the whole list.
 */
export function compareBasket(
  region: Region,
  lines: readonly BasketLine[],
  prices: ReadonlyMap<string, readonly ChainPrice[]>,
  products: ReadonlyMap<string, Product>,
  options: { chains?: readonly string[] } = {},
): BasketComparison {
  const warnings: string[] = [];
  const allowed = options.chains?.length ? new Set(options.chains) : null;
  const chainById = new Map<string, Chain>();
  let oldest: string | null = null;
  const rows = lines.map((l) => {
    const quantity = Math.max(1, Math.min(99, Math.round(l.quantity)));
    if (quantity !== l.quantity) warnings.push(`quantity_adjusted:${l.key}`);
    const found = l.ean ? (prices.get(l.ean) ?? []) : [];
    // One price per chain (the first, should a provider repeat one), valid amounts only.
    const byChain = new Map<string, ChainPrice>();
    for (const p of found) {
      if (p.region !== region || !(p.listCents > 0) || !Number.isFinite(p.listCents)) continue;
      if (allowed && !allowed.has(p.chain.id)) continue;
      if (!byChain.has(p.chain.id)) byChain.set(p.chain.id, p);
    }
    const priced = [...byChain.values()].map((p) => {
      chainById.set(p.chain.id, p.chain);
      if (!oldest || p.quoteDate < oldest) oldest = p.quoteDate;
      return {
        chainId: p.chain.id,
        unitCents: p.listCents,
        lineCents: p.listCents * quantity,
        promoLabel: p.promoLabel,
        conditionalLabel: p.conditionalLabel,
      };
    });
    const cheapest = [...priced].sort(
      (a, b) => a.unitCents - b.unitCents || a.chainId.localeCompare(b.chainId),
    )[0];
    return {
      key: l.key,
      label: l.label,
      ean: l.ean,
      quantity,
      product: l.ean ? (products.get(l.ean) ?? null) : null,
      prices: priced,
      cheapestChainId: cheapest?.chainId ?? null,
      status: !l.ean
        ? ("unresolved" as const)
        : priced.length
          ? ("priced" as const)
          : ("no_price" as const),
      common: false,
    };
  });
  const chainIds = [...chainById.keys()].sort();
  for (const r of rows)
    r.common =
      r.status === "priced" && chainIds.every((c) => r.prices.some((p) => p.chainId === c));
  const commonLines = rows.filter((r) => r.common).length;
  const chains: BasketChainTotal[] = chainIds.map((id) => {
    const mine = rows.flatMap((r) =>
      r.prices.filter((p) => p.chainId === id).map((p) => ({ r, p })),
    );
    const full = mine.length === rows.length;
    const availableCents = mine.reduce((s, x) => s + x.p.lineCents, 0);
    return {
      chain: chainById.get(id)!,
      covered: mine.length,
      availableCents,
      commonCents: mine.filter((x) => x.r.common).reduce((s, x) => s + x.p.lineCents, 0),
      full,
      fullCents: full ? availableCents : null,
    };
  });
  let cheapestCommon: BasketComparison["cheapestCommon"] = null;
  if (commonLines > 0 && chains.length >= 2) {
    const sorted = [...chains].sort(
      (a, b) => a.commonCents - b.commonCents || a.chain.id.localeCompare(b.chain.id),
    );
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    cheapestCommon = {
      chainId: best.chain.id,
      savingsCents: worst.commonCents - best.commonCents,
      vsChainId: worst.chain.id,
    };
  }
  if (rows.some((r) => r.status === "unresolved")) warnings.push("unresolved_lines");
  if (rows.some((r) => r.status === "no_price")) warnings.push("lines_without_price");
  if (commonLines < rows.filter((r) => r.status === "priced").length)
    warnings.push("coverage_differs");
  return {
    region,
    lines: rows,
    chains,
    commonLines,
    cheapestCommon,
    fullCoverage: chains
      .filter((c) => c.full)
      .map((c) => ({ chainId: c.chain.id, cents: c.fullCents! }))
      .sort((a, b) => a.cents - b.cents),
    oldestQuote: oldest,
    warnings,
  };
}

// ── History ──────────────────────────────────────────────────────────────────

export interface HistoryPoint {
  date: string;
  cents: number;
}

/**
 * Delta-only observations → a daily step series from `from` to `to`: a day with an observation is
 * `observed`; the days after it carry its value forward (`carried`). Days before the first
 * observation have no value (never zero).
 */
export function stepSeries(
  points: readonly HistoryPoint[],
  from: string,
  to: string,
): { date: string; cents: number | null; observed: boolean }[] {
  const sorted = [...points]
    .filter((p) => p.cents > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: { date: string; cents: number | null; observed: boolean }[] = [];
  let i = 0;
  let last: number | null = null;
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const day = d.toISOString().slice(0, 10);
    while (i < sorted.length && sorted[i]!.date < day) last = sorted[i++]!.cents;
    const today = sorted[i]?.date === day ? sorted[i]!.cents : null;
    if (today !== null) {
      last = today;
      i++;
    }
    out.push({ date: day, cents: today ?? last, observed: today !== null });
    if (out.length > 800) break;
  }
  return out;
}

/** Change between the first and last real observations in a window (never a carried day). */
export function priceChange(points: readonly HistoryPoint[]): {
  from: HistoryPoint;
  to: HistoryPoint;
  percent: number;
} | null {
  const s = [...points].filter((p) => p.cents > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (s.length < 2) return null;
  const from = s[0]!;
  const to = s[s.length - 1]!;
  return { from, to, percent: round(((to.cents - from.cents) / from.cents) * 100, 1) };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface PriceAlert {
  ean: string;
  region: Region;
  thresholdCents: number;
  chains: string[] | null;
  /** "armed": waiting for a crossing · "triggered": notified, re-arms once above again. */
  state: "armed" | "triggered";
}

/**
 * One check of an alert against today's prices. It fires once when the lowest eligible list price
 * crosses to or below the threshold, then re-arms only after the price goes back above it — so a
 * price sitting under the threshold never notifies every day. Old or missing data never fires.
 */
export function evaluateAlert(
  alert: PriceAlert,
  prices: readonly ChainPrice[],
  now: Date,
): { outcome: "fire" | "rearm" | "hold" | "stale" | "no_data"; best: ChainPrice | null } {
  const eligible = prices.filter(
    (p) =>
      p.region === alert.region &&
      p.listCents > 0 &&
      (!alert.chains?.length || alert.chains.includes(p.chain.id)),
  );
  if (!eligible.length) return { outcome: "no_data", best: null };
  const fresh = eligible.filter((p) => ageDays(p.quoteDate, now) <= STALE_AFTER_DAYS);
  if (!fresh.length) return { outcome: "stale", best: null };
  const best = [...fresh].sort((a, b) => a.listCents - b.listCents)[0]!;
  const below = best.listCents <= alert.thresholdCents;
  if (alert.state === "armed") return { outcome: below ? "fire" : "hold", best };
  return { outcome: below ? "hold" : "rearm", best };
}

// ── Ports ────────────────────────────────────────────────────────────────────

/** Where the day's public prices are, as of which dataset day. */
export interface PriceSnapshotInfo {
  region: Region;
  /** The dataset day (YYYY-MM-DD). */
  date: string;
  builtAt: string;
  /** Official dataset page, for attribution. */
  dataset: string;
}

/** The public data ELISE reads (implemented over Supabase; fixtures in tests). */
export interface ShoppingData {
  /** Products whose folded name/brand contain every word; at most `limit`. */
  searchCatalog(words: readonly string[], limit: number): Promise<Product[]>;
  products(eans: readonly string[]): Promise<Map<string, Product>>;
  /** Today's prices in a province for these barcodes; null when there is no data for it. */
  prices(
    region: Region,
    eans: readonly string[],
  ): Promise<{ prices: Map<string, ChainPrice[]>; info: PriceSnapshotInfo } | null>;
  /** Observed list prices (delta-only) since a day, per chain. */
  history(
    region: Region,
    ean: string,
    since: string,
  ): Promise<{ chain: Chain; points: HistoryPoint[] }[]>;
}

export interface LinkedLine {
  itemId: string;
  label: string;
  ean: string | null;
  quantity: number;
  method: "barcode" | "confirmed" | null;
}

export interface AlertView {
  id: string;
  ean: string;
  productName: string;
  region: Region;
  thresholdCents: number;
  chains: string[] | null;
  status: "active" | "paused";
  state: "armed" | "triggered";
  lastCheck: string | null;
  lastCheckedAt: string | null;
  lastBestCents: number | null;
  lastBestChain: string | null;
  lastQuoteDate: string | null;
}

/** What ELISE's shopping tools use (implemented in the application layer). */
export interface ShoppingCapability {
  data: ShoppingData;
  /** ADR-112: Mercado Libre's official API, when enabled and approved; null otherwise. */
  marketplace: MarketplaceApi | null;
  /** ADR-116: Google Shopping prices (SerpApi), when enabled with a key; null otherwise. */
  priceIndex: PriceIndex | null;
  /** ADR-112: "solo / evitá Mercado Libre" kept for next time (null = the default, prefer). */
  marketplaceMode(): Promise<MarketplaceMode | null>;
  saveMarketplaceMode(mode: MarketplaceMode | null): Promise<void>;
  /** The person's saved shopping province (never inferred from a timezone). */
  region(): Promise<Region | null>;
  saveRegion(region: Region): Promise<void>;
  /** A list's open items with the products they're linked to. */
  listLines(listId: string): Promise<LinkedLine[]>;
  link(
    itemId: string,
    ean: string,
    quantity: number,
    method: "barcode" | "confirmed",
  ): Promise<void>;
  unlink(itemId: string): Promise<void>;
  alerts: {
    list(): Promise<AlertView[]>;
    create(a: {
      ean: string;
      productName: string;
      region: Region;
      thresholdCents: number;
      chains: string[] | null;
    }): Promise<AlertView>;
    remove(id: string): Promise<void>;
  };
}

/** At most this many active price alerts per person. */
export const MAX_ALERTS = 20;
