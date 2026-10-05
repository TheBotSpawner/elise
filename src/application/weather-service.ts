import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError, toAppError } from "@/core/errors";
import { WEATHER_LIMITS, type WeatherCapability, type WeatherProvider } from "@/core/weather/model";
import { logger } from "@/infrastructure/observability/logger";
import { OpenMeteoWeather } from "@/infrastructure/weather/open-meteo";

import type { AuthContext } from "./auth-context";

/**
 * The Weather capability for one request (ADR-038): the forecast provider behind a timeout, a
 * short cache and telemetry. Place names and coordinates are never logged.
 */

// ponytail: per-instance cache (10 min); a shared cache only if hit rates justify it.
const cache = new Map<string, { at: number; value: unknown }>();

export function weatherCapability(
  auth: AuthContext,
  provider: WeatherProvider = new OpenMeteoWeather(serverEnv().OPEN_METEO_API_KEY ?? null),
): WeatherCapability {
  async function step<T>(op: string, key: string, run: (s: AbortSignal) => Promise<T>, extra = {}) {
    // The workspace is part of the key: a cached answer never hints at another tenant's places.
    const k = `${auth.workspaceId}:${op}:${key}`;
    const hit = cache.get(k);
    const log = { workspace_id: auth.workspaceId, provider: provider.id, op, ...extra };
    if (hit && Date.now() - hit.at <= WEATHER_LIMITS.cacheMs) {
      logger.info("weather.call", { ...log, cached: true, latency_ms: 0 });
      return hit.value as T;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEATHER_LIMITS.timeoutMs);
    const started = Date.now();
    try {
      const value = await run(controller.signal);
      logger.info("weather.call", { ...log, cached: false, latency_ms: Date.now() - started });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      cache.set(k, { at: Date.now(), value });
      return value;
    } catch (error) {
      const code = controller.signal.aborted ? "TIMEOUT" : toAppError(error).code;
      logger.warn("weather.call_failed", { ...log, code, latency_ms: Date.now() - started });
      if (controller.signal.aborted)
        throw new AppError("PROVIDER_UNAVAILABLE", "The weather service took too long", {
          recovery: "retry",
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    attribution: provider.attribution,
    geocode: (name, lang) =>
      step("geocode", `${name.toLowerCase()}:${lang}`, (s) => provider.geocode(name, lang, s)),
    forecast: (at, days, source) =>
      step(
        "forecast",
        // ~1 km grid: nearby requests share a forecast.
        `${at.lat.toFixed(2)},${at.lng.toFixed(2)}:${days}`,
        (s) => provider.forecast(at, days, s),
        { location_source: source, days },
      ),
  };
}
