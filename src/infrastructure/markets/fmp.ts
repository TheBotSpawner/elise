import "server-only";

import { AppError } from "@/core/errors";
import {
  MARKET_LIMITS,
  type InstrumentType,
  type MarketDataProvider,
  type MarketInstrument,
  type MarketPricePoint,
  type MarketProfile,
  type MarketQuote,
} from "@/core/markets/model";

/**
 * Financial Modeling Prep, stable API (ADR-074). The key travels in the `apikey` header, never
 * in a URL (so it can't reach logs, caches or referrers). Responses are mapped to ELISE's own
 * market types here; FMP shapes never leave this file. Provider error bodies are never shown.
 */

const BASE = "https://financialmodelingprep.com/stable";

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What a status means for ELISE (no provider text reaches the user). */
function failure(status: number): AppError {
  if (status === 401)
    return new AppError("SERVER_NOT_CONFIGURED", "Market data isn't set up on this server", {
      recovery: "configure",
      details: { providerStatus: status },
    });
  if (status === 402 || status === 403)
    return new AppError("CAPABILITY_UNAVAILABLE", "That market data isn't available", {
      recovery: "none",
      details: { providerStatus: status, reason: "plan" },
    });
  if (status === 429)
    return new AppError("RATE_LIMITED", "Market data is busy right now", {
      recovery: "retry",
      details: { providerStatus: status },
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Market data isn't responding", {
    recovery: "retry",
    details: { providerStatus: status },
  });
}

function typeOf(row: Row): InstrumentType {
  const t = `${str(row.type) ?? ""} ${str(row.name) ?? ""}`.toLowerCase();
  if (/\betf\b|\bfund\b/.test(t) || row.isEtf === true) return "etf";
  if (/\bindex\b/.test(t) || String(row.symbol ?? "").startsWith("^")) return "index";
  return str(row.symbol) ? "equity" : "other";
}

export class FmpMarketData implements MarketDataProvider {
  readonly id = "fmp";
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async get(path: string, params: Record<string, string>, signal?: AbortSignal) {
    const url = `${BASE}/${path}?${new URLSearchParams(params).toString()}`;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers: { apikey: this.apiKey, accept: "application/json" },
        signal: signal ?? AbortSignal.timeout(MARKET_LIMITS.timeoutMs),
        cache: "no-store",
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AppError("PROVIDER_UNAVAILABLE", "Market data isn't responding", {
        recovery: "retry",
        cause,
      });
    }
    if (!res.ok) throw failure(res.status);
    const body: unknown = await res.json().catch(() => null);
    // FMP answers some plan limits with 200 and an "Error Message" object.
    if (body && !Array.isArray(body) && typeof body === "object" && "Error Message" in body)
      throw failure(402);
    return Array.isArray(body) ? (body as Row[]) : body ? [body as Row] : [];
  }

  async search(query: string, signal?: AbortSignal): Promise<MarketInstrument[]> {
    const q = query.trim().slice(0, 60);
    const limit = String(MARKET_LIMITS.searchResults * 2);
    // A ticker-looking query is looked up as a symbol first, else by name.
    const looksLikeTicker = /^[A-Za-z.^=-]{1,6}$/.test(q) && q === q.toUpperCase();
    const [first, second] = looksLikeTicker
      ? ["search-symbol", "search-name"]
      : ["search-name", "search-symbol"];
    let rows = await this.get(first, { query: q, limit }, signal);
    if (!rows.length) rows = await this.get(second, { query: q, limit }, signal);
    return rows
      .filter((r) => str(r.symbol) && str(r.name))
      .map((r) => ({
        symbol: str(r.symbol)!,
        name: str(r.name)!,
        exchange: str(r.exchange),
        exchangeFullName: str(r.exchangeFullName),
        currency: str(r.currency),
        type: typeOf(r),
      }));
  }

  async quote(symbol: string, signal?: AbortSignal): Promise<MarketQuote | null> {
    const [r] = await this.get("quote", { symbol }, signal);
    if (!r || num(r.price) === null) return null;
    const ts = num(r.timestamp);
    return {
      symbol: str(r.symbol) ?? symbol,
      name: str(r.name),
      price: num(r.price)!,
      currency: str(r.currency),
      change: num(r.change),
      changePercent: num(r.changePercentage) ?? num(r.changesPercentage),
      open: num(r.open),
      previousClose: num(r.previousClose),
      dayHigh: num(r.dayHigh),
      dayLow: num(r.dayLow),
      yearHigh: num(r.yearHigh),
      yearLow: num(r.yearLow),
      volume: num(r.volume),
      marketCap: num(r.marketCap),
      exchange: str(r.exchange),
      asOf: ts ? new Date(ts * 1000).toISOString() : null,
      // FMP doesn't say whether a quote is real time for this plan: never claim "live".
      freshness: ts ? "delayed" : "unknown",
    };
  }

  async history(
    symbol: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<MarketPricePoint[]> {
    const rows = await this.get("historical-price-eod/light", { symbol, from, to }, signal);
    return rows
      .flatMap((r) => {
        const date = str(r.date);
        const close = num(r.price) ?? num(r.close);
        return date && close !== null
          ? [{ date: date.slice(0, 10), close, volume: num(r.volume) }]
          : [];
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async profile(symbol: string, signal?: AbortSignal): Promise<MarketProfile | null> {
    const [r] = await this.get("profile", { symbol }, signal);
    if (!r || !str(r.symbol)) return null;
    return {
      symbol: str(r.symbol)!,
      name: str(r.companyName) ?? str(r.symbol)!,
      currency: str(r.currency),
      exchange: str(r.exchange),
      sector: str(r.sector),
      industry: str(r.industry),
      country: str(r.country),
      website: str(r.website),
      description: str(r.description)?.slice(0, 600) ?? null,
      marketCap: num(r.marketCap) ?? num(r.mktCap),
    };
  }
}
