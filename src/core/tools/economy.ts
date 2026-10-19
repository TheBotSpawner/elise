import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  compoundInflation,
  convert,
  ECONOMY_LIMITS,
  FX_LABELS,
  FX_MARKETS,
  fxChange,
  fxMarketOf,
  holidaysIn,
  realReturn,
  simulateDeposit,
  spread,
  yearsOf,
  type EconomyCapability,
  type FxMarket,
  type FxPoint,
  type Holiday,
  type MonthlyFigure,
  type Source,
} from "../economy/model";
import { toAppError } from "../errors";
import { addDays, todayIn } from "../time";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Economy tools (ADR-094): Argentina's dollar, inflation, deposit rates, indicators and
 * holidays, from public sources — never web search, never the model's arithmetic. Read-only;
 * nothing here touches the user's Finance records. Each figure is dated and sourced.
 */

type Payload = SurfacePayloads["economy"];

function economy(env: ToolRunEnv): EconomyCapability {
  return env.providers.get("economy", env.binding);
}

const es = (env: ToolRunEnv) => env.ctx.locale === "es";
const today = (env: ToolRunEnv) => todayIn(env.ctx.timezone, env.ctx.now);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");

const sourceView = (s: Source): Payload["sources"][number] => ({
  name: s.name,
  original: s.original,
  url: s.url,
  fetchedAt: s.fetchedAt,
  stale: s.stale,
});
const cite = (s: Source) => ({
  source: s.original ? `${s.name} (${s.original})` : s.name,
  url: s.url,
  readAt: s.fetchedAt,
  ...(s.stale ? { stale: true } : {}),
});

/** A provider failure as the model sees it: say it plainly, invent nothing. */
function unavailable(error: unknown) {
  const e = toAppError(error);
  return {
    available: false,
    code: e.code,
    instructions:
      "The data source isn't answering right now. Say so in one line; don't estimate or search the web for a number.",
  };
}

const marketLabel = (m: FxMarket, env: ToolRunEnv) => FX_LABELS[m][es(env) ? "es" : "en"];

function markets(said: readonly string[] | undefined) {
  const known: FxMarket[] = [];
  const unknown: string[] = [];
  for (const s of said ?? []) {
    const m = fxMarketOf(s);
    if (m) known.push(m);
    else unknown.push(s);
  }
  return { known: [...new Set(known)], unknown };
}

const marketField = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .describe(
    'A dollar market as the user said it: "blue", "oficial", "MEP", "CCL", "mayorista", "cripto", "tarjeta".',
  );

// ── Current rates ────────────────────────────────────────────────────────────

const ratesInput = z
  .object({
    markets: z
      .array(marketField)
      .max(8)
      .optional()
      .describe('Which markets. Omit for all (the user asked about "el dólar" in general).'),
    amount: z
      .number()
      .positive()
      .max(1e12)
      .optional()
      .describe('An amount to convert ("¿cuántos pesos son 300 dólares?"), with direction.'),
    direction: z.enum(["usd_to_ars", "ars_to_usd"]).optional(),
  })
  .strict();

export const exchangeRatesTool: ToolDefinition = {
  name: "economy.exchangeRates",
  capability: "economy",
  operation: "exchangeRates",
  description:
    '"¿A cuánto está el dólar blue?", "dólar oficial y MEP hoy", "¿cuántos pesos son 300 dólares al blue?": Argentina\'s current dollar quotes by market — buy and sell, each with the time the source gives — and a conversion estimate. Structured data: never web search for this.',
  input: ratesInput,
  async describe(raw) {
    const q = ratesInput.parse(raw);
    return { summary: `Dollar rates${q.markets?.length ? ` · ${q.markets.join(", ")}` : ""}` };
  },
  async run(raw, env) {
    const q = ratesInput.parse(raw);
    const { known, unknown } = markets(q.markets);
    let r: Awaited<ReturnType<EconomyCapability["currentRates"]>>;
    try {
      r = await economy(env).currentRates();
    } catch (error) {
      return { output: unavailable(error) };
    }
    const wanted = known.length ? r.value.filter((x) => known.includes(x.market)) : r.value;
    const now = env.ctx.now.getTime();
    // An old copy (or an old quote at the source) is the last known one, never "now".
    const old = (asOf: string | null) =>
      r.source.stale || !asOf || now - Date.parse(asOf) > ECONOMY_LIMITS.currentStaleAfterMs;
    const rates = wanted.map((x) => ({
      market: x.market,
      label: marketLabel(x.market, env),
      buy: x.buy,
      sell: x.sell,
      asOf: x.asOf,
      ...(old(x.asOf) ? { notCurrent: true } : {}),
      ...(spread(x) ? { spread: spread(x) } : {}),
    }));
    const target = wanted[0];
    const conversion =
      q.amount && q.direction && target
        ? {
            market: target.market,
            amount: q.amount,
            direction: q.direction,
            ...convert(q.amount, q.direction, target),
          }
        : null;
    const missing = [...unknown, ...known.filter((m) => !wanted.some((x) => x.market === m))];
    return {
      output: {
        rates,
        ...(conversion ? { conversion } : {}),
        ...(missing.length ? { notAvailable: missing } : {}),
        ...cite(r.source),
        instructions:
          'Name each market and keep buy ("compra") and sell ("venta") apart. "notCurrent" = the last known quote: say its date, never "ahora". A conversion is an estimate at that side of that market (selling dollars gets "compra"; buying costs "venta"). In voice, one short sentence; the card shows the rest.',
      },
      display: {
        kind: "economy",
        key: "rates",
        title: es(env) ? "Dólar en Argentina" : "Dollar in Argentina",
        economy: {
          mode: "rates",
          headline:
            conversion && "result" in conversion && conversion.result !== undefined
              ? {
                  label:
                    conversion.direction === "usd_to_ars"
                      ? `${q.amount} USD · ${marketLabel(conversion.market, env)} (${es(env) ? "compra" : "buy"})`
                      : `${q.amount} ARS · ${marketLabel(conversion.market, env)} (${es(env) ? "venta" : "sell"})`,
                  value: conversion.result,
                  unit: conversion.direction === "usd_to_ars" ? "ars" : "usd",
                  period: null,
                  partial: false,
                }
              : null,
          rows: rates.map((x) => ({
            label: x.label,
            date: x.asOf,
            buy: x.buy,
            sell: x.sell,
            value: null,
            kind: null,
          })),
          series: null,
          unit: "ars",
          notes: missing.length
            ? [es(env) ? `Sin dato: ${missing.join(", ")}.` : `No data: ${missing.join(", ")}.`]
            : [],
          sources: [sourceView(r.source)],
        },
      },
    };
  },
};

// ── History ──────────────────────────────────────────────────────────────────

const HISTORY_PERIODS = ["week", "month", "3m", "6m", "1y", "ytd"] as const;

const historyInput = z
  .object({
    market: marketField,
    date: isoDate.optional().describe('One past day (YYYY-MM-DD): "el 15 de marzo de 2025".'),
    daysAgo: z.number().int().min(1).max(3650).optional(),
    monthsAgo: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe('"Hace 3 meses" → 3 (ELISE computes the date in the user\'s calendar).'),
    period: z.enum(HISTORY_PERIODS).optional().describe("A recent period to chart."),
    from: isoDate.optional(),
    to: isoDate.optional(),
    side: z
      .enum(["buy", "sell"])
      .default("sell")
      .describe('"sell" (venta) unless they said "compra".'),
  })
  .strict();

function monthsBack(day: string, n: number) {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

function periodFrom(period: (typeof HISTORY_PERIODS)[number], day: string) {
  switch (period) {
    case "week":
      return addDays(day, -7);
    case "month":
      return monthsBack(day, 1);
    case "3m":
      return monthsBack(day, 3);
    case "6m":
      return monthsBack(day, 6);
    case "1y":
      return monthsBack(day, 12);
    case "ytd":
      return `${day.slice(0, 4)}-01-01`;
  }
}

export const exchangeHistoryTool: ToolDefinition = {
  name: "economy.exchangeHistory",
  capability: "economy",
  operation: "exchangeHistory",
  description:
    '"¿Cuánto estaba el blue el 15 de marzo de 2025?", "el MEP hace 3 meses", "¿cómo se movió el oficial este año?", "blue vs oficial en el último mes": a past day or a period of one dollar market (daily closing quotes), with the change computed. Never the current quote: that is economy.exchangeRates.',
  input: historyInput,
  async describe(raw) {
    const q = historyInput.parse(raw);
    return { summary: `Dollar ${q.market} history` };
  },
  async run(raw, env) {
    const q = historyInput.parse(raw);
    const m = fxMarketOf(q.market);
    if (!m)
      return {
        output: {
          found: false,
          instructions: `Unknown dollar market. Known: ${FX_MARKETS.join(", ")} (MEP = bolsa, CCL = contadoconliqui). Ask which one.`,
        },
      };
    const day = today(env);
    const label = marketLabel(m, env);
    const side = q.side;
    const single =
      q.date ??
      (q.daysAgo ? addDays(day, -q.daysAgo) : q.monthsAgo ? monthsBack(day, q.monthsAgo) : null);
    try {
      if (single) {
        if (single >= day)
          return {
            output: {
              found: false,
              instructions:
                "That's today or later: use economy.exchangeRates for the current quote.",
            },
          };
        const r = await economy(env).rateOn(m, single);
        if (!r.value)
          return {
            output: {
              found: false,
              market: label,
              date: single,
              ...cite(r.source),
              instructions:
                "The source has no quote for that market on that day. Say so; never use another day or market instead.",
            },
          };
        const p = r.value;
        return {
          output: {
            market: label,
            date: p.date,
            buy: p.buy,
            sell: p.sell,
            ...cite(r.source),
            instructions:
              'A past day, said with its date — never "hoy" or "ahora". Keep compra and venta apart.',
          },
          display: {
            kind: "economy",
            key: `history:${m}`,
            title: es(env) ? `Dólar ${label} · ${p.date}` : `${label} dollar · ${p.date}`,
            economy: {
              mode: "history",
              headline: null,
              rows: [{ label, date: p.date, buy: p.buy, sell: p.sell, value: null, kind: null }],
              series: null,
              unit: "ars",
              notes: [],
              sources: [sourceView(r.source)],
            },
          },
        };
      }
      const to = q.to && q.to < day ? q.to : day;
      const from = q.from ?? periodFrom(q.period ?? "month", day);
      const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      if (!(span >= 0) || span > ECONOMY_LIMITS.maxHistoryDays)
        return {
          output: {
            found: false,
            instructions: `Ask for a period of at most ${ECONOMY_LIMITS.maxHistoryDays} days.`,
          },
        };
      const r = await economy(env).rateHistory(m);
      const points: FxPoint[] = r.value.filter((p) => p.date >= from && p.date <= to);
      const change = fxChange(points, side);
      if (!change)
        return {
          output: {
            found: false,
            market: label,
            from,
            to,
            ...cite(r.source),
            instructions: "Not enough daily quotes in that period. Say so; don't fill the gap.",
          },
        };
      const sideWord = side === "sell" ? (es(env) ? "venta" : "sell") : es(env) ? "compra" : "buy";
      return {
        output: {
          market: label,
          side,
          ...change,
          ...cite(r.source),
          instructions:
            "Daily quotes from the source, change computed by ELISE. Say the period's dates and the side. Days without a quote at the source aren't invented.",
        },
        display: {
          kind: "economy",
          key: `history:${m}`,
          title: es(env) ? `Dólar ${label}` : `${label} dollar`,
          economy: {
            mode: "history",
            headline: {
              label: es(env) ? `Variación (${sideWord})` : `Change (${sideWord})`,
              value: change.changePercent,
              unit: "percent",
              period: `${change.from} → ${change.to}`,
              partial: r.source.stale,
            },
            rows: [
              {
                label: es(env) ? "Inicio" : "Start",
                date: change.from,
                buy: null,
                sell: null,
                value: change.start,
                kind: null,
              },
              {
                label: es(env) ? "Último" : "Latest",
                date: change.to,
                buy: null,
                sell: null,
                value: change.end,
                kind: null,
              },
              {
                label: es(env) ? "Máximo" : "High",
                date: null,
                buy: null,
                sell: null,
                value: change.high,
                kind: null,
              },
              {
                label: es(env) ? "Mínimo" : "Low",
                date: null,
                buy: null,
                sell: null,
                value: change.low,
                kind: null,
              },
            ],
            series: points
              .filter((p) => p[side] !== null)
              .map((p) => ({ date: p.date, value: p[side]! }))
              .slice(-ECONOMY_LIMITS.maxHistoryDays),
            unit: "ars",
            notes: [
              es(env)
                ? `Cotización de ${sideWord}, cierre diario.`
                : `${sideWord} quote, daily close.`,
            ],
            sources: [sourceView(r.source)],
          },
        },
      };
    } catch (error) {
      return { output: unavailable(error) };
    }
  },
};

// ── Inflation ────────────────────────────────────────────────────────────────

const inflationInput = z
  .object({
    kind: z
      .enum(["latest", "month", "range", "ytd", "last_months"])
      .describe(
        'latest: the last published month · month: one month · range: accumulated from–to · ytd: so far this year · last_months: the last N published months ("los últimos seis meses").',
      ),
    month: isoMonth.optional().describe('For "month": "2026-06".'),
    from: isoMonth.optional(),
    to: isoMonth.optional(),
    months: z.number().int().min(1).max(120).optional(),
    nominalReturnPercent: z
      .number()
      .min(-100)
      .max(10_000)
      .optional()
      .describe(
        'A nominal return over the same period ("mi plazo fijo rindió 15%"): ELISE computes the real return.',
      ),
  })
  .strict();

const pct = (n: number) => `${n}%`;

export const inflationTool: ToolDefinition = {
  name: "economy.inflation",
  capability: "economy",
  operation: "inflation",
  description:
    '"¿Cuál fue la inflación del último mes?", "inflación de junio", "¿cuánto subieron los precios en los últimos seis meses?", "inflación acumulada del año", "interanual", "¿le gané a la inflación con 15%?": Argentina\'s monthly CPI (INDEC) — the last published month, one month with its year-on-year, or an accumulated period compounded by ELISE.',
  input: inflationInput,
  async describe(raw) {
    return { summary: `Inflation · ${inflationInput.parse(raw).kind}` };
  },
  async run(raw, env) {
    const q = inflationInput.parse(raw);
    let monthly: MonthlyFigure[];
    let yearly: MonthlyFigure[];
    let source: Source;
    try {
      const [a, b] = await Promise.all([
        economy(env).inflation("monthly"),
        economy(env).inflation("yearly"),
      ]);
      monthly = a.value;
      yearly = b.value;
      source = a.source.stale ? a.source : b.source;
    } catch (error) {
      return { output: unavailable(error) };
    }
    const last = monthly.at(-1);
    if (!last) return { output: unavailable(null) };
    const yoyOf = (m: string) => yearly.find((x) => x.month === m)?.value ?? null;
    const base = {
      lastPublishedMonth: last.month,
      ...cite(source),
    };
    const rowsOf = (list: MonthlyFigure[]) =>
      list.slice(-24).map((f) => ({
        label: f.month,
        date: null,
        buy: null,
        sell: null,
        value: f.value,
        kind: null,
      }));
    const surface = (
      headline: Payload["headline"],
      list: MonthlyFigure[],
      notes: string[] = [],
    ) => ({
      kind: "economy" as const,
      key: "inflation",
      title: es(env) ? "Inflación (IPC)" : "Inflation (CPI)",
      economy: {
        mode: "inflation" as const,
        headline,
        rows: rowsOf(list).reverse(),
        series: list.length > 2 ? list.map((f) => ({ date: f.month, value: f.value })) : null,
        unit: "percent" as const,
        notes,
        sources: [sourceView(source)],
      },
    });

    if (q.kind === "latest" || q.kind === "month") {
      const month = q.kind === "month" && q.month ? q.month : last.month;
      const f = monthly.find((x) => x.month === month);
      if (!f)
        return {
          output: {
            ...base,
            found: false,
            month,
            instructions:
              month > last.month
                ? `That month isn't published yet; the last published is ${last.month}. Say so.`
                : "No figure for that month at the source. Say so.",
          },
        };
      const yoy = yoyOf(month);
      return {
        output: {
          ...base,
          month,
          monthlyPercent: f.value,
          ...(yoy !== null ? { yearOnYearPercent: yoy } : {}),
          instructions:
            'Say the month it measures (it is published the following month): "la inflación de septiembre fue 1,9%". Never "la inflación de hoy".',
        },
        display: surface(
          {
            label: es(env) ? `Mensual · ${month}` : `Monthly · ${month}`,
            value: f.value,
            unit: "percent",
            period: yoy !== null ? `${es(env) ? "interanual" : "year on year"} ${pct(yoy)}` : null,
            partial: false,
          },
          monthly.filter((x) => x.month <= month).slice(-13),
        ),
      };
    }

    const to = q.kind === "range" && q.to ? (q.to > last.month ? last.month : q.to) : last.month;
    const from =
      q.kind === "range"
        ? (q.from ?? to)
        : q.kind === "ytd"
          ? `${to.slice(0, 4)}-01`
          : monthly.slice(-(q.months ?? 12))[0]!.month;
    if (from > to)
      return {
        output: {
          ...base,
          found: false,
          instructions: "The period's start is after its end. Ask again.",
        },
      };
    const acc = compoundInflation(monthly, from, to);
    const real =
      q.nominalReturnPercent !== undefined ? realReturn(q.nominalReturnPercent, acc.percent) : null;
    const list = monthly.filter((x) => x.month >= from && x.month <= to);
    const notes = [
      es(env)
        ? "Acumulada compuesta: (1+r₁)…(1+rₙ) − 1, no la suma."
        : "Compounded: (1+r₁)…(1+rₙ) − 1, not the sum.",
      ...(acc.missing.length
        ? [es(env) ? `Faltan: ${acc.missing.join(", ")}.` : `Missing: ${acc.missing.join(", ")}.`]
        : []),
      ...(real !== null
        ? [
            es(env)
              ? `Rendimiento real con ${pct(q.nominalReturnPercent!)} nominal: ${pct(real)} — (1+n)/(1+i) − 1.`
              : `Real return on ${pct(q.nominalReturnPercent!)} nominal: ${pct(real)} — (1+n)/(1+i) − 1.`,
          ]
        : []),
    ];
    return {
      output: {
        ...base,
        from,
        to,
        months: acc.months,
        accumulatedPercent: acc.percent,
        complete: acc.complete,
        ...(acc.missing.length ? { missingMonths: acc.missing } : {}),
        ...(real !== null
          ? { nominalPercent: q.nominalReturnPercent, realReturnPercent: real }
          : {}),
        instructions:
          'Compounded by ELISE from monthly figures; say the months it covers. If "complete" is false, say it isn\'t the whole period. A real return is general information, never advice.',
      },
      display: surface(
        {
          label: es(env) ? "Acumulada" : "Accumulated",
          value: acc.percent,
          unit: "percent",
          period: `${from} → ${to}`,
          partial: !acc.complete || source.stale,
        },
        list,
        notes,
      ),
    };
  },
};

// ── Deposit rates ────────────────────────────────────────────────────────────

const depositInput = z
  .object({
    amount: z
      .number()
      .positive()
      .max(1e13)
      .optional()
      .describe("Pesos to simulate, if they said an amount."),
    days: z.number().int().min(30).max(365).default(30),
    clients: z
      .boolean()
      .optional()
      .describe("true: rates for the bank's own clients; false: for non-clients. Omit for both."),
  })
  .strict();

export const depositRatesTool: ToolDefinition = {
  name: "economy.depositRates",
  capability: "economy",
  operation: "depositRates",
  description:
    '"Comparame las tasas de plazo fijo", "¿qué banco paga más?", "¿cuánto me daría un plazo fijo de 500.000 a 30 días?": Argentine banks\' published fixed-term rates (TNA), best first, and an illustrative simulation. General information, never advice.',
  input: depositInput,
  async describe() {
    return { summary: "Fixed-term deposit rates" };
  },
  async run(raw, env) {
    const q = depositInput.parse(raw);
    let r: Awaited<ReturnType<EconomyCapability["depositRates"]>>;
    try {
      r = await economy(env).depositRates();
    } catch (error) {
      return { output: unavailable(error) };
    }
    const rate = (x: (typeof r.value)[number]) =>
      q.clients === false
        ? x.tnaNonClients
        : q.clients === true
          ? x.tnaClients
          : Math.max(x.tnaClients ?? 0, x.tnaNonClients ?? 0) || null;
    const ranked = r.value
      .filter((x) => rate(x) !== null)
      .sort((a, b) => rate(b)! - rate(a)!)
      .slice(0, 15);
    const best = ranked[0];
    const sim = best && q.amount ? simulateDeposit(q.amount, rate(best)!, q.days) : null;
    const notes = [
      es(env)
        ? "Tasas publicadas para colocaciones online; cada banco fija montos, plazos y condiciones."
        : "Published rates for online deposits; each bank sets its own amounts, terms and conditions.",
      ...(sim
        ? [
            es(env)
              ? `Simulación: interés simple a ${q.days} días sobre año de 365, sin impuestos. TEA si se renueva igual: ${sim.teaPercent}%.`
              : `Simulation: simple interest for ${q.days} days on a 365-day year, before taxes. APY if renewed alike: ${sim.teaPercent}%.`,
          ]
        : []),
    ];
    return {
      output: {
        rates: ranked.map((x) => ({
          bank: x.entity,
          tnaClientsPercent: x.tnaClients !== null ? +(x.tnaClients * 100).toFixed(2) : null,
          tnaNonClientsPercent:
            x.tnaNonClients !== null ? +(x.tnaNonClients * 100).toFixed(2) : null,
        })),
        ...(sim && best
          ? { simulation: { bank: best.entity, amount: q.amount, days: q.days, ...sim } }
          : {}),
        ...cite(r.source),
        instructions:
          "Published rates, best first; the simulation is an illustration (simple interest, before taxes). Never recommend a bank or promise a return; the bank's own conditions decide.",
      },
      display: {
        kind: "economy",
        key: "deposits",
        title: es(env) ? "Plazo fijo · tasas" : "Fixed-term deposit rates",
        economy: {
          mode: "deposits",
          headline:
            sim && best
              ? {
                  label: `${best.entity} · ${q.days} ${es(env) ? "días" : "days"}`,
                  value: sim.total,
                  unit: "ars",
                  period: null,
                  partial: false,
                }
              : null,
          rows: ranked.map((x) => ({
            label: x.entity,
            date: null,
            buy: x.tnaClients !== null ? +(x.tnaClients * 100).toFixed(2) : null,
            sell: x.tnaNonClients !== null ? +(x.tnaNonClients * 100).toFixed(2) : null,
            value: null,
            kind: null,
          })),
          series: null,
          unit: "percent",
          notes,
          sources: [sourceView(r.source)],
        },
      },
    };
  },
};

// ── Indicators ───────────────────────────────────────────────────────────────

const indicatorsInput = z
  .object({
    which: z
      .array(z.enum(["country_risk", "uva"]))
      .min(1)
      .max(2),
  })
  .strict();

export const indicatorsTool: ToolDefinition = {
  name: "economy.indicators",
  capability: "economy",
  operation: "indicators",
  description:
    '"¿Cómo está el riesgo país?", "¿cuánto vale la UVA hoy?": Argentina\'s latest country risk (points) and UVA value, each with its date.',
  input: indicatorsInput,
  async describe(raw) {
    return { summary: `Indicators · ${indicatorsInput.parse(raw).which.join(", ")}` };
  },
  async run(raw, env) {
    const q = indicatorsInput.parse(raw);
    const port = economy(env);
    const rows: Payload["rows"] = [];
    const out: Record<string, unknown> = {};
    const sources: Source[] = [];
    try {
      if (q.which.includes("country_risk")) {
        const r = await port.countryRisk();
        out.countryRisk = { points: r.value.value, date: r.value.date };
        rows.push({
          label: es(env) ? "Riesgo país (puntos)" : "Country risk (points)",
          date: r.value.date,
          buy: null,
          sell: null,
          value: r.value.value,
          kind: null,
        });
        sources.push(r.source);
      }
      if (q.which.includes("uva")) {
        const r = await port.uva();
        const day = today(env);
        const latest = [...r.value].reverse().find((p) => p.date <= day);
        if (latest) {
          out.uva = { value: latest.value, date: latest.date };
          rows.push({
            label: "UVA",
            date: latest.date,
            buy: null,
            sell: null,
            value: latest.value,
            kind: null,
          });
        }
        sources.push(r.source);
      }
    } catch (error) {
      if (!rows.length) return { output: unavailable(error) };
    }
    return {
      output: {
        ...out,
        ...cite(sources[0]!),
        instructions: "Say each figure with its date. General information, never advice.",
      },
      display: {
        kind: "economy",
        key: "indicators",
        title: es(env) ? "Indicadores" : "Indicators",
        economy: {
          mode: "indicators",
          headline: null,
          rows,
          series: null,
          unit: "index",
          notes: [],
          sources: [...new Map(sources.map((s) => [s.name, sourceView(s)])).values()],
        },
      },
    };
  },
};

// ── Holidays ─────────────────────────────────────────────────────────────────

/**
 * Argentina is this person's own context: their timezone is Argentina's and they speak
 * Spanish — two signals, never one. Otherwise Argentine holidays are only for explicit asks.
 */
export function argentineContext(ctx: Pick<ToolRunEnv["ctx"], "timezone" | "locale">) {
  return ctx.timezone.startsWith("America/Argentina/") && ctx.locale === "es";
}

const holidaysInput = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    year: z.number().int().min(2016).max(2100).optional(),
    next: z
      .boolean()
      .optional()
      .describe('"¿Cuándo es el próximo feriado?": the next one from today.'),
    country: z
      .string()
      .trim()
      .length(2)
      .optional()
      .describe('ISO country ("AR") when the user named one. Omit to use theirs.'),
  })
  .strict();

const weekday = (date: string, locale: "es" | "en") =>
  new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );

export const holidaysTool: ToolDefinition = {
  name: "calendar.holidays",
  capability: "economy",
  operation: "holidays",
  description:
    '"¿Hay feriados la semana que viene?", "¿mañana es feriado?", "¿cuándo es el próximo feriado?", "feriados de 2027", "¿abren los bancos el lunes?": Argentina\'s national holidays, non-working days and bank holidays for a range — read-only, never written to any calendar.',
  input: holidaysInput,
  async describe() {
    return { summary: "Holidays" };
  },
  async run(raw, env) {
    const q = holidaysInput.parse(raw);
    const country = q.country?.toUpperCase() ?? (argentineContext(env.ctx) ? "AR" : null);
    if (country !== "AR")
      return {
        output: {
          supported: false,
          instructions: country
            ? `ELISE only has Argentina's official holiday calendar, not ${country}'s. Say so; don't list Argentina's as theirs.`
            : "ELISE doesn't know which country's holidays they mean (it has Argentina's). Ask, briefly.",
        },
      };
    const day = today(env);
    const from = q.next ? day : (q.from ?? (q.year ? `${q.year}-01-01` : day));
    const to = q.next
      ? addDays(day, 400)
      : (q.to ?? (q.year ? `${q.year}-12-31` : addDays(from, 7)));
    if (to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 400)
      return { output: { found: false, instructions: "Ask for at most a year of holidays." } };
    const port = economy(env);
    const years = yearsOf(from, to);
    let national: Holiday[] = [];
    let bank: Holiday[] = [];
    const notPublished: string[] = [];
    let source: Source | null = null;
    try {
      for (const y of years) {
        // "The next holiday" is a national one: bank calendars aren't read for it.
        const [n, b] = await Promise.all([
          port.holidays(y, false),
          q.next ? null : port.holidays(y, true),
        ]);
        if (n) {
          national = national.concat(n.value);
          source ??= n.source;
        } else if (!q.next || !national.length) notPublished.push(String(y));
        if (b) bank = bank.concat(b.value);
        else if (n && !q.next) notPublished.push(`${y} (${es(env) ? "bancarios" : "bank"})`);
      }
    } catch (error) {
      return { output: unavailable(error) };
    }
    // A bank holiday on a national holiday is the same day off; only bank-only days add a row.
    const nationalDays = new Set(national.map((h) => h.date));
    const all = holidaysIn(
      [...national, ...bank.filter((h) => !nationalDays.has(h.date))],
      from,
      to,
    );
    const list = q.next ? all.filter((h) => h.kind !== "bancario").slice(0, 1) : all;
    const items = list.map((h) => ({
      date: h.date,
      weekday: weekday(h.date, env.ctx.locale),
      name: h.name,
      kind: h.kind,
      ...(h.date === day ? { today: true } : h.date === addDays(day, 1) ? { tomorrow: true } : {}),
    }));
    if (!source)
      return {
        output: {
          holidays: [],
          notPublished,
          instructions: "That year's calendar isn't published yet. Say so; never guess dates.",
        },
      };
    return {
      output: {
        country: "AR",
        from,
        to,
        holidays: items,
        ...(notPublished.length ? { notPublished } : {}),
        ...cite(source),
        instructions:
          "kind: inamovible/trasladable = national holiday · puente = non-working day for tourism (not everyone is off) · bancario = banks don't operate. Never say every business closes. Holidays are context: never add them to the user's calendar unless they ask.",
      },
      display: {
        kind: "economy",
        key: "holidays",
        title: es(env) ? "Feriados en Argentina" : "Holidays in Argentina",
        economy: {
          mode: "holidays",
          headline: null,
          rows: items.slice(0, 40).map((h) => ({
            label: h.name,
            date: h.date,
            buy: null,
            sell: null,
            value: null,
            kind: h.kind,
          })),
          series: null,
          unit: "index",
          notes: [
            ...(items.length
              ? []
              : [es(env) ? "No hay feriados en ese período." : "No holidays in that period."]),
            ...(notPublished.length
              ? [
                  es(env)
                    ? `Sin calendario publicado: ${notPublished.join(", ")}.`
                    : `Not published yet: ${notPublished.join(", ")}.`,
                ]
              : []),
          ],
          sources: [sourceView(source)],
        },
      },
    };
  },
};

export const ECONOMY_TOOLS = [
  exchangeRatesTool,
  exchangeHistoryTool,
  inflationTool,
  depositRatesTool,
  indicatorsTool,
  holidaysTool,
] as const;
