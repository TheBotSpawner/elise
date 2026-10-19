import "server-only";

import { z } from "zod";

import {
  ECONOMY_LIMITS,
  FX_MARKETS,
  monthOf,
  type DepositRate,
  type FxMarket,
  type FxPoint,
  type FxQuote,
  type Holiday,
  type MonthlyFigure,
} from "@/core/economy/model";
import { AppError } from "@/core/errors";

/**
 * Argentina's public economic data (ADR-094), behind fixed HTTPS hosts (no URL ever comes from a
 * user or the model; path parts are enums, dates and bounded years). Responses are validated
 * here and mapped to ELISE's types; provider shapes and error bodies never leave this file.
 *
 * - DolarApi (https://dolarapi.com): current dollar quotes by market.
 * - ArgentinaDatos (https://argentinadatos.com): daily dollar history, INDEC inflation, BCRA
 *   series, national and bank holidays. Usage asks for a citation and about one read per series
 *   every 3 hours (https://argentinadatos.com/docs/uso).
 */

const DOLAR_API = "https://dolarapi.com/v1";
const ARGENTINA_DATOS = "https://api.argentinadatos.com/v1";

export const ECONOMY_SITES = {
  dolarapi: "https://dolarapi.com",
  argentinadatos: "https://argentinadatos.com",
} as const;

const market = z.enum(FX_MARKETS);
const price = z.number().finite().nonnegative().nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const currentRow = z.object({
  casa: z.string(),
  compra: price.optional(),
  venta: price.optional(),
  fechaActualizacion: z.string().optional(),
});
const historyRow = z.object({
  casa: z.string(),
  compra: price.optional(),
  venta: price.optional(),
  fecha: isoDate,
});
const figureRow = z.object({ fecha: isoDate, valor: z.number().finite() });
const holidayRow = z.object({
  fecha: isoDate,
  nombre: z.string().min(1).max(200),
  tipo: z.string().optional(),
});
const depositRow = z.object({
  entidad: z.string().min(1).max(200),
  tnaClientes: z.number().finite().nullable().optional(),
  tnaNoClientes: z.number().finite().nullable().optional(),
});

/** What a failure means for ELISE (no provider text reaches anyone). */
function failure(status: number): AppError {
  if (status === 429)
    return new AppError("RATE_LIMITED", "Economic data is busy right now", {
      recovery: "retry",
      details: { providerStatus: status },
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Economic data isn't responding", {
    recovery: "retry",
    details: { providerStatus: status },
  });
}

/** A JSON GET with a timeout and a size ceiling; 404 → null (the source has no such thing). */
async function getJson(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(ECONOMY_LIMITS.timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new AppError("PROVIDER_UNAVAILABLE", "Economic data isn't responding", {
      recovery: "retry",
      details: { providerStatus: 0 },
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw failure(res.status);
  const text = await res.text();
  if (text.length > ECONOMY_LIMITS.maxBytes) throw failure(413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failure(502);
  }
}

/** Valid rows only, de-duplicated by key, in date order: a bad row never breaks the series. */
function rows<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(raw)) throw failure(502);
  return raw.flatMap((r) => {
    const p = schema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

const toPoint = (r: z.infer<typeof historyRow>): FxPoint | null => {
  const m = market.safeParse(r.casa);
  return m.success
    ? { market: m.data, date: r.fecha, buy: r.compra ?? null, sell: r.venta ?? null }
    : null;
};

export class DolarApi {
  readonly id = "dolarapi" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async current(signal?: AbortSignal): Promise<FxQuote[]> {
    const list = rows(await getJson(`${DOLAR_API}/dolares`, this.fetcher, signal), currentRow);
    const quotes = list.flatMap((r): FxQuote[] => {
      const m = market.safeParse(r.casa);
      if (!m.success) return [];
      const asOf =
        r.fechaActualizacion && !Number.isNaN(Date.parse(r.fechaActualizacion))
          ? new Date(r.fechaActualizacion).toISOString()
          : null;
      return [{ market: m.data, buy: r.compra ?? null, sell: r.venta ?? null, asOf }];
    });
    if (!quotes.length) throw failure(502);
    return quotes;
  }
}

export class ArgentinaDatos {
  readonly id = "argentinadatos" as const;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private get = (path: string, signal?: AbortSignal) =>
    getJson(`${ARGENTINA_DATOS}${path}`, this.fetcher, signal);

  /** One market on one day ("YYYY-MM-DD"); null when the source has nothing for it. */
  async rateOn(m: FxMarket, date: string, signal?: AbortSignal): Promise<FxPoint | null> {
    if (!isoDate.safeParse(date).success) return null;
    const raw = await this.get(`/cotizaciones/dolares/${m}/${date.replaceAll("-", "/")}`, signal);
    const p = raw === null ? null : historyRow.safeParse(raw);
    return p?.success ? toPoint(p.data) : null;
  }

  async rateHistory(m: FxMarket, signal?: AbortSignal): Promise<FxPoint[]> {
    const raw = await this.get(`/cotizaciones/dolares/${m}`, signal);
    const points = rows(raw ?? [], historyRow).flatMap((r) => toPoint(r) ?? []);
    return [...new Map(points.map((p) => [p.date, p])).values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  async inflation(kind: "monthly" | "yearly", signal?: AbortSignal): Promise<MonthlyFigure[]> {
    const path = kind === "monthly" ? "inflacion" : "inflacionInteranual";
    const list = rows(await this.get(`/finanzas/indices/${path}`, signal), figureRow);
    const byMonth = new Map(list.map((r) => [monthOf(r.fecha), r.valor]));
    return [...byMonth.entries()]
      .map(([month, value]) => ({ month, value }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  /** A year's calendar; null when it isn't published (the source answers 404). */
  async holidays(year: number, bank: boolean, signal?: AbortSignal): Promise<Holiday[] | null> {
    if (!Number.isInteger(year) || year < 2016 || year > 2100) return null;
    const raw = await this.get(`/${bank ? "feriados-bancarios" : "feriados"}/${year}`, signal);
    if (raw === null) return null;
    return rows(raw, holidayRow)
      .filter((r) => r.fecha.startsWith(`${year}-`))
      .map((r) => ({
        date: r.fecha,
        name: r.nombre,
        kind: bank
          ? ("bancario" as const)
          : r.tipo === "puente" || r.tipo === "trasladable"
            ? r.tipo
            : ("inamovible" as const),
      }));
  }

  async depositRates(signal?: AbortSignal): Promise<DepositRate[]> {
    return rows(await this.get("/finanzas/tasas/plazoFijo", signal), depositRow).map((r) => ({
      entity: r.entidad,
      tnaClients: r.tnaClientes && r.tnaClientes > 0 ? r.tnaClientes : null,
      tnaNonClients: r.tnaNoClientes && r.tnaNoClientes > 0 ? r.tnaNoClientes : null,
    }));
  }

  async countryRisk(signal?: AbortSignal): Promise<{ date: string; value: number }> {
    const p = figureRow.safeParse(await this.get("/finanzas/indices/riesgo-pais/ultimo", signal));
    if (!p.success) throw failure(502);
    return { date: p.data.fecha, value: p.data.valor };
  }

  async uva(signal?: AbortSignal): Promise<{ date: string; value: number }[]> {
    return rows(await this.get("/finanzas/indices/uva", signal), figureRow)
      .map((r) => ({ date: r.fecha, value: r.valor }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
