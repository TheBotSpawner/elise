import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError, toAppError } from "@/core/errors";
import {
  LOCATION_LIMITS,
  type LocationCapability,
  type LocationProvider,
} from "@/core/location/model";
import { GoogleMapsLocation, type MapsUsage } from "@/infrastructure/location/google-maps";
import { logger } from "@/infrastructure/observability/logger";
import { recordUsage } from "@/infrastructure/observability/usage";

import type { AuthContext } from "./auth-context";

/**
 * The Location capability for one request (ADR-023): the maps provider behind timeouts, a
 * short cache and usage metrics. Queries, addresses and coordinates are never logged.
 */

export function locationConfigured(): boolean {
  return Boolean(serverEnv().GOOGLE_MAPS_SERVER_API_KEY);
}

// ponytail: per-instance cache (short TTLs); a shared cache only if hit rates justify it.
const cache = new Map<string, { at: number; ttl: number; value: unknown }>();

export function locationCapability(
  auth: AuthContext,
  provider?: LocationProvider,
): LocationCapability {
  const log = { workspace_id: auth.workspaceId };
  const onUsage = (u: MapsUsage) =>
    recordUsage({
      operation: "maps",
      provider: `google_maps.${u.api}`,
      units: u.units,
      unit: "queries",
    });
  const maps = (): LocationProvider => {
    if (provider) return provider;
    const key = serverEnv().GOOGLE_MAPS_SERVER_API_KEY;
    if (!key)
      throw new AppError("CAPABILITY_UNAVAILABLE", "Maps isn't configured", {
        recovery: "configure",
      });
    return new GoogleMapsLocation(key, onUsage);
  };

  /** One bounded, cached, observed provider call. */
  async function step<T>(
    op: string,
    key: string,
    ttl: number,
    run: (p: LocationProvider, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // The workspace is part of the key: nothing is shared across tenants.
    const k = `${auth.workspaceId}:${op}:${key}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at <= hit.ttl) return hit.value as T;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCATION_LIMITS.timeoutMs);
    const started = Date.now();
    try {
      const value = await run(maps(), controller.signal);
      logger.info("location.call", { ...log, op, latency_ms: Date.now() - started });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      cache.set(k, { at: Date.now(), ttl, value });
      return value;
    } catch (error) {
      const code = controller.signal.aborted ? "TIMEOUT" : toAppError(error).code;
      logger.warn("location.call_failed", { ...log, op, code, latency_ms: Date.now() - started });
      if (controller.signal.aborted)
        throw new AppError("PROVIDER_UNAVAILABLE", "Maps took too long", { recovery: "retry" });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const place = LOCATION_LIMITS.cachePlaceMs;
  const route = LOCATION_LIMITS.cacheRouteMs;
  return {
    searchPlaces: (q) => step("search", JSON.stringify(q), place, (p, s) => p.searchPlaces(q, s)),
    getPlace: (id, lang) =>
      step("place", `${id}:${lang}`, place, (p, s) => p.getPlace(id, lang, s)),
    geocode: (a, lang) =>
      step("geocode", `${a.toLowerCase()}:${lang}`, place, (p, s) => p.geocode(a, lang, s)),
    reverseGeocode: (at, lang) =>
      step("reverse", `${at.lat},${at.lng}:${lang}`, place, (p, s) =>
        p.reverseGeocode(at, lang, s),
      ),
    route: (r) => step("route", JSON.stringify(r), route, (p, s) => p.route(r, s)),
    matrix: (m) => step("matrix", JSON.stringify(m), route, (p, s) => p.matrix(m, s)),
  };
}
