import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { MARKET_SIGNAL } from "@/core/agents/tool-selection";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  dayChange,
  periodChange,
  periodRange,
  pickInstrument,
  withinPeriod,
  type MarketInstrument,
  type MarketQuote,
  type MarketsPort,
  type WatchedInstrument,
} from "@/core/markets/model";

import { makeCtx, makePorts } from "../fixtures/core-fakes";

vi.mock("server-only", () => ({}));

const { FmpMarketData } = await import("@/infrastructure/markets/fmp");
const { marketsCapability } = await import("@/application/markets-service");

/**
 * Market data (ADR-074): FMP behind the capability, numbers computed by code, symbols only from
 * the provider, the key never in a URL, limits and plan restrictions degrading gracefully.
 */

const NOW = new Date("2026-10-16T20:00:00Z");

const inst = (symbol: string, name: string, exchange: string): MarketInstrument => ({
  symbol,
  name,
  exchange,
  exchangeFullName: null,
  currency: "USD",
  type: "equity",
});

const quote = (symbol: string, price: number, pct: number): MarketQuote => ({
  symbol,
  name: `${symbol} Inc.`,
  price,
  currency: "USD",
  change: 1,
  changePercent: pct,
  open: price - 1,
  previousClose: price - 1,
  dayHigh: price + 2,
  dayLow: price - 3,
  yearHigh: null,
  yearLow: null,
  volume: 1000,
  marketCap: null,
  exchange: "NASDAQ",
  asOf: "2026-10-16T20:00:00.000Z",
  freshness: "delayed",
});

describe("market numbers are computed, never estimated", () => {
  it("a period's change, high and low come from the daily closes", () => {
    const c = periodChange([
      { date: "2026-10-13", close: 543.45, volume: null },
      { date: "2026-10-09", close: 535.07, volume: null },
      { date: "2026-10-16", close: 529.05, volume: null },
      { date: "2026-10-15", close: 539.44, volume: null },
    ])!;
    expect(c).toMatchObject({ from: "2026-10-09", to: "2026-10-16", start: 535.07, end: 529.05 });
    expect(c.changePercent).toBe(-1.13);
    expect(c).toMatchObject({ high: 543.45, highDate: "2026-10-13", low: 529.05 });
    expect(periodChange([{ date: "2026-10-16", close: 1, volume: null }])).toBeNull();
  });

  it("'this week' is bounded to the week (plus the close before it), in the user's calendar", () => {
    expect(periodRange("week", "2026-10-16")).toEqual({ from: "2026-10-09", to: "2026-10-16" });
    const points = ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-16"].map((date, i) => ({
      date,
      close: 100 + i,
      volume: null,
    }));
    // Friday 9 is the baseline; Monday 12 to Friday 16 are the week.
    expect(withinPeriod(points, "week", "2026-10-16").map((p) => p.date)).toEqual(
      points.map((p) => p.date),
    );
    expect(withinPeriod(points, "today", "2026-10-16").map((p) => p.date)).toEqual([
      "2026-10-13",
      "2026-10-16",
    ]);
  });

  it("the day's change from the previous close when the provider omits it", () => {
    expect(
      dayChange({ price: 110, previousClose: 100, change: null, changePercent: null }),
    ).toEqual({
      change: 10,
      changePercent: 10,
    });
  });
});

describe("symbols come from the provider, never invented", () => {
  const found = [
    inst("ABEC.F", "Alphabet Inc.", "FSX"),
    inst("GOOG", "Alphabet Inc.", "NASDAQ"),
    inst("GOOG.TO", "Alphabet Inc.", "TSX"),
    inst("GOOGL", "Alphabet Inc.", "NASDAQ"),
  ];
  it("'Alphabet' → the primary US listing, mentioning the other share class", () => {
    const pick = pickInstrument("Alphabet", found)!;
    expect(pick.instrument.symbol).toBe("GOOG");
    expect(pick.others.map((o) => o.symbol)).toEqual(["GOOGL"]);
  });
  it("an exact ticker wins; nothing found is nothing", () => {
    expect(pickInstrument("googl", found)!.instrument.symbol).toBe("GOOGL");
    expect(pickInstrument("Nothing", [])).toBeNull();
  });
});

describe("FMP provider", () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it("sends the key in a header, never in the URL, and maps the quote", async () => {
    const fetcher = vi.fn(async () =>
      ok([
        {
          symbol: "GOOGL",
          name: "Alphabet Inc.",
          price: 340.59,
          changePercentage: -2.47122,
          change: -8.63,
          open: 348.325,
          previousClose: 349.22,
          dayHigh: 350.66,
          dayLow: 339.0801,
          volume: 28204302,
          timestamp: 1792180801,
        },
      ]),
    );
    const fmp = new FmpMarketData("sk-secret", fetcher as unknown as typeof fetch);
    const q = (await fmp.quote("GOOGL"))!;
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://financialmodelingprep.com/stable/quote?symbol=GOOGL");
    expect(url).not.toContain("sk-secret");
    expect((init.headers as Record<string, string>).apikey).toBe("sk-secret");
    expect(q).toMatchObject({
      symbol: "GOOGL",
      price: 340.59,
      changePercent: -2.47122,
      freshness: "delayed",
    });
    expect(q.asOf).toBe(new Date(1792180801 * 1000).toISOString());
  });

  it("limits and plans become ELISE errors, never the provider's text", async () => {
    const status = (code: number, body = "Premium Query Parameter: upgrade your plan") =>
      new FmpMarketData(
        "k",
        (async () => new Response(body, { status: code })) as unknown as typeof fetch,
      );
    await expect(status(429).quote("AAPL")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const plan = await status(402)
      .quote("AAPL")
      .catch((e) => e);
    expect(plan).toMatchObject({ code: "CAPABILITY_UNAVAILABLE", details: { reason: "plan" } });
    expect(plan.message).not.toMatch(/Premium|upgrade/);
    await expect(status(401).quote("AAPL")).rejects.toMatchObject({
      code: "SERVER_NOT_CONFIGURED",
    });
  });
});

describe("market data service", () => {
  it("caches a quote briefly and asks the provider once for simultaneous questions", async () => {
    const provider = {
      id: "fake",
      search: vi.fn(),
      quote: vi.fn(async (s: string) => quote(s, 100, 1)),
      history: vi.fn(),
      profile: vi.fn(),
    };
    const m = marketsCapability(provider as never);
    const [a, b] = await Promise.all([m.quote("CACHE1"), m.quote("cache1")]);
    expect(a).toEqual(b);
    await m.quote("CACHE1");
    expect(provider.quote).toHaveBeenCalledTimes(1);
    await expect(m.quote("not a ticker!")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("years of history are refused (bounded windows only)", async () => {
    const provider = {
      id: "fake",
      search: vi.fn(),
      quote: vi.fn(),
      history: vi.fn(async () => []),
      profile: vi.fn(),
    };
    const m = marketsCapability(provider as never);
    await expect(m.history("MSFT", "2010-01-01", "2026-10-16")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

/** The market tools against an in-memory port. */
function setup(port: Partial<MarketsPort>) {
  let watch: WatchedInstrument[] = [];
  const full: MarketsPort = {
    provider: "fake",
    search: async () => [],
    quote: async () => null,
    quotes: async () => [],
    history: async () => [],
    profile: async () => null,
    watchlist: { list: async () => watch, save: async (l) => void (watch = l) },
    ...port,
  };
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "markets" ? full : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW }), watch: () => watch };
}

describe("market tools", () => {
  it("'¿Cómo está AAPL?' → a quote card with price, change and its time", async () => {
    const { ports, ctx } = setup({ quotes: async () => [quote("AAPL", 343.46, 0.43)] });
    const out = await executeToolCall(ports, ctx, {
      name: "markets.getQuote",
      args: { symbols: ["AAPL"] },
    });
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    expect(out.display).toMatchObject({
      kind: "market",
      market: { mode: "quote", quotes: [{ symbol: "AAPL", price: 343.46, changePercent: 0.43 }] },
    });
    expect(JSON.stringify(out.output)).toMatch(/never recommend/);
  });

  it("'¿Cómo se movió Microsoft esta semana?' → a bounded history with computed change", async () => {
    const asked: string[][] = [];
    const { ports, ctx } = setup({
      history: async (s, from, to) => {
        asked.push([s, from, to]);
        return [
          { date: "2026-10-09", close: 535.07, volume: null },
          { date: "2026-10-16", close: 529.05, volume: null },
        ];
      },
    });
    const out = await executeToolCall(ports, ctx, {
      name: "markets.getHistory",
      args: { symbol: "MSFT", period: "week" },
    });
    expect(asked).toEqual([["MSFT", "2026-10-09", "2026-10-16"]]);
    expect(out.status === "succeeded" && out.output).toMatchObject({
      change: { changePercent: -1.13 },
    });
  });

  it("rate limited or not in the plan → no crash, and the model is told to check the web honestly", async () => {
    const { AppError } = await import("@/core/errors");
    const { ports, ctx } = setup({
      quotes: async () => {
        throw new AppError("RATE_LIMITED", "busy");
      },
    });
    const out = await executeToolCall(ports, ctx, {
      name: "markets.getQuote",
      args: { symbols: ["NVDA"] },
    });
    expect(out.status === "succeeded" && out.output).toMatchObject({
      available: false,
      reason: "rate_limited",
    });
    expect(JSON.stringify(out.status === "succeeded" && out.output)).toMatch(
      /never as a live quote/,
    );
  });

  it("a symbol outside the plan falls back to the same company's other listing (GOOG → GOOGL)", async () => {
    const { AppError } = await import("@/core/errors");
    const alphabet = [
      inst("GOOG", "Alphabet Inc.", "NASDAQ"),
      inst("GOOGL", "Alphabet Inc.", "NASDAQ"),
    ];
    const { ports, ctx } = setup({
      quotes: async () => {
        throw new AppError("CAPABILITY_UNAVAILABLE", "plan", { details: { reason: "plan" } });
      },
      search: async (q) =>
        q === "GOOG" ? alphabet.slice(0, 1) : q === "Alphabet Inc." ? alphabet : [],
      quote: async (s) => (s === "GOOGL" ? quote("GOOGL", 340.59, -2.47) : null),
    });
    const out = await executeToolCall(ports, ctx, {
      name: "markets.getQuote",
      args: { symbols: ["GOOG"] },
    });
    expect(out.status === "succeeded" && out.output).toMatchObject({
      quotes: [{ symbol: "GOOGL" }],
      substituted: [{ asked: "GOOG", used: "GOOGL" }],
    });
    expect(out.status === "succeeded" && out.display).toMatchObject({ kind: "market" });
  });

  it("'Seguí Alphabet y Apple' → resolved symbols are followed; unknown names are reported", async () => {
    const { ports, ctx, watch } = setup({
      search: async (q) =>
        q === "Alphabet"
          ? [inst("GOOG", "Alphabet Inc.", "NASDAQ")]
          : q === "Apple"
            ? [inst("AAPL", "Apple Inc.", "NASDAQ")]
            : [],
    });
    const out = await executeToolCall(ports, ctx, {
      name: "markets.watch",
      args: { assets: ["Alphabet", "Apple", "Inventada SA"] },
    });
    expect(watch().map((w) => w.symbol)).toEqual(["GOOG", "AAPL"]);
    expect(out.status === "succeeded" && out.output).toMatchObject({ notFound: ["Inventada SA"] });
    await executeToolCall(ports, ctx, { name: "markets.unwatch", args: { assets: ["Apple"] } });
    expect(watch().map((w) => w.symbol)).toEqual(["GOOG"]);
  });
});

describe("routing: market tools only for market questions", () => {
  it.each([
    "¿Cómo está Alphabet en bolsa hoy?",
    "¿A cuánto está AAPL?",
    "¿Por qué cayó NVIDIA hoy?",
    "Mostrame cómo vienen las acciones de Microsoft",
    "Seguí Alphabet, Apple y Microsoft en mis resúmenes.",
    "¿Cómo viene lo que sigo?",
  ])("%s → markets", (m) => expect(MARKET_SIGNAL.test(m)).toBe(true));
  it.each([
    "¿Cuánto gasté este mes?",
    "Agregá leche a la lista",
    "¿Qué tengo hoy?",
    "Seguí con la tarea de ayer",
  ])("%s → not markets", (m) => expect(MARKET_SIGNAL.test(m)).toBe(false));
});

describe("markets in the Morning Brief", () => {
  it("the biggest movers first, a few only, as followed assets — never holdings", async () => {
    const { assembleBrief, briefTopics } = await import("@/core/briefs/morning-brief");
    const { briefExperience } = await import("@/core/schedules/experience");
    const view = (symbol: string, pct: number) => ({
      symbol,
      name: `${symbol} Inc.`,
      price: 100,
      currency: "USD",
      change: null,
      changePercent: pct,
      open: null,
      previousClose: null,
      dayHigh: null,
      dayLow: null,
      volume: null,
      asOf: null,
      freshness: "delayed" as const,
    });
    const brief = assembleBrief({
      now: NOW,
      timezone: "America/Argentina/Buenos_Aires",
      locale: "es",
      markets: {
        period: "today",
        quotes: [
          view("AAPL", 0.4),
          view("GOOGL", -2.47),
          view("MSFT", 0.9),
          view("A", 0.1),
          view("B", 0.2),
          view("C", 0.3),
        ],
        periodChange: {},
        news: [],
      },
      warnings: [],
    });
    expect(brief.markets!.items.map((i) => i.symbol)).toEqual(["GOOGL", "MSFT", "AAPL", "C", "B"]);
    expect(brief.markets!.total).toBe(6);
    expect(briefTopics(brief)).toContain("markets");
    const segment = briefExperience(brief, "es").segments.find((s) => s.id === "markets")!;
    expect(segment.say).toBe("El mayor movimiento entre lo que seguís: GOOGL (-2,47%).");
    expect(JSON.stringify(segment)).not.toMatch(/cartera|tus inversiones/i);
  });
});
