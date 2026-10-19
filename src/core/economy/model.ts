/**
 * Public economic data (ADR-094): exchange rates, inflation, holidays, deposit rates and a few
 * indicators — a capability of ELISE, not a user connection. Providers (DolarApi for current
 * rates, ArgentinaDatos for history, indices and calendars) stay behind this contract; every
 * figure carries where and when it came from, and every calculation here is code, never the
 * model's arithmetic.
 */

/** Where a figure came from: provider, the page to cite, when ELISE read it, and if it's old. */
export interface Source {
  provider: "dolarapi" | "argentinadatos";
  /** The service to cite ("ArgentinaDatos"); the original source when known ("BCRA", "INDEC"). */
  name: string;
  original: string | null;
  url: string;
  /** When ELISE read it (ISO). Never a publication date. */
  fetchedAt: string;
  /** The provider failed and this is the last good copy. */
  stale: boolean;
}

export interface Sourced<T> {
  value: T;
  source: Source;
}

// ── Exchange rates (USD/ARS, by market) ──────────────────────────────────────

/** Argentina's dollar markets, by their canonical names (the providers' own "casa"). */
export const FX_MARKETS = [
  "oficial",
  "blue",
  "bolsa",
  "contadoconliqui",
  "mayorista",
  "cripto",
  "tarjeta",
  "solidario",
] as const;
export type FxMarket = (typeof FX_MARKETS)[number];

/** How people name them. "MEP" is bolsa; "CCL" is contado con liquidación; "turista" is tarjeta. */
const FX_ALIASES: Record<string, FxMarket> = {
  oficial: "oficial",
  official: "oficial",
  bna: "oficial",
  "banco nacion": "oficial",
  blue: "blue",
  paralelo: "blue",
  informal: "blue",
  bolsa: "bolsa",
  mep: "bolsa",
  "dolar mep": "bolsa",
  ccl: "contadoconliqui",
  contadoconliqui: "contadoconliqui",
  "contado con liqui": "contadoconliqui",
  "contado con liquidacion": "contadoconliqui",
  cable: "contadoconliqui",
  mayorista: "mayorista",
  wholesale: "mayorista",
  cripto: "cripto",
  crypto: "cripto",
  usdt: "cripto",
  tarjeta: "tarjeta",
  turista: "tarjeta",
  card: "tarjeta",
  solidario: "solidario",
  ahorro: "solidario",
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^d[oó]lar(es)?\s+/u, "")
    .replace(/\s+/g, " ")
    .trim();

/** "MEP", "dólar blue", "contado con liqui" → the market, or null (never a guess). */
export function fxMarketOf(said: string): FxMarket | null {
  return FX_ALIASES[fold(said)] ?? null;
}

export const FX_LABELS: Record<FxMarket, { es: string; en: string }> = {
  oficial: { es: "Oficial", en: "Official" },
  blue: { es: "Blue", en: "Blue" },
  bolsa: { es: "MEP (bolsa)", en: "MEP" },
  contadoconliqui: { es: "Contado con liquidación", en: "CCL" },
  mayorista: { es: "Mayorista", en: "Wholesale" },
  cripto: { es: "Cripto", en: "Crypto" },
  tarjeta: { es: "Tarjeta", en: "Card" },
  solidario: { es: "Solidario", en: "Solidario" },
};

/** One market's current quote: buy and sell are never merged into "the price". */
export interface FxQuote {
  market: FxMarket;
  buy: number | null;
  sell: number | null;
  /** The provider's own timestamp for this quote (ISO), or null. */
  asOf: string | null;
}

/** One market on one calendar day (the provider's date, Argentina). */
export interface FxPoint {
  market: FxMarket;
  date: string;
  buy: number | null;
  sell: number | null;
}

/** Sell minus buy, and as a share of buy: the spread, with its definition in the name. */
export function spread(q: Pick<FxQuote, "buy" | "sell">) {
  if (q.buy === null || q.sell === null || q.buy <= 0) return null;
  return {
    amount: round(q.sell - q.buy, 2),
    percentOfBuy: round(((q.sell - q.buy) / q.buy) * 100, 2),
  };
}

/** How a period moved, from the side asked ("venta" by default): first and last day, computed. */
export function fxChange(points: readonly FxPoint[], side: "buy" | "sell") {
  const usable = [...points]
    .filter((p) => p[side] !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (usable.length < 2) return null;
  const first = usable[0]!;
  const last = usable.at(-1)!;
  const values = usable.map((p) => p[side]!);
  return {
    from: first.date,
    to: last.date,
    start: first[side]!,
    end: last[side]!,
    change: round(last[side]! - first[side]!, 2),
    changePercent: round(((last[side]! - first[side]!) / first[side]!) * 100, 2),
    high: Math.max(...values),
    low: Math.min(...values),
    days: usable.length,
  };
}

/**
 * Pesos for an amount of dollars, or dollars for pesos, at one quote. Selling dollars gets
 * the buy price; buying them costs the sell price. An estimate: nothing is recorded.
 */
export function convert(
  amount: number,
  direction: "usd_to_ars" | "ars_to_usd",
  q: Pick<FxQuote, "buy" | "sell">,
) {
  const rate = direction === "usd_to_ars" ? q.buy : q.sell;
  if (rate === null || rate <= 0) return null;
  return {
    rate,
    side: direction === "usd_to_ars" ? ("buy" as const) : ("sell" as const),
    result: round(direction === "usd_to_ars" ? amount * rate : amount / rate, 2),
  };
}

// ── Inflation ────────────────────────────────────────────────────────────────

/** A monthly figure: the month it measures ("2026-09") and the percent change. */
export interface MonthlyFigure {
  month: string;
  value: number;
}

/** The provider's month-end date ("2026-09-30") → the month it measures ("2026-09"). */
export const monthOf = (date: string) => date.slice(0, 7);

const nextMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
};

/** Every month from `from` to `to`, inclusive ("2026-01".."2026-03" → three). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = nextMonth(m)) out.push(m);
  return out;
}

/**
 * Accumulated inflation over whole months, compounded — ((1+r1)…(1+rn) − 1), never summed.
 * A month without a published figure makes the result incomplete, and it says which.
 */
export function compoundInflation(figures: readonly MonthlyFigure[], from: string, to: string) {
  const byMonth = new Map(figures.map((f) => [f.month, f.value]));
  const months = monthsBetween(from, to);
  const missing = months.filter((m) => !byMonth.has(m));
  const factor = months
    .filter((m) => byMonth.has(m))
    .reduce((acc, m) => acc * (1 + byMonth.get(m)! / 100), 1);
  return {
    from,
    to,
    months: months.length,
    percent: round((factor - 1) * 100, 2),
    complete: missing.length === 0 && months.length > 0,
    missing,
  };
}

/** A nominal return net of inflation: (1+n)/(1+i) − 1 — not n − i. Percents in, percent out. */
export function realReturn(nominalPercent: number, inflationPercent: number) {
  if (inflationPercent <= -100) return null;
  return round(((1 + nominalPercent / 100) / (1 + inflationPercent / 100) - 1) * 100, 2);
}

// ── Deposit rates ────────────────────────────────────────────────────────────

/** A bank's published fixed-term rate (TNA as a fraction: 0.19 = 19 %). */
export interface DepositRate {
  entity: string;
  tnaClients: number | null;
  tnaNonClients: number | null;
}

/**
 * A fixed-term deposit at a nominal annual rate (TNA), simple interest over `days` (365-day
 * year, how Argentine banks quote it), and the TEA it implies if renewed at the same rate.
 * An illustration: the bank's own conditions decide.
 */
export function simulateDeposit(amount: number, tna: number, days: number) {
  if (!(amount > 0) || !(tna > 0) || !(days > 0)) return null;
  const interest = amount * tna * (days / 365);
  return {
    interest: round(interest, 2),
    total: round(amount + interest, 2),
    teaPercent: round(((1 + tna * (days / 365)) ** (365 / days) - 1) * 100, 2),
  };
}

// ── Holidays ─────────────────────────────────────────────────────────────────

/**
 * Argentina's calendar as the source labels it: "inamovible" and "trasladable" are national
 * holidays (the second can move), "puente" is a non-working day for tourism — not a holiday
 * for everyone — and "bancario" is a day banks don't operate. None of them says a given
 * business closes.
 */
export const HOLIDAY_KINDS = ["inamovible", "trasladable", "puente", "bancario"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

export interface Holiday {
  date: string;
  name: string;
  kind: HolidayKind;
}

/** Holidays within [from, to] (calendar dates, both inclusive), in order. */
export function holidaysIn(list: readonly Holiday[], from: string, to: string): Holiday[] {
  return list
    .filter((h) => h.date >= from && h.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** The years a date range touches (a week across New Year reads two calendars). */
export function yearsOf(from: string, to: string): number[] {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) && out.length < 3; y++)
    out.push(y);
  return out;
}

// ── Limits and freshness ─────────────────────────────────────────────────────

export const ECONOMY_LIMITS = {
  timeoutMs: 8_000,
  /** Current quotes refresh often at the source; a few minutes is still "now". */
  currentMs: 5 * 60_000,
  /** ArgentinaDatos asks for about one read per series every 3 hours. */
  seriesMs: 3 * 60 * 60_000,
  /** A past day's quote doesn't change. */
  pastDayMs: 7 * 24 * 60 * 60_000,
  /** Calendars change rarely (a moved holiday): a day, revalidated after. */
  holidaysMs: 24 * 60 * 60_000,
  /** A "current" quote older than this isn't said as current. */
  currentStaleAfterMs: 2 * 24 * 60 * 60_000,
  /** Days of daily history one question may show. */
  maxHistoryDays: 800,
  /** Response size ceiling (the whole dollar history is ~3 MB: never read). */
  maxBytes: 2_000_000,
} as const;

/** What tools use: providers behind a shared cache, de-duplication and telemetry. */
export interface EconomyCapability {
  currentRates(): Promise<Sourced<FxQuote[]>>;
  /** One past day for one market; null when the source has none for that day. */
  rateOn(market: FxMarket, date: string): Promise<Sourced<FxPoint | null>>;
  /** A market's daily history (the whole series, cached; callers slice it). */
  rateHistory(market: FxMarket): Promise<Sourced<FxPoint[]>>;
  inflation(kind: "monthly" | "yearly"): Promise<Sourced<MonthlyFigure[]>>;
  /** A year's calendar, or null when it isn't published yet. */
  holidays(year: number, bank: boolean): Promise<Sourced<Holiday[]> | null>;
  depositRates(): Promise<Sourced<DepositRate[]>>;
  countryRisk(): Promise<Sourced<{ date: string; value: number }>>;
  uva(): Promise<Sourced<{ date: string; value: number }[]>>;
}

function round(n: number, digits: number) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
