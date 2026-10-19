import "server-only";

import {
  ECONOMY_LIMITS,
  type EconomyCapability,
  type Source,
  type Sourced,
} from "@/core/economy/model";
import { toAppError } from "@/core/errors";
import { ArgentinaDatos, DolarApi, ECONOMY_SITES } from "@/infrastructure/economy/argentina";
import { logger } from "@/infrastructure/observability/logger";

/**
 * The Economy capability (ADR-094): public series behind one cache shared by every workspace
 * (it's public data — a hit is never a tenant's private data), de-duplicated in-flight reads,
 * per-series freshness and telemetry. When a provider fails, the last good copy is served marked
 * stale, with the time it was read; nothing is invented to fill a gap.
 */

// ponytail: per-instance cache; a shared store (Postgres/Redis) when instance count makes the
// ~3-hour reads per series add up.
const cache = new Map<string, { at: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

type ProviderId = Source["provider"];

const NAMES: Record<ProviderId, string> = {
  dolarapi: "DolarApi",
  argentinadatos: "ArgentinaDatos",
};

export function economyCapability(
  dolarApi = new DolarApi(),
  argentinaDatos = new ArgentinaDatos(),
): EconomyCapability {
  async function read<T>(
    provider: ProviderId,
    dataset: string,
    ttl: number,
    original: string | null,
    run: () => Promise<T>,
  ): Promise<Sourced<T>> {
    const key = `${provider}:${dataset}`;
    const source = (at: number, stale: boolean): Source => ({
      provider,
      name: NAMES[provider],
      original,
      url: ECONOMY_SITES[provider],
      fetchedAt: new Date(at).toISOString(),
      stale,
    });
    const hit = cache.get(key);
    const log = { provider, dataset };
    if (hit && Date.now() - hit.at <= ttl) {
      logger.info("economy_data_request", {
        ...log,
        cache: "hit",
        status: "success",
        latency_ms: 0,
      });
      return { value: hit.value as T, source: source(hit.at, false) };
    }
    // The same series asked twice at once is one provider call.
    let pending = inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      const started = Date.now();
      pending = run()
        .then((value) => {
          if (cache.size > 500) cache.delete(cache.keys().next().value!);
          cache.set(key, { at: Date.now(), value });
          logger.info("economy_data_request", {
            ...log,
            cache: "miss",
            status: "success",
            latency_ms: Date.now() - started,
          });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      const value = await pending;
      return { value, source: source(cache.get(key)?.at ?? Date.now(), false) };
    } catch (error) {
      const e = toAppError(error);
      logger.warn("economy_data_request", {
        ...log,
        cache: hit ? "stale" : "miss",
        status: e.code,
        provider_status: e.details?.providerStatus,
        age_ms: hit ? Date.now() - hit.at : null,
      });
      // The last good copy, said as such (its age decides whether it can be called current).
      if (hit) return { value: hit.value as T, source: source(hit.at, true) };
      throw e;
    }
  }

  const L = ECONOMY_LIMITS;
  return {
    currentRates: () => read("dolarapi", "dolares", L.currentMs, null, () => dolarApi.current()),
    rateOn: (market, date) =>
      read("argentinadatos", `dolar:${market}:${date}`, L.pastDayMs, null, () =>
        argentinaDatos.rateOn(market, date),
      ),
    rateHistory: (market) =>
      read("argentinadatos", `dolar:${market}`, L.seriesMs, null, () =>
        argentinaDatos.rateHistory(market),
      ),
    inflation: (kind) =>
      read("argentinadatos", `inflacion:${kind}`, L.seriesMs, "INDEC", () =>
        argentinaDatos.inflation(kind),
      ),
    async holidays(year, bank) {
      const r = await read(
        "argentinadatos",
        `feriados:${bank ? "bancarios:" : ""}${year}`,
        L.holidaysMs,
        null,
        () => argentinaDatos.holidays(year, bank),
      );
      return r.value ? { value: r.value, source: r.source } : null;
    },
    depositRates: () =>
      read("argentinadatos", "plazoFijo", L.seriesMs, "BCRA", () => argentinaDatos.depositRates()),
    countryRisk: () =>
      read("argentinadatos", "riesgoPais", L.seriesMs, null, () => argentinaDatos.countryRisk()),
    uva: () => read("argentinadatos", "uva", L.seriesMs, "BCRA", () => argentinaDatos.uva()),
  };
}
