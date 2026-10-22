import "server-only";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import {
  conditionOf,
  safeMarketplaceUrl,
  type MarketplaceApi,
  type MarketplaceSite,
  type Offer,
} from "@/core/shopping/marketplace";
import { decrypt, encrypt } from "@/infrastructure/crypto/encryption";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";

/**
 * Mercado Libre's official API (ADR-112), only documented endpoints, behind
 * MERCADOLIBRE_API_ENABLED (off). Verified live on 2026-10-22: without a token every endpoint,
 * even /sites/MLA, answers 403 PolicyAgent; general keyword search of listings (/sites/MLA/search?q=)
 * isn't documented — only by seller or category — so this uses the catalog search
 * (/products/search?q=, documented for sellers) and /items/bulk (which replaces /items?ids=
 * before 2026-10-25). Whether a shopping assistant may use them must be confirmed with Mercado
 * Libre before enabling.
 *
 * Tokens: ELISE's own application account (OAuth authorization_code once, then refresh_token,
 * which Mercado Libre rotates on every use — the latest is kept encrypted in app_credentials).
 * Never a user's account, never sent to a client or the model.
 */

const API = "https://api.mercadolibre.com";
const PROVIDER = "mercadolibre";
const TIMEOUT_MS = 6_000;

/** After 401/403 the API is off for this long (no hammering a refusal); 429 backs off less. */
let openUntil = 0;
let token: { value: string; until: number } | null = null;

const tokenResponse = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().min(10),
  expires_in: z.number().int().positive(),
});

async function storedRefresh(): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("app_credentials")
    .select("secret_encrypted")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (data) return decrypt(data.secret_encrypted, `app_credentials:${PROVIDER}`);
  return serverEnv().MERCADOLIBRE_REFRESH_TOKEN ?? null;
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const env = serverEnv();
  const refresh = await storedRefresh();
  if (!env.MERCADOLIBRE_CLIENT_ID || !env.MERCADOLIBRE_CLIENT_SECRET || !refresh)
    throw new AppError("SERVER_NOT_CONFIGURED", "Mercado Libre isn't configured");
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.MERCADOLIBRE_CLIENT_ID,
      client_secret: env.MERCADOLIBRE_CLIENT_SECRET,
      refresh_token: refresh,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw failure(r.status);
  const t = tokenResponse.parse(await r.json());
  // The refresh token rotates: the new one replaces the old for every instance.
  await createAdminClient()
    .from("app_credentials")
    .upsert(
      {
        provider: PROVIDER,
        secret_encrypted: encrypt(t.refresh_token, `app_credentials:${PROVIDER}`),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider" },
    );
  token = { value: t.access_token, until: Date.now() + (t.expires_in - 300) * 1000 };
  return token.value;
}

function failure(status: number): AppError {
  if (status === 401 || status === 403) openUntil = Date.now() + 10 * 60_000;
  if (status === 429) openUntil = Date.now() + 60_000;
  return new AppError(
    status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
    status === 401 || status === 403
      ? "Mercado Libre refused ELISE's access"
      : "Mercado Libre isn't responding",
    { recovery: "retry", details: { providerStatus: status } },
  );
}

async function get(path: string): Promise<unknown> {
  if (Date.now() < openUntil) throw new AppError("PROVIDER_UNAVAILABLE", "Mercado Libre is paused");
  const started = Date.now();
  const r = await fetch(`${API}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  logger.info("marketplace_request", {
    provider: PROVIDER,
    path: path.split("?")[0]!.replace(/\/[A-Z]{3}\d+/g, "/:id"),
    status: r.status,
    latency_ms: Date.now() - started,
  });
  if (!r.ok) throw failure(r.status);
  return r.json();
}

const catalogSearch = z.object({
  results: z
    .array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          status: z.string().optional(),
          permalink: z.string().nullable().optional(),
          pictures: z.array(z.object({ url: z.string() }).passthrough()).optional(),
        })
        .passthrough(),
    )
    .max(100),
});

const product = z
  .object({
    id: z.string(),
    name: z.string(),
    permalink: z.string().nullable().optional(),
    pictures: z.array(z.object({ url: z.string() }).passthrough()).optional(),
    buy_box_winner: z
      .object({
        item_id: z.string(),
        price: z.number().positive(),
        currency_id: z.string().regex(/^[A-Z]{3}$/),
        condition: z.string().optional(),
        shipping: z.object({ free_shipping: z.boolean().optional() }).passthrough().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/** Official images only (Mercado Libre's own static host). */
const picture = (url: string | undefined) =>
  url && /^https:\/\/http2\.mlstatic\.com\//.test(url) ? url : null;

export function mercadoLibreApi(): MarketplaceApi | null {
  if (serverEnv().MERCADOLIBRE_API_ENABLED !== "true") return null;
  return {
    async search(site: MarketplaceSite, query: string, limit: number): Promise<Offer[]> {
      const q = new URLSearchParams({
        status: "active",
        site_id: site.site,
        q: query.slice(0, 120),
      });
      const found = catalogSearch.parse(await get(`/products/search?${q}`)).results.slice(0, limit);
      const checkedAt = new Date().toISOString();
      const offers: Offer[] = [];
      for (const r of found) {
        const p = product.safeParse(
          await get(`/products/${encodeURIComponent(r.id)}`).catch(() => null),
        );
        if (!p.success) continue;
        const best = p.data.buy_box_winner ?? null;
        const url = safeMarketplaceUrl(p.data.permalink ?? r.permalink ?? "", site);
        if (!url) continue;
        offers.push({
          source: "mercadolibre",
          externalId: best?.item_id ?? p.data.id,
          title: p.data.name.slice(0, 200),
          url,
          price: best?.price ?? null,
          currency: best?.currency_id ?? null,
          condition:
            best?.condition === "new"
              ? "new"
              : best?.condition === "used"
                ? "used"
                : conditionOf(p.data.name),
          match: "related",
          freeShipping: best?.shipping?.free_shipping ?? null,
          installments: null,
          seller: null,
          image: picture(p.data.pictures?.[0]?.url),
          evidence: "api",
          checkedAt,
        });
      }
      return offers;
    },
  };
}
