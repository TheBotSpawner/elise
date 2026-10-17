import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError, toAppError } from "@/core/errors";
import {
  MARKET_LIMITS,
  normalizeSymbol,
  SYMBOL,
  type MarketDataProvider,
  type MarketsCapability,
  type WatchedInstrument,
} from "@/core/markets/model";
import { FmpMarketData } from "@/infrastructure/markets/fmp";
import { logger } from "@/infrastructure/observability/logger";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * The Market Data capability (ADR-074): the provider behind a shared short cache, de-duplicated
 * in-flight requests and telemetry. Market data is public, so the cache is shared across
 * workspaces (a hit is never a tenant's private data); quotes live 45 s, history 10 min,
 * searches 6 h, profiles a day. The API key never appears in a log line.
 */

export function marketsConfigured(): boolean {
  return Boolean(serverEnv().FMP_API_KEY);
}

const TTL = {
  search: MARKET_LIMITS.cacheSearchMs,
  quote: MARKET_LIMITS.cacheQuoteMs,
  history: MARKET_LIMITS.cacheHistoryMs,
  profile: MARKET_LIMITS.cacheProfileMs,
} as const;

// ponytail: per-instance cache; a shared (Redis) cache when traffic across instances justifies it.
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export function marketsCapability(
  provider: MarketDataProvider | null = marketsConfigured()
    ? new FmpMarketData(serverEnv().FMP_API_KEY!)
    : null,
): MarketsCapability {
  if (!provider)
    throw new AppError("SERVER_NOT_CONFIGURED", "Market data isn't set up on this server", {
      recovery: "configure",
    });

  function step<T>(op: keyof typeof TTL, key: string, run: () => Promise<T>, symbol?: string) {
    const k = `${op}:${key}`;
    const log = { provider: provider!.id, operation: op, ...(symbol ? { symbol } : {}) };
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at <= TTL[op]) {
      logger.info("market_data_request", {
        ...log,
        cache: "hit",
        status: "success",
        latency_ms: 0,
      });
      return Promise.resolve(hit.value as T);
    }
    // The same question asked twice at once is one provider call.
    const pending = inflight.get(k);
    if (pending) return pending as Promise<T>;
    const started = Date.now();
    const call = run()
      .then((value) => {
        if (cache.size > 2000) cache.delete(cache.keys().next().value!);
        cache.set(k, { at: Date.now(), value });
        logger.info("market_data_request", {
          ...log,
          cache: "miss",
          status: "success",
          latency_ms: Date.now() - started,
        });
        return value;
      })
      .catch((error: unknown) => {
        const e = toAppError(error);
        logger.warn("market_data_request", {
          ...log,
          cache: "miss",
          status: e.code,
          provider_status: e.details?.providerStatus,
          latency_ms: Date.now() - started,
        });
        throw e;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, call);
    return call;
  }

  const symbolOf = (s: string) => {
    const symbol = normalizeSymbol(s);
    if (!SYMBOL.test(symbol))
      throw new AppError("VALIDATION_ERROR", "That isn't a market symbol", { recovery: "review" });
    return symbol;
  };

  const capability: MarketsCapability = {
    provider: provider.id,
    search: async (query) => {
      const q = query.trim().slice(0, 60);
      if (q.length < 1)
        throw new AppError("VALIDATION_ERROR", "Say which company or symbol", {
          recovery: "review",
        });
      return step("search", q.toLowerCase(), () => provider.search(q));
    },
    quote: async (s) => {
      const symbol = symbolOf(s);
      return step("quote", symbol, () => provider.quote(symbol), symbol);
    },
    async quotes(symbols) {
      const list = [...new Set(symbols.map(symbolOf))].slice(0, MARKET_LIMITS.maxSymbols);
      // One call per symbol (batch quotes are a premium endpoint), a few at a time.
      const results = await Promise.allSettled(list.map((s) => capability.quote(s)));
      const quotes = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!quotes.length && failed) throw failed.reason;
      return quotes;
    },
    history: async (s, from, to) => {
      const symbol = symbolOf(s);
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (!(days >= 0) || days > MARKET_LIMITS.maxHistoryDays)
        throw new AppError("VALIDATION_ERROR", "Ask for a year or less of history", {
          recovery: "review",
        });
      return step(
        "history",
        `${symbol}:${from}:${to}`,
        () => provider.history(symbol, from, to),
        symbol,
      );
    },
    profile: async (s) => {
      const symbol = symbolOf(s);
      return step("profile", symbol, () => provider.profile(symbol), symbol);
    },
  };
  return capability;
}

// ── Watchlist: the assets a person follows (never "their portfolio") ──────────

const WATCHLIST = "markets.watchlist";

export type { WatchedInstrument };

/** The person's followed assets (per person and workspace, under RLS). */
export async function readWatchlist(auth: AuthContext): Promise<WatchedInstrument[]> {
  const { data } = await auth.db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("key", WATCHLIST)
    .maybeSingle();
  const v = data?.value_json;
  return Array.isArray(v) ? (v as unknown as WatchedInstrument[]) : [];
}

export async function writeWatchlist(auth: AuthContext, list: WatchedInstrument[]) {
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: WATCHLIST,
      value_json: list.slice(0, MARKET_LIMITS.maxSymbols * 3) as unknown as Json,
      source: "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the watchlist", { cause: error });
}
