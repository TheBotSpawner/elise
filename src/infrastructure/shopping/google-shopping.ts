import "server-only";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import type { MarketplaceSite } from "@/core/shopping/marketplace";
import type { PriceIndex } from "@/core/shopping/price-reference";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Google Shopping results through SerpApi (ADR-116): an authorized API, never Mercado Libre's or
 * Google's pages. Server-only key. Off unless SHOPPING_GOOGLE_SHOPPING_ENABLED=true and a key is
 * set. Each query is cached for 30 minutes; 401/403 pause it for 10 minutes and 429 for one;
 * a monthly budget caps the calls.
 *
 * ponytail: cache, pause and budget are per server instance (memory). SerpApi enforces the
 * plan's own cap too; move the counter to the database if instances multiply.
 */

const ENDPOINT = "https://serpapi.com/search.json";
const TIMEOUT_MS = 6_000;
const CACHE_MS = 30 * 60_000;

const LOCATION: Record<string, { gl: string; location?: string }> = {
  MLA: { gl: "ar", location: "Buenos Aires,Argentina" },
  MLM: { gl: "mx" },
  MLB: { gl: "br" },
};

const responseSchema = z
  .object({
    shopping_results: z.array(z.unknown()).optional(),
    error: z.string().optional(),
  })
  .passthrough();

const cache = new Map<string, { at: number; results: unknown[] }>();
let pausedUntil = 0;
let month = "";
let used = 0;

export function googleShopping(): PriceIndex | null {
  const env = serverEnv();
  if (env.SHOPPING_GOOGLE_SHOPPING_ENABLED !== "true" || !env.SERPAPI_API_KEY) return null;
  const key = env.SERPAPI_API_KEY;
  const limit = env.SHOPPING_GOOGLE_SHOPPING_MONTHLY_LIMIT;
  return {
    images: env.SHOPPING_GOOGLE_SHOPPING_IMAGES === "true",
    async search(query: string, site: MarketplaceSite) {
      const place = LOCATION[site.site];
      if (!place) return [];
      const cacheKey = `${site.site}|${query.toLowerCase()}`;
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
      if (Date.now() < pausedUntil)
        throw new AppError("PROVIDER_UNAVAILABLE", "Google Shopping is paused for a moment");
      const thisMonth = new Date().toISOString().slice(0, 7);
      if (thisMonth !== month) [month, used] = [thisMonth, 0];
      if (used >= limit)
        throw new AppError("RATE_LIMITED", "Google Shopping's monthly budget is used up");
      used++;
      const params = new URLSearchParams({
        engine: "google_shopping",
        q: query.slice(0, 120),
        gl: place.gl,
        hl: "es",
        ...(place.location ? { location: place.location } : {}),
        api_key: key,
      });
      const started = Date.now();
      const res = await fetch(`${ENDPOINT}?${params}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new AppError("PROVIDER_UNAVAILABLE", "Google Shopping didn't respond", {
          cause: error,
        });
      });
      if (res.status === 401 || res.status === 403) {
        pausedUntil = Date.now() + 10 * 60_000;
        throw new AppError("PROVIDER_UNAVAILABLE", "Google Shopping refused the key");
      }
      if (res.status === 429) {
        pausedUntil = Date.now() + 60_000;
        throw new AppError("RATE_LIMITED", "Google Shopping is rate limited");
      }
      if (!res.ok) throw new AppError("PROVIDER_UNAVAILABLE", "Google Shopping failed");
      const body = responseSchema.safeParse(await res.json().catch(() => null));
      if (!body.success || body.data.error)
        throw new AppError("PROVIDER_UNAVAILABLE", "Google Shopping returned no results");
      const results = body.data.shopping_results ?? [];
      cache.set(cacheKey, { at: Date.now(), results });
      // Counts and timing only: never the query's results or the key.
      logger.info("shopping.google_shopping", {
        results: results.length,
        latency_ms: Date.now() - started,
        used_this_month: used,
      });
      return results;
    },
  };
}
