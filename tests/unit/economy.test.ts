import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { ECONOMY_SIGNAL, HOLIDAY_WORDS, SHOPPING_SIGNAL } from "@/core/agents/tool-selection";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  compoundInflation,
  convert,
  fxChange,
  fxMarketOf,
  realReturn,
  simulateDeposit,
  spread,
  yearsOf,
  type EconomyCapability,
  type Source,
} from "@/core/economy/model";

import { makeCtx, makePorts } from "./../fixtures/core-fakes";

vi.mock("server-only", () => ({}));

const { ArgentinaDatos, DolarApi } = await import("@/infrastructure/economy/argentina");
const { economyCapability } = await import("@/application/economy-service");

/**
 * Argentina's economy (ADR-094): providers behind a validated, cached capability; figures dated
 * and sourced; every calculation by code; holidays as context, never as the user's events.
 */

const NOW = new Date("2026-10-19T15:00:00Z"); // 12:00 in Buenos Aires
const source = (over: Partial<Source> = {}): Source => ({
  provider: "argentinadatos",
  name: "ArgentinaDatos",
  original: null,
  url: "https://argentinadatos.com",
  fetchedAt: NOW.toISOString(),
  stale: false,
  ...over,
});
const s = <T>(value: T, over: Partial<Source> = {}) => ({ value, source: source(over) });

describe("the numbers are code, never the model's", () => {
  it("markets by the names people use; unknown ones are never guessed", () => {
    expect(fxMarketOf("MEP")).toBe("bolsa");
    expect(fxMarketOf("dólar blue")).toBe("blue");
    expect(fxMarketOf("contado con liqui")).toBe("contadoconliqui");
    expect(fxMarketOf("turista")).toBe("tarjeta");
    expect(fxMarketOf("dólar ahorro")).toBe("solidario");
    expect(fxMarketOf("dólar soja")).toBeNull();
  });

  it("buy and sell never merge: conversions take the side of the trade; spread is sell − buy", () => {
    const q = { buy: 1535, sell: 1555 };
    expect(convert(100, "usd_to_ars", q)).toEqual({ rate: 1535, side: "buy", result: 153500 });
    expect(convert(155500, "ars_to_usd", q)).toEqual({ rate: 1555, side: "sell", result: 100 });
    expect(convert(1, "usd_to_ars", { buy: null, sell: 1 })).toBeNull();
    expect(spread(q)).toEqual({ amount: 20, percentOfBuy: 1.3 });
    expect(spread({ buy: 0, sell: 5 })).toBeNull();
  });

  it("accumulated inflation compounds whole months and says which are missing", () => {
    const f = [
      { month: "2026-07", value: 2 },
      { month: "2026-08", value: 3 },
      { month: "2026-09", value: 1.9 },
    ];
    const acc = compoundInflation(f, "2026-07", "2026-09");
    // 1.02 × 1.03 × 1.019 − 1 = 7.06 %, not 6.9 (the sum).
    expect(acc).toMatchObject({ percent: 7.06, months: 3, complete: true, missing: [] });
    const gap = compoundInflation(f, "2026-06", "2026-09");
    expect(gap).toMatchObject({ complete: false, missing: ["2026-06"], months: 4 });
    expect(compoundInflation(f, "2026-12", "2026-12+".slice(0, 7)).complete).toBe(false);
  });

  it("real return divides, never subtracts; deposits are simple interest on 365 days", () => {
    expect(realReturn(15, 10)).toBe(4.55);
    expect(realReturn(5, -100)).toBeNull();
    expect(simulateDeposit(1_000_000, 0.2, 30)).toEqual({
      interest: 16438.36,
      total: 1016438.36,
      teaPercent: 21.94,
    });
    expect(simulateDeposit(0, 0.2, 30)).toBeNull();
  });

  it("a period's change uses the side asked, and needs two days", () => {
    const pts = [
      { market: "blue" as const, date: "2026-10-02", buy: 1400, sell: 1420 },
      { market: "blue" as const, date: "2026-10-01", buy: 1390, sell: 1400 },
      { market: "blue" as const, date: "2026-10-03", buy: null, sell: 1430 },
    ];
    expect(fxChange(pts, "sell")).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-03",
      start: 1400,
      end: 1430,
      changePercent: 2.14,
    });
    expect(fxChange(pts, "buy")).toMatchObject({ to: "2026-10-02", days: 2 });
    expect(fxChange(pts.slice(0, 1), "sell")).toBeNull();
    expect(yearsOf("2026-12-28", "2027-01-04")).toEqual([2026, 2027]);
  });
});

describe("the providers: validated, bounded, honest about failures", () => {
  const json = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("current quotes: unknown markets and bad rows are dropped, never the series", async () => {
    const f = json([
      { casa: "blue", compra: 1535, venta: 1555, fechaActualizacion: "2026-10-19T13:57:00.000Z" },
      { casa: "soja", compra: 1, venta: 2 },
      { casa: "oficial", compra: "x" },
    ]);
    const quotes = await new DolarApi(f as unknown as typeof fetch).current();
    expect(quotes).toEqual([
      { market: "blue", buy: 1535, sell: 1555, asOf: "2026-10-19T13:57:00.000Z" },
    ]);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe("https://dolarapi.com/v1/dolares");
  });

  it("history is de-duplicated and in date order; a day uses the documented path", async () => {
    const f = json([
      { casa: "blue", compra: 2, venta: 3, fecha: "2026-10-02" },
      { casa: "blue", compra: 1, venta: 2, fecha: "2026-10-01" },
      { casa: "blue", compra: 2, venta: 3, fecha: "2026-10-02" },
    ]);
    const ad = new ArgentinaDatos(f as unknown as typeof fetch);
    expect((await ad.rateHistory("blue")).map((p) => p.date)).toEqual(["2026-10-01", "2026-10-02"]);
    const day = json({ casa: "blue", compra: 1220, venta: 1240, fecha: "2025-03-14" });
    await new ArgentinaDatos(day as unknown as typeof fetch).rateOn("blue", "2025-03-14");
    expect(String((day.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.argentinadatos.com/v1/cotizaciones/dolares/blue/2025/03/14",
    );
  });

  it("a year not published is null; 429, 500, bad JSON and network errors are typed", async () => {
    const missing = new ArgentinaDatos(
      json({ error: "Not found" }, 404) as unknown as typeof fetch,
    );
    expect(await missing.holidays(2028, false)).toBeNull();
    expect(await missing.holidays(1999, false)).toBeNull(); // out of bounds: never requested
    await expect(
      new ArgentinaDatos(json({}, 429) as unknown as typeof fetch).depositRates(),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      new ArgentinaDatos(json({}, 500) as unknown as typeof fetch).uva(),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const garbage = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(
      new ArgentinaDatos(garbage as unknown as typeof fetch).uva(),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(new DolarApi(down as unknown as typeof fetch).current()).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("holiday kinds come from the source; a bank calendar is all 'bancario'", async () => {
    const f = json([
      { fecha: "2026-03-23", tipo: "puente", nombre: "Puente turístico no laborable" },
      { fecha: "2026-03-24", tipo: "inamovible", nombre: "Día de la Memoria" },
      { fecha: "2027-01-01", tipo: "inamovible", nombre: "Otro año" },
    ]);
    const list = await new ArgentinaDatos(f as unknown as typeof fetch).holidays(2026, false);
    expect(list).toEqual([
      { date: "2026-03-23", name: "Puente turístico no laborable", kind: "puente" },
      { date: "2026-03-24", name: "Día de la Memoria", kind: "inamovible" },
    ]);
    const bank = await new ArgentinaDatos(
      json([{ fecha: "2026-11-06", nombre: "Día del Bancario" }]) as unknown as typeof fetch,
    ).holidays(2026, true);
    expect(bank).toEqual([{ date: "2026-11-06", name: "Día del Bancario", kind: "bancario" }]);
  });
});

describe("the shared cache", () => {
  it("one provider call for concurrent asks; a failure serves the last good copy marked stale", async () => {
    let calls = 0;
    let fail = false;
    const dolar = {
      current: async () => {
        calls++;
        if (fail) throw new Error("down");
        await new Promise((r) => setTimeout(r, 5));
        return [{ market: "blue" as const, buy: 1, sell: 2, asOf: null }];
      },
    } as unknown as InstanceType<typeof DolarApi>;
    const cap = economyCapability(dolar, new ArgentinaDatos());
    const [a, b] = await Promise.all([cap.currentRates(), cap.currentRates()]);
    expect(calls).toBe(1);
    expect(a.source.stale || b.source.stale).toBe(false);
    vi.useFakeTimers({ now: Date.now() + 10 * 60_000 });
    fail = true;
    const c = await cap.currentRates();
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(c.source.stale).toBe(true);
    expect(c.value[0]!.sell).toBe(2);
  });
});

/** The tools against an in-memory capability. */
function setup(port: Partial<EconomyCapability>, ctx = {}) {
  const full: EconomyCapability = {
    currentRates: async () => s([]),
    rateOn: async () => s(null),
    rateHistory: async () => s([]),
    inflation: async () => s([]),
    holidays: async () => null,
    depositRates: async () => s([]),
    countryRisk: async () => s({ date: "2026-10-16", value: 648 }),
    uva: async () => s([]),
    ...port,
  };
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "economy" ? full : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW, ...ctx }) };
}

const call = async (port: Partial<EconomyCapability>, name: string, args: unknown, ctx = {}) => {
  const { ports, ctx: c } = setup(port, ctx);
  const out = await executeToolCall(ports, c, { name, args });
  if (out.status !== "succeeded") throw new Error(`${name} ${out.status}`);
  return out as typeof out & { output: Record<string, unknown> };
};

describe("economy tools", () => {
  it("'¿A cuánto está el blue?' → buy and sell with their time; an old quote is never 'now'", async () => {
    const out = await call(
      {
        currentRates: async () =>
          s(
            [
              { market: "blue", buy: 1535, sell: 1555, asOf: "2026-10-19T13:57:00.000Z" },
              { market: "oficial", buy: 1485, sell: 1535, asOf: "2026-10-10T11:00:00.000Z" },
            ],
            { provider: "dolarapi", name: "DolarApi" },
          ),
      },
      "economy.exchangeRates",
      { markets: ["blue", "oficial", "soja"], amount: 100, direction: "usd_to_ars" },
    );
    const o = out.output as {
      rates: { market: string; notCurrent?: boolean }[];
      conversion: { result: number; side: string };
      notAvailable: string[];
      source: string;
    };
    expect(o.rates.map((r) => [r.market, Boolean(r.notCurrent)])).toEqual([
      ["blue", false],
      ["oficial", true],
    ]);
    expect(o.conversion).toMatchObject({ result: 153500, side: "buy" });
    expect(o.notAvailable).toEqual(["soja"]);
    expect(o.source).toBe("DolarApi");
    expect(out.display).toMatchObject({ kind: "economy", economy: { mode: "rates", unit: "ars" } });
  });

  it("'el blue hace 3 meses' → that day, computed in the user's calendar; today is refused", async () => {
    const asked: string[] = [];
    await call(
      { rateOn: async (_m, d) => (asked.push(d), s({ market: "blue", date: d, buy: 1, sell: 2 })) },
      "economy.exchangeHistory",
      { market: "blue", monthsAgo: 3 },
    );
    expect(asked).toEqual(["2026-07-19"]);
    const today = await call({}, "economy.exchangeHistory", { market: "blue", date: "2026-10-19" });
    expect(String(today.output.instructions)).toMatch(/exchangeRates/);
    const none = await call({ rateOn: async () => s(null) }, "economy.exchangeHistory", {
      market: "MEP",
      date: "2020-01-01",
    });
    expect(none.output).toMatchObject({ found: false });
  });

  it("inflation: the last published month, said as that month; YTD compounded with gaps flagged", async () => {
    const monthly = [
      { month: "2026-01", value: 2 },
      { month: "2026-02", value: 2 },
      { month: "2026-04", value: 1.5 },
      { month: "2026-09", value: 1.9 },
    ];
    const port = {
      inflation: async (kind: "monthly" | "yearly") =>
        s(kind === "monthly" ? monthly : [{ month: "2026-09", value: 33.4 }], {
          original: "INDEC",
        }),
    };
    const latest = await call(port, "economy.inflation", { kind: "latest" });
    expect(latest.output).toMatchObject({
      month: "2026-09",
      monthlyPercent: 1.9,
      yearOnYearPercent: 33.4,
      source: "ArgentinaDatos (INDEC)",
    });
    const ytd = await call(port, "economy.inflation", { kind: "ytd", nominalReturnPercent: 20 });
    expect(ytd.output).toMatchObject({ from: "2026-01", to: "2026-09", complete: false });
    expect((ytd.output.missingMonths as string[]).length).toBe(5);
    expect(ytd.output.realReturnPercent).toBeTypeOf("number");
    const future = await call(port, "economy.inflation", { kind: "month", month: "2026-10" });
    expect(String(future.output.instructions)).toMatch(/isn't published yet/);
  });

  it("holidays: Argentina's for an Argentine context; another country is said, never substituted", async () => {
    const port = {
      holidays: async (year: number, bank: boolean) =>
        year === 2026
          ? s(
              bank
                ? [
                    { date: "2026-10-12", name: "Diversidad Cultural", kind: "bancario" as const },
                    { date: "2026-11-06", name: "Día del Bancario", kind: "bancario" as const },
                  ]
                : [
                    {
                      date: "2026-10-12",
                      name: "Diversidad Cultural",
                      kind: "trasladable" as const,
                    },
                    {
                      date: "2026-11-23",
                      name: "Soberanía Nacional",
                      kind: "trasladable" as const,
                    },
                  ],
            )
          : null,
    };
    const next = await call(port, "calendar.holidays", { next: true });
    expect((next.output.holidays as { date: string }[]).map((h) => h.date)).toEqual(["2026-11-23"]);
    const range = await call(port, "calendar.holidays", { from: "2026-11-01", to: "2027-01-05" });
    const o = range.output as {
      holidays: { date: string; kind: string }[];
      notPublished: string[];
    };
    // The bank-only day is its own row; a bank holiday on a national one isn't repeated.
    expect(o.holidays.map((h) => [h.date, h.kind])).toEqual([
      ["2026-11-06", "bancario"],
      ["2026-11-23", "trasladable"],
    ]);
    expect(o.notPublished).toEqual(["2027"]);
    const madrid = await call(
      port,
      "calendar.holidays",
      { next: true },
      { timezone: "Europe/Madrid" },
    );
    expect(madrid.output).toMatchObject({ supported: false });
    const english = await call(port, "calendar.holidays", { next: true }, { locale: "en" });
    expect(english.output).toMatchObject({ supported: false });
    const explicit = await call(
      port,
      "calendar.holidays",
      { next: true, country: "AR" },
      { timezone: "Europe/Madrid" },
    );
    expect((explicit.output.holidays as unknown[]).length).toBe(1);
    const spain = await call(port, "calendar.holidays", { next: true, country: "ES" });
    expect(String(spain.output.instructions)).toMatch(/only has Argentina/);
  });

  it("deposit rates: best first, an illustration, never advice", async () => {
    const out = await call(
      {
        depositRates: async () =>
          s([
            { entity: "Banco A", tnaClients: 0.18, tnaNonClients: null },
            { entity: "Banco B", tnaClients: 0.2, tnaNonClients: 0.19 },
            { entity: "Banco C", tnaClients: null, tnaNonClients: null },
          ]),
      },
      "economy.depositRates",
      { amount: 1_000_000 },
    );
    const o = out.output as {
      rates: { bank: string }[];
      simulation: { bank: string; total: number };
    };
    expect(o.rates.map((r) => r.bank)).toEqual(["Banco B", "Banco A"]);
    expect(o.simulation).toMatchObject({ bank: "Banco B", total: 1016438.36 });
    expect(String(out.output.instructions)).toMatch(/Never recommend/);
  });

  it("a provider down is said plainly, with nothing invented", async () => {
    const out = await call(
      { currentRates: async () => Promise.reject(new Error("down")) },
      "economy.exchangeRates",
      {},
    );
    expect(out.output).toMatchObject({ available: false });
    expect(out.display).toBeUndefined();
  });
});

describe("routing", () => {
  it("economic questions bring the economy tools; holidays their guidance", () => {
    for (const m of [
      "a cuánto está el dólar blue",
      "inflación de septiembre",
      "comparame tasas de plazo fijo",
      "cómo está el riesgo país",
      "el MEP hace tres meses",
      "¿Cuánto subieron los precios acumulados en los últimos seis meses?",
      "cuánto aumentaron los precios este año",
    ])
      expect(ECONOMY_SIGNAL.test(m), m).toBe(true);
    expect(ECONOMY_SIGNAL.test("prendé la luz del living")).toBe(false);
    expect(HOLIDAY_WORDS.test("¿hay feriados la semana que viene?")).toBe(true);
  });

  it("a product's price brings shopping (Mercado Libre), however it's asked", () => {
    for (const m of [
      "cuánto me sale un termo Stanley?",
      "cuánto sale un Broadlink RM4 Mini",
      "cuánto cuestan los auriculares Sony",
      "cuánto te sale una freidora de aire",
    ])
      expect(SHOPPING_SIGNAL.test(m), m).toBe(true);
    expect(SHOPPING_SIGNAL.test("cuánto falta para el viernes")).toBe(false);
  });
});
