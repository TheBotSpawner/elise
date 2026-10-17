/**
 * Market Data (ADR-074): public securities — quotes, history, company profiles. A capability of
 * ELISE, not a user connection: the provider (today Financial Modeling Prep) is infrastructure
 * and stays behind this contract. Distinct from Finance (the user's own money): nothing here
 * reads or writes the user's movements, and nothing here trades or advises.
 */

export type InstrumentType = "equity" | "etf" | "index" | "other";

export interface MarketInstrument {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeFullName: string | null;
  currency: string | null;
  type: InstrumentType;
}

/** What a quote's time means: a provider timestamp ("as of"), never "now" by assumption. */
export type Freshness = "live" | "delayed" | "unknown";

export interface MarketQuote {
  symbol: string;
  name: string | null;
  price: number;
  currency: string | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  volume: number | null;
  marketCap: number | null;
  exchange: string | null;
  /** When the provider says this price is from (ISO), or null. */
  asOf: string | null;
  freshness: Freshness;
}

export interface MarketPricePoint {
  /** Trading day (YYYY-MM-DD). */
  date: string;
  close: number;
  volume: number | null;
}

export interface MarketProfile {
  symbol: string;
  name: string;
  currency: string | null;
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  country: string | null;
  website: string | null;
  description: string | null;
  marketCap: number | null;
}

/** A market data provider (FMP today), isolated in infrastructure. */
export interface MarketDataProvider {
  readonly id: string;
  search(query: string, signal?: AbortSignal): Promise<MarketInstrument[]>;
  quote(symbol: string, signal?: AbortSignal): Promise<MarketQuote | null>;
  history(
    symbol: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<MarketPricePoint[]>;
  profile(symbol: string, signal?: AbortSignal): Promise<MarketProfile | null>;
}

/** What tools use: the provider behind cache, de-duplication, limits and telemetry. */
export interface MarketsCapability {
  readonly provider: string;
  search(query: string): Promise<MarketInstrument[]>;
  quote(symbol: string): Promise<MarketQuote | null>;
  quotes(symbols: readonly string[]): Promise<MarketQuote[]>;
  history(symbol: string, from: string, to: string): Promise<MarketPricePoint[]>;
  profile(symbol: string): Promise<MarketProfile | null>;
}

/**
 * Deterministic limits (ADR-074). Plans differ in daily calls; nothing here assumes one — the
 * cache keeps repeated questions free, and a watchlist is bounded.
 */
export const MARKET_LIMITS = {
  timeoutMs: 8_000,
  cacheSearchMs: 6 * 60 * 60_000,
  cacheProfileMs: 24 * 60 * 60_000,
  /** A quote is "current" only briefly: never cached long enough to pass old prices as live. */
  cacheQuoteMs: 45_000,
  cacheHistoryMs: 10 * 60_000,
  /** Days of daily history a single question may read (a year, never decades). */
  maxHistoryDays: 400,
  /** Quotes per question / per scheduled summary. */
  maxSymbols: 8,
  searchResults: 6,
} as const;

/** A ticker as people and exchanges write it: letters, digits and . ^ - = (GOOGL, BRK.B, ^GSPC). */
export const SYMBOL = /^[A-Za-z0-9.^=-]{1,15}$/;
export const normalizeSymbol = (s: string) => s.trim().toUpperCase();

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * A period's movement from daily closes, computed — never estimated by the model: first and
 * last close, absolute and percent change, high and low closes. Null with fewer than two days.
 */
export function periodChange(points: readonly MarketPricePoint[]) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const closes = sorted.map((p) => p.close);
  const high = Math.max(...closes);
  const low = Math.min(...closes);
  return {
    from: first.date,
    to: last.date,
    start: first.close,
    end: last.close,
    change: round(last.close - first.close, 4),
    changePercent: first.close ? round(((last.close - first.close) / first.close) * 100, 2) : null,
    high,
    highDate: sorted.find((p) => p.close === high)!.date,
    low,
    lowDate: sorted.find((p) => p.close === low)!.date,
    days: sorted.length,
  };
}

/** The day's movement against the previous close, when the provider didn't give it. */
export function dayChange(
  q: Pick<MarketQuote, "price" | "previousClose" | "change" | "changePercent">,
) {
  if (q.change !== null && q.changePercent !== null)
    return { change: q.change, changePercent: q.changePercent };
  if (!q.previousClose) return { change: q.change, changePercent: q.changePercent };
  const change = round(q.price - q.previousClose, 4);
  return { change, changePercent: round((change / q.previousClose) * 100, 2) };
}

export const MARKET_PERIODS = ["today", "5d", "week", "month", "3m", "ytd", "1y"] as const;
export type MarketPeriod = (typeof MARKET_PERIODS)[number];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * A named period → the dates to read, in the user's calendar (`today` is their local date).
 * "Esta semana" starts on Monday; a few days before each period are read so the first close
 * of the period has a previous one to compare with.
 */
export function periodRange(period: MarketPeriod, today: string): { from: string; to: string } {
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  switch (period) {
    case "today":
      return { from: addDays(today, -5), to: today };
    case "5d":
      return { from: addDays(today, -8), to: today };
    case "week":
      return { from: addDays(today, -weekday - 3), to: today };
    case "month":
      return { from: addDays(`${today.slice(0, 8)}01`, -3), to: today };
    case "3m":
      return { from: addDays(today, -92), to: today };
    case "ytd":
      return { from: addDays(`${today.slice(0, 4)}-01-01`, -3), to: today };
    case "1y":
      return { from: addDays(today, -366), to: today };
  }
}

/** Days within [from, to] once the lead-in closes are dropped (keeps one close before `from`). */
export function withinPeriod(
  points: readonly MarketPricePoint[],
  period: MarketPeriod,
  today: string,
): MarketPricePoint[] {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start =
    period === "week"
      ? addDays(today, -weekday)
      : period === "month"
        ? `${today.slice(0, 8)}01`
        : period === "ytd"
          ? `${today.slice(0, 4)}-01-01`
          : period === "5d"
            ? (sorted.at(-5)?.date ?? today)
            : period === "today"
              ? today
              : addDays(today, period === "3m" ? -92 : -366);
  const inside = sorted.findIndex((p) => p.date >= start);
  if (inside < 0) return sorted.slice(-1);
  // The close before the period is the baseline of its change.
  return sorted.slice(Math.max(0, inside - 1));
}

/** An asset the person follows: never something they own (no holdings, no portfolio). */
export type WatchedInstrument = Pick<
  MarketInstrument,
  "symbol" | "name" | "exchange" | "currency" | "type"
>;

/** What market tools reach: data, plus the person's list of followed assets. */
export interface MarketsPort extends MarketsCapability {
  watchlist: {
    list(): Promise<WatchedInstrument[]>;
    save(list: WatchedInstrument[]): Promise<void>;
  };
}

const PRIMARY = /^(NASDAQ|NYSE|AMEX|NYSE ?ARCA|BATS|CBOE)$/i;

/**
 * The same company's other primary listings in the same currency (GOOG ↔ GOOGL): what a quote
 * may fall back to when the provider's plan doesn't cover the asked symbol.
 */
export function siblingListings(symbol: string, found: readonly MarketInstrument[]) {
  const self = found.find((i) => i.symbol.toUpperCase() === symbol.toUpperCase());
  if (!self) return [];
  return found.filter(
    (i) =>
      i.symbol !== self.symbol &&
      i.name === self.name &&
      i.currency === self.currency &&
      PRIMARY.test(i.exchange ?? "") &&
      !i.symbol.includes("."),
  );
}

/**
 * The instrument a name means, among what the provider found (never invented): an exact symbol,
 * else the primary US listing of the best name match, else the first result. `others` are the
 * alternatives worth mentioning (Alphabet has GOOGL and GOOG).
 */
export function pickInstrument(query: string, found: readonly MarketInstrument[]) {
  if (!found.length) return null;
  const q = query.trim().toUpperCase();
  const exact = found.find((i) => i.symbol.toUpperCase() === q);
  if (exact) return { instrument: exact, others: [] as MarketInstrument[] };
  const name = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const wanted = name(query);
  const named = found.filter(
    (i) => name(i.name).startsWith(wanted) || wanted.startsWith(name(i.name)),
  );
  const pool = named.length ? named : found;
  const primary = pool.filter((i) => PRIMARY.test(i.exchange ?? "") && !i.symbol.includes("."));
  const instrument = primary[0] ?? pool[0]!;
  const others = primary.filter(
    (i) => i.symbol !== instrument.symbol && i.name === instrument.name,
  );
  return { instrument, others };
}
