import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError, toAppError } from "../errors";
import {
  dayChange,
  MARKET_LIMITS,
  MARKET_PERIODS,
  periodChange,
  periodRange,
  pickInstrument,
  siblingListings,
  withinPeriod,
  type MarketQuote,
  type MarketsPort,
  type WatchedInstrument,
} from "../markets/model";
import { toLocalDateTime } from "../time";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Market tools (ADR-074): public quotes and history, by capability ("markets.*"), never by
 * provider. Read-only, no approval; nothing here trades, holds or advises. Symbols come from the
 * provider's search — the model never invents one — and every change, return, high or low is
 * computed here, not by the model.
 */

function markets(env: ToolRunEnv): MarketsPort {
  return env.providers.get("markets", env.binding);
}

const symbolField = z
  .string()
  .trim()
  .min(1)
  .max(15)
  .describe('A ticker returned by markets.search or written by the user ("GOOGL", "AAPL").');

const NO_ADVICE =
  "Market data is information, not advice: never recommend buying, selling or holding, and never treat a followed asset as one the user owns.";

type QuoteView = SurfacePayloads["market"]["quotes"][number];
const view = (q: MarketQuote): QuoteView => {
  const day = dayChange(q);
  return {
    symbol: q.symbol,
    name: q.name,
    price: q.price,
    currency: q.currency,
    change: day.change,
    changePercent: day.changePercent,
    open: q.open,
    previousClose: q.previousClose,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    volume: q.volume,
    asOf: q.asOf,
    freshness: q.freshness,
  };
};

/** What the model is told when the structured source can't answer (plan, limits, outage). */
function unavailable(error: unknown) {
  const e = toAppError(error);
  const reason =
    e.code === "RATE_LIMITED"
      ? "rate_limited"
      : e.details?.reason === "plan"
        ? "not_in_plan"
        : e.code === "SERVER_NOT_CONFIGURED"
          ? "not_configured"
          : "unavailable";
  return {
    available: false,
    reason,
    instructions:
      "Structured market data isn't available for this right now. Say so in one short sentence; if a price still matters, check the web (web.search with recency) and present it as reported by that source with its date — never as a live quote and never with invented precision.",
  };
}

// ── Search ───────────────────────────────────────────────────────────────────

const searchInput = z
  .object({ query: z.string().trim().min(1).max(60).describe("A company, fund or ticker.") })
  .strict();

export const searchMarketsTool: ToolDefinition = {
  name: "markets.search",
  capability: "markets",
  operation: "search",
  description:
    'Find the market symbol of a company, ETF or index the user names ("Alphabet", "Apple", "el S&P 500"). Use it before a quote whenever the user didn\'t give a ticker; never guess one.',
  input: searchInput,
  async describe(raw) {
    return { summary: `Find ${searchInput.parse(raw).query}` };
  },
  async run(raw, env) {
    const { query } = searchInput.parse(raw);
    try {
      const found = await markets(env).search(query);
      const pick = pickInstrument(query, found);
      return {
        output: {
          found: found.length > 0,
          ...(pick
            ? { best: pick.instrument, ...(pick.others.length ? { alsoListed: pick.others } : {}) }
            : {}),
          results: found.slice(0, MARKET_LIMITS.searchResults),
        },
      };
    } catch (error) {
      return { output: unavailable(error) };
    }
  },
};

// ── Quotes ───────────────────────────────────────────────────────────────────

const quoteInput = z
  .object({
    symbols: z
      .array(symbolField)
      .min(1)
      .max(MARKET_LIMITS.maxSymbols)
      .describe("One or more tickers (resolve names with markets.search first)."),
  })
  .strict();

export const getQuoteTool: ToolDefinition = {
  name: "markets.getQuote",
  capability: "markets",
  operation: "getQuote",
  description:
    '"¿Cómo está Alphabet hoy?", "¿a cuánto está AAPL?", "¿cuál fue el máximo de NVIDIA hoy?": the latest quote — price, day change, open, high, low, previous close, volume — with the time the provider gives. Structured data: use it instead of web search for prices.',
  input: quoteInput,
  async describe(raw) {
    return { summary: `Quote ${quoteInput.parse(raw).symbols.join(", ")}` };
  },
  async run(raw, env) {
    const { symbols } = quoteInput.parse(raw);
    const port = markets(env);
    let quotes: MarketQuote[];
    let failure: unknown = null;
    try {
      quotes = await port.quotes(symbols);
    } catch (error) {
      quotes = [];
      failure = error;
    }
    // A symbol the plan doesn't cover may have a sibling listing it does (GOOG → GOOGL).
    const substituted: { asked: string; used: string }[] = [];
    const asked = [...new Set(symbols.map((s) => s.toUpperCase()))];
    for (const symbol of asked.filter((s) => !quotes.some((q) => q.symbol === s)).slice(0, 2)) {
      const byName = await port
        .search(symbol)
        .then((found) => found.find((i) => i.symbol.toUpperCase() === symbol))
        .then((self) => (self ? port.search(self.name) : []))
        .catch(() => []);
      for (const sibling of siblingListings(symbol, byName).slice(0, 2)) {
        const q = await port.quote(sibling.symbol).catch(() => null);
        if (q) {
          quotes.push(q);
          substituted.push({ asked: symbol, used: q.symbol });
          break;
        }
      }
    }
    if (!quotes.length && failure) return { output: unavailable(failure) };
    const views = quotes.map(view);
    const missing = asked.filter(
      (s) => !views.some((q) => q.symbol === s) && !substituted.some((x) => x.asked === s),
    );
    if (!views.length)
      return {
        output: {
          found: false,
          instructions: `No quote for ${symbols.join(", ")}: check the symbol with markets.search, or say it isn't available.`,
        },
      };
    return {
      output: {
        quotes: views,
        ...(missing.length ? { unavailable: missing } : {}),
        ...(substituted.length ? { substituted } : {}),
        instructions: `The quote is on screen.${substituted.length ? " Where a symbol was substituted, say in passing which listing you quoted (same company, other share class)." : ""} Say the price with its currency and the day's change; say "a las HH:mm" / "as of" from asOf in the user's timezone — say "ahora" only if freshness is "live". If the market is closed, it's the latest available price. ${NO_ADVICE}`,
      },
      display: {
        kind: "market",
        market: {
          mode: views.length > 1 ? "watch" : "quote",
          quotes: views,
          history: null,
          unavailable: missing,
          provider: markets(env).provider,
        },
      },
    };
  },
};

// ── History ──────────────────────────────────────────────────────────────────

const historyInput = z
  .object({
    symbol: symbolField,
    period: z
      .enum(MARKET_PERIODS)
      .default("week")
      .describe(
        '"esta semana" → week, "este mes" → month, "en el año" → ytd, "últimos 5 días" → 5d.',
      ),
  })
  .strict();

export const getHistoryTool: ToolDefinition = {
  name: "markets.getHistory",
  capability: "markets",
  operation: "getHistory",
  description:
    '"¿Cómo se movió Microsoft esta semana?", "mostrame Apple este mes": daily closes for a period (at most a year) with the period\'s change, high and low computed by ELISE.',
  input: historyInput,
  async describe(raw) {
    const q = historyInput.parse(raw);
    return { summary: `${q.symbol} · ${q.period}` };
  },
  async run(raw, env) {
    const q = historyInput.parse(raw);
    const today = toLocalDateTime(env.ctx.now, env.ctx.timezone).slice(0, 10);
    const range = periodRange(q.period, today);
    const m = markets(env);
    let points;
    try {
      points = withinPeriod(await m.history(q.symbol, range.from, range.to), q.period, today);
    } catch (error) {
      return { output: unavailable(error) };
    }
    if (!points.length)
      return {
        output: { found: false, instructions: `No price history for ${q.symbol} in that period.` },
      };
    const change = periodChange(points);
    const symbol = q.symbol.toUpperCase();
    return {
      output: {
        symbol,
        period: q.period,
        ...(change ? { change } : {}),
        days: points.length,
        instructions: `The history is on screen. Use these computed numbers (change, changePercent, high, low and their dates); never recompute them. The first close is the one before the period, the baseline of its change. ${NO_ADVICE}`,
      },
      display: {
        kind: "market",
        market: {
          mode: "history",
          quotes: [],
          history: {
            symbol,
            name: null,
            currency: null,
            period: q.period,
            points: points.map((p) => ({ date: p.date, close: p.close })),
            change: change
              ? {
                  from: change.from,
                  to: change.to,
                  start: change.start,
                  end: change.end,
                  change: change.change,
                  changePercent: change.changePercent,
                  high: change.high,
                  low: change.low,
                }
              : null,
          },
          unavailable: [],
          provider: m.provider,
        },
      },
    };
  },
};

// ── Profile ──────────────────────────────────────────────────────────────────

const profileInput = z.object({ symbol: symbolField }).strict();

export const getProfileTool: ToolDefinition = {
  name: "markets.getProfile",
  capability: "markets",
  operation: "getProfile",
  description:
    "A listed company's profile (sector, industry, country, market cap, what it does). Only when that's asked; a price question needs only markets.getQuote.",
  input: profileInput,
  async describe(raw) {
    return { summary: `Profile ${profileInput.parse(raw).symbol}` };
  },
  async run(raw, env) {
    const { symbol } = profileInput.parse(raw);
    try {
      const profile = await markets(env).profile(symbol);
      return profile
        ? {
            output: {
              profile: {
                ...profile,
                untrustedDescription: profile.description,
                description: undefined,
              },
            },
          }
        : { output: { found: false } };
    } catch (error) {
      return { output: unavailable(error) };
    }
  },
};

// ── Followed assets (a watchlist, never a portfolio) ─────────────────────────

export const listWatchlistTool: ToolDefinition = {
  name: "markets.watchlist",
  capability: "markets",
  operation: "listWatchlist",
  description:
    '"¿Qué activos sigo?", "¿cómo vienen los mercados que sigo?": the assets the user follows. For their prices, call markets.getQuote with those symbols.',
  input: z.object({}).strict(),
  async describe() {
    return { summary: "Followed assets" };
  },
  async run(_raw, env) {
    const list = await markets(env).watchlist.list();
    return {
      output: {
        following: list.map((i) => ({ symbol: i.symbol, name: i.name })),
        note: "These are assets the user follows — not holdings.",
      },
    };
  },
};

const watchInput = z
  .object({
    assets: z
      .array(z.string().trim().min(1).max(60))
      .min(1)
      .max(MARKET_LIMITS.maxSymbols)
      .describe('Names or tickers as the user said them ("Alphabet", "SPY").'),
  })
  .strict();

export const watchTool: ToolDefinition = {
  name: "markets.watch",
  capability: "markets",
  operation: "watch",
  description:
    '"Seguí Alphabet, Apple y Microsoft", "agregá SPY a lo que sigo": adds assets to the ones the user follows (used by Programados and the Morning Brief). Each name is resolved by the market provider; one that isn\'t found is reported, never invented.',
  input: watchInput,
  async describe(raw) {
    return { summary: `Follow ${watchInput.parse(raw).assets.join(", ")}` };
  },
  async run(raw, env) {
    const { assets } = watchInput.parse(raw);
    const m = markets(env);
    const current = await m.watchlist.list();
    const added: WatchedInstrument[] = [];
    const notFound: string[] = [];
    for (const asset of assets) {
      let found;
      try {
        found = pickInstrument(asset, await m.search(asset));
      } catch (error) {
        return { output: unavailable(error) };
      }
      if (!found) {
        notFound.push(asset);
        continue;
      }
      const i = found.instrument;
      if (current.some((c) => c.symbol === i.symbol) || added.some((a) => a.symbol === i.symbol))
        continue;
      added.push({
        symbol: i.symbol,
        name: i.name,
        exchange: i.exchange,
        currency: i.currency,
        type: i.type,
      });
    }
    const limit = MARKET_LIMITS.maxSymbols * 3;
    if (current.length + added.length > limit)
      throw new AppError(
        "VALIDATION_ERROR",
        `At most ${limit} followed assets; remove some first (markets.unwatch).`,
        { recovery: "review" },
      );
    if (added.length) await m.watchlist.save([...current, ...added]);
    return {
      output: {
        added: added.map((a) => `${a.name} (${a.symbol})`),
        ...(notFound.length ? { notFound } : {}),
        following: [...current, ...added].map((i) => i.symbol),
        instructions: `Confirm with the symbols used, briefly. ${NO_ADVICE}`,
      },
    };
  },
};

const unwatchInput = z
  .object({ assets: z.array(z.string().trim().min(1).max(60)).min(1).max(24) })
  .strict();

export const unwatchTool: ToolDefinition = {
  name: "markets.unwatch",
  capability: "markets",
  operation: "unwatch",
  description: '"Sacá Tesla de lo que sigo": stops following assets (by name or ticker).',
  input: unwatchInput,
  async describe(raw) {
    return { summary: `Unfollow ${unwatchInput.parse(raw).assets.join(", ")}` };
  },
  async run(raw, env) {
    const { assets } = unwatchInput.parse(raw);
    const m = markets(env);
    const current = await m.watchlist.list();
    const wanted = assets.map((a) => a.toLowerCase());
    const removed = current.filter(
      (i) =>
        wanted.includes(i.symbol.toLowerCase()) ||
        wanted.some((w) => i.name.toLowerCase().includes(w)),
    );
    if (removed.length) await m.watchlist.save(current.filter((i) => !removed.includes(i)));
    return {
      output: {
        removed: removed.map((r) => r.symbol),
        following: current.filter((i) => !removed.includes(i)).map((i) => i.symbol),
      },
    };
  },
};

export const MARKET_TOOLS = [
  searchMarketsTool,
  getQuoteTool,
  getHistoryTool,
  getProfileTool,
  listWatchlistTool,
  watchTool,
  unwatchTool,
];
