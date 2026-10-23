import "server-only";

import { createHash, randomBytes } from "node:crypto";

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
 * Mercado Libre's official API (ADR-112, ADR-116), only documented endpoints, behind
 * MERCADOLIBRE_API_ENABLED. Without a token every endpoint answers 403 PolicyAgent.
 *
 * - Exact listings: `/items/{id}` (title, permalink, pictures, condition) and
 *   `/items/{id}/sale_price?context=channel_marketplace` (the price a buyer pays now). A price is
 *   only ever this listing's own — nothing is matched by title.
 * - Catalog: `/products/search?q=`, `/products/{id}` (name, photos) and `/products/{id}/items`
 *   (each listing of that product with its official price). Verified live 2026-10-23 with ELISE's
 *   application: catalog endpoints answer 200; third-party `/items/{id}` and its price endpoints
 *   answer 403 access_denied (only the account's own listings are readable).
 *
 * Tokens: ELISE's own application account, authorized once with OAuth authorization_code + PKCE
 * (scripts/mercadolibre-connect.ts). Mercado Libre rotates the refresh token on every use and
 * only the latest is valid: it is kept encrypted in app_credentials (every instance reads the
 * same one), refreshed by one request at a time per instance, and re-read on invalid_grant (another
 * instance rotated it). Never a buyer's account, never sent to a client or the model.
 */

const API = "https://api.mercadolibre.com";
const AUTH = "https://auth.mercadolibre.com.ar/authorization";
const PROVIDER = "mercadolibre";
const CONTEXT = `app_credentials:${PROVIDER}`;
const TIMEOUT_MS = 6_000;
const ITEM_CACHE_MS = 10 * 60_000;

/** After a 401 the API is off for this long (no hammering a refusal); 429 backs off less. */
let openUntil = 0;
let token: { value: string; until: number } | null = null;
let refreshing: Promise<string> | null = null;
const items = new Map<string, { at: number; offer: Offer | null }>();

const tokenResponse = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().min(10),
  expires_in: z.number().int().positive(),
  user_id: z.union([z.number(), z.string()]).optional(),
});

/** What app_credentials holds (encrypted): the latest refresh token and whose account it is. */
const stored = z.object({
  refreshToken: z.string().min(10),
  userId: z.string().nullable(),
  nickname: z.string().nullable(),
  connectedAt: z.string(),
});
type Stored = z.infer<typeof stored>;

async function readStored(): Promise<(Stored & { updatedAt: string }) | null> {
  const { data, error } = await createAdminClient()
    .from("app_credentials")
    .select("secret_encrypted, updated_at")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not read Mercado Libre's credentials", {
      cause: error,
    });
  if (!data) return null;
  const plain = decrypt(data.secret_encrypted, CONTEXT);
  // Older rows hold the bare refresh token.
  const parsed = stored.safeParse(
    (() => {
      try {
        return JSON.parse(plain);
      } catch {
        return null;
      }
    })(),
  );
  return {
    ...(parsed.success
      ? parsed.data
      : { refreshToken: plain, userId: null, nickname: null, connectedAt: data.updated_at }),
    updatedAt: data.updated_at,
  };
}

async function writeStored(s: Stored) {
  const { error } = await createAdminClient()
    .from("app_credentials")
    .upsert(
      {
        provider: PROVIDER,
        secret_encrypted: encrypt(JSON.stringify(s), CONTEXT),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider" },
    );
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not save Mercado Libre's credentials", {
      cause: error,
    });
}

function clientConfig() {
  const env = serverEnv();
  if (!env.MERCADOLIBRE_CLIENT_ID || !env.MERCADOLIBRE_CLIENT_SECRET)
    throw new AppError("SERVER_NOT_CONFIGURED", "Mercado Libre isn't configured");
  return { id: env.MERCADOLIBRE_CLIENT_ID, secret: env.MERCADOLIBRE_CLIENT_SECRET };
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await r.json().catch(() => null)) as { error?: string } | null;
  if (!r.ok) return { ok: false as const, status: r.status, error: json?.error ?? null };
  return { ok: true as const, tokens: tokenResponse.parse(json) };
}

/** One refresh at a time per instance; the rotated token replaces the old one for everyone. */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  refreshing ??= (async () => {
    const c = clientConfig();
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await readStored();
      const refresh = s?.refreshToken ?? serverEnv().MERCADOLIBRE_REFRESH_TOKEN ?? null;
      if (!refresh)
        throw new AppError(
          "SERVER_NOT_CONFIGURED",
          "Mercado Libre isn't connected (run scripts/mercadolibre-connect.ts)",
        );
      const r = await tokenRequest({
        grant_type: "refresh_token",
        client_id: c.id,
        client_secret: c.secret,
        refresh_token: refresh,
      });
      // Another instance may have just rotated it: read the latest once and try again.
      if (!r.ok && r.error === "invalid_grant" && attempt === 0) continue;
      if (!r.ok) throw failure(r.status, "/oauth/token");
      await writeStored({
        refreshToken: r.tokens.refresh_token,
        userId: s?.userId ?? (r.tokens.user_id != null ? String(r.tokens.user_id) : null),
        nickname: s?.nickname ?? null,
        connectedAt: s?.connectedAt ?? new Date().toISOString(),
      });
      token = {
        value: r.tokens.access_token,
        until: Date.now() + (r.tokens.expires_in - 300) * 1000,
      };
      return token.value;
    }
    throw failure(400, "/oauth/token");
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function failure(status: number, endpoint: string): AppError {
  // 401 is the token (everything would fail): pause. 403 is THIS resource refused (third-party
  // listings, verified live) while the catalog still answers: no global pause.
  if (status === 401) openUntil = Date.now() + 10 * 60_000;
  if (status === 429) openUntil = Date.now() + 60_000;
  return new AppError(
    status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
    status === 401 || status === 403
      ? "Mercado Libre refused ELISE's access"
      : "Mercado Libre isn't responding",
    { recovery: "retry", details: { providerStatus: status, endpoint } },
  );
}

const shape = (path: string) => path.split("?")[0]!.replace(/\/M[A-Z]{2}U?\d+/g, "/:id");

/** One documented call: its status, latency and body (never the token). */
export async function call(path: string): Promise<{ status: number; ms: number; body: unknown }> {
  const started = Date.now();
  const r = await fetch(`${API}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const ms = Date.now() - started;
  logger.info("marketplace_request", {
    provider: PROVIDER,
    path: shape(path),
    status: r.status,
    latency_ms: ms,
  });
  return { status: r.status, ms, body: await r.json().catch(() => null) };
}

async function get(path: string): Promise<unknown> {
  if (Date.now() < openUntil) throw new AppError("PROVIDER_UNAVAILABLE", "Mercado Libre is paused");
  const r = await call(path);
  if (r.status < 200 || r.status >= 300) throw failure(r.status, shape(path));
  return r.body;
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

const item = z
  .object({
    id: z.string(),
    title: z.string(),
    permalink: z.string().nullable().optional(),
    status: z.string().optional(),
    condition: z.string().optional(),
    price: z.number().nullable().optional(),
    currency_id: z.string().nullable().optional(),
    pictures: z
      .array(
        z.object({ secure_url: z.string().optional(), url: z.string().optional() }).passthrough(),
      )
      .optional(),
    shipping: z.object({ free_shipping: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const salePrice = z
  .object({
    amount: z.number().positive(),
    regular_amount: z.number().nullable().optional(),
    currency_id: z.string().regex(/^[A-Z]{3}$/),
  })
  .passthrough();

/** Official images only (Mercado Libre's own static host). */
const picture = (url: string | undefined) =>
  url && /^https:\/\/http2\.mlstatic\.com\//.test(url) ? url : null;

const condition = (c: string | undefined, title: string) =>
  c === "new" ? "new" : c === "used" ? "used" : conditionOf(title);

/**
 * One listing by its exact id: its own data, and its own current sale price when the API gives
 * it (null otherwise — never another listing's). Inactive listings have no price.
 */
async function listing(site: MarketplaceSite, key: string): Promise<Offer | null> {
  const hit = items.get(key);
  if (hit && Date.now() - hit.at < ITEM_CACHE_MS) return hit.offer;
  const [kind, id] = key.split(":") as [string, string];
  const checkedAt = new Date().toISOString();
  let offer: Offer | null = null;
  if (kind === "item") {
    const it = item.parse(await get(`/items/${encodeURIComponent(id)}`));
    const url = safeMarketplaceUrl(it.permalink ?? "", site);
    if (url) {
      const active = it.status === undefined || it.status === "active";
      const sale = active
        ? salePrice.safeParse(
            await get(
              `/items/${encodeURIComponent(id)}/sale_price?context=channel_marketplace`,
            ).catch(() => null),
          )
        : null;
      const price = sale?.success ? sale.data.amount : null;
      offer = {
        source: "mercadolibre",
        externalId: it.id,
        title: it.title.slice(0, 200),
        url,
        price,
        currency: sale?.success ? sale.data.currency_id : null,
        condition: condition(it.condition, it.title),
        match: "related",
        freeShipping: it.shipping?.free_shipping ?? null,
        installments: null,
        seller: null,
        image: picture(it.pictures?.[0]?.secure_url ?? it.pictures?.[0]?.url),
        evidence: "api",
        checkedAt,
      };
    }
  } else if (kind === "p") {
    offer = (await productOffers(site, id, 1))[0] ?? null;
  }
  items.set(key, { at: Date.now(), offer });
  return offer;
}

const productItems = z.object({
  results: z
    .array(
      z
        .object({
          item_id: z.string(),
          price: z.number().positive(),
          currency_id: z.string().regex(/^[A-Z]{3}$/),
          condition: z.string().optional(),
          original_price: z.number().nullable().optional(),
          shipping: z.object({ free_shipping: z.boolean().optional() }).passthrough().optional(),
        })
        .passthrough(),
    )
    .max(50),
});

/** A listing's public address from its id ("MLA2510970362" → articulo…/MLA-2510970362). */
const itemUrl = (site: MarketplaceSite, id: string) =>
  safeMarketplaceUrl(`https://articulo.${site.host}/${id.slice(0, 3)}-${id.slice(3)}`, site);

/**
 * A catalog product's listings with their official price (`/products/{id}/items`, verified
 * live 2026-10-23: open to this application, unlike third-party `/items/{id}` which is 403).
 * Cheapest first; each offer is ONE listing, linked to itself, with the product's photo.
 */
async function productOffers(site: MarketplaceSite, id: string, limit: number): Promise<Offer[]> {
  // Listings first: most catalog products have none (404), and then the product isn't read.
  const listed = await get(`/products/${encodeURIComponent(id)}/items?limit=5`).catch(() => null);
  const parsed = productItems.safeParse(listed);
  if (!parsed.success || !parsed.data.results.length) return [];
  const p = product.parse(await get(`/products/${encodeURIComponent(id)}`));
  const checkedAt = new Date().toISOString();
  return parsed.data.results
    .filter((r) => r.currency_id === site.currency)
    .sort((a, b) => a.price - b.price)
    .slice(0, limit)
    .flatMap((r): Offer[] => {
      const url = itemUrl(site, r.item_id);
      return url
        ? [
            {
              source: "mercadolibre",
              externalId: r.item_id,
              title: p.name.slice(0, 200),
              url,
              price: r.price,
              currency: r.currency_id,
              condition: condition(r.condition, p.name),
              match: "related",
              freeShipping: r.shipping?.free_shipping ?? null,
              installments: null,
              seller: null,
              image: picture(p.pictures?.[0]?.url),
              evidence: "api",
              checkedAt,
            },
          ]
        : [];
    });
}

export function mercadoLibreApi(): MarketplaceApi | null {
  if (serverEnv().MERCADOLIBRE_API_ENABLED !== "true") return null;
  return {
    async search(site: MarketplaceSite, query: string, limit: number): Promise<Offer[]> {
      const q = new URLSearchParams({
        status: "active",
        site_id: site.site,
        q: query.slice(0, 120),
      });
      // Every catalog product found (most have no active listing: verified live 2026-10-23,
      // 6 of 17 for "Broadlink RM4 Mini"), each with up to 3 of its cheapest listings, in
      // parallel. The caller ranks them: the exact model first, other models flagged.
      q.set("limit", "20");
      const found = catalogSearch.parse(await get(`/products/search?${q}`)).results.slice(0, 20);
      const all = await Promise.all(
        found.map((r) => productOffers(site, r.id, 3).catch(() => [] as Offer[])),
      );
      return all.flat().slice(0, Math.max(limit, 12));
    },
    async listings(site: MarketplaceSite, keys: readonly string[]) {
      const out = new Map<string, Offer>();
      for (const key of keys.slice(0, 8)) {
        const o = await listing(site, key);
        if (o) out.set(key, o);
      }
      return out;
    },
  };
}

// ── Connecting ELISE's application account (scripts/mercadolibre-connect.ts) ──────────────

/** The registered redirect URI: exactly as in Mercado Libre Developers, no variable parts. */
export function redirectUri(): string {
  const uri = serverEnv().MERCADOLIBRE_REDIRECT_URI;
  if (!uri) throw new AppError("SERVER_NOT_CONFIGURED", "MERCADOLIBRE_REDIRECT_URI is not set");
  return uri;
}

/** Consent URL with a single-use state and PKCE (S256); the verifier never leaves the server. */
export function startAuthorization() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientConfig().id,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

/**
 * The page Mercado Libre sent the browser back to: its state must be the one just issued, then
 * the code is exchanged (server-side, with the secret and the verifier) and the refresh token
 * stored encrypted. Returns whose account it is — never a token.
 */
export async function completeAuthorization(
  returnedUrl: string,
  expected: { state: string; verifier: string },
): Promise<{ userId: string | null; nickname: string | null }> {
  let u: URL;
  try {
    u = new URL(returnedUrl.trim());
  } catch {
    throw new AppError("VALIDATION_ERROR", "That isn't the address Mercado Libre returned to");
  }
  if (u.origin + u.pathname !== new URL(redirectUri()).origin + new URL(redirectUri()).pathname)
    throw new AppError("VALIDATION_ERROR", "That address isn't the registered redirect URI");
  const state = u.searchParams.get("state");
  if (!state || state !== expected.state)
    throw new AppError("PERMISSION_DENIED", "The authorization state doesn't match: start again");
  const code = u.searchParams.get("code");
  if (u.searchParams.get("error") || !code)
    throw new AppError("PERMISSION_DENIED", "Mercado Libre access was not granted");
  const c = clientConfig();
  const r = await tokenRequest({
    grant_type: "authorization_code",
    client_id: c.id,
    client_secret: c.secret,
    code,
    redirect_uri: redirectUri(),
    code_verifier: expected.verifier,
  });
  if (!r.ok)
    throw new AppError(
      "PERMISSION_DENIED",
      `Mercado Libre refused the code (${r.error ?? r.status})`,
    );
  token = { value: r.tokens.access_token, until: Date.now() + (r.tokens.expires_in - 300) * 1000 };
  const me = z
    .object({ id: z.union([z.number(), z.string()]), nickname: z.string().optional() })
    .safeParse((await call("/users/me")).body);
  const who = {
    userId: me.success
      ? String(me.data.id)
      : r.tokens.user_id != null
        ? String(r.tokens.user_id)
        : null,
    nickname: me.success ? (me.data.nickname ?? null) : null,
  };
  await writeStored({
    refreshToken: r.tokens.refresh_token,
    ...who,
    connectedAt: new Date().toISOString(),
  });
  openUntil = 0;
  return who;
}

export async function connectionStatus() {
  const s = await readStored();
  return {
    enabled: serverEnv().MERCADOLIBRE_API_ENABLED === "true",
    connected: Boolean(s),
    nickname: s?.nickname ?? null,
    userId: s?.userId ?? null,
    connectedAt: s?.connectedAt ?? null,
    lastRotatedAt: s?.updatedAt ?? null,
  };
}

/** Forgets the stored token here (revoke the app in Mercado Libre to end it there too). */
export async function disconnect() {
  const { error } = await createAdminClient()
    .from("app_credentials")
    .delete()
    .eq("provider", PROVIDER);
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not remove Mercado Libre's credentials", {
      cause: error,
    });
  token = null;
  items.clear();
}
