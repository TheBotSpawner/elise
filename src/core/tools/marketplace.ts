import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { toAppError } from "../errors";
import {
  buyingCountry,
  conditionOf,
  dedupeOffers,
  isMarketplaceCountry,
  LISTING_ID,
  listingKey,
  MARKETPLACE_SITES,
  marketplaceSearchUrl,
  matchOffer,
  parseAmount,
  rankOffers,
  safeMarketplaceUrl,
  searchWords,
  type MarketplaceMode,
  type Offer,
} from "../shopping/marketplace";
import type { ShoppingCapability } from "../shopping/model";
import type { WebCapability } from "../web/model";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Buying products (ADR-112): Mercado Libre first where it operates — its official API when ELISE
 * has an approved application, otherwise listings a web search found (title and link, never a
 * price ELISE didn't verify) and its own search as a labeled link. Other stores come from
 * web.discover, shown apart (Mercado Libre's terms: never mixed into one ranking). Groceries are
 * SEPA's (shopping.findProduct / shopping.compare).
 */

type Payload = SurfacePayloads["product_offers"];

const shop = (env: ToolRunEnv): ShoppingCapability => env.providers.get("shopping", env.binding);
const web = (env: ToolRunEnv): WebCapability => env.providers.get("web_search", env.binding);

const offersInput = z
  .object({
    request: z.string().trim().min(3).max(300).describe("What the user wants, in their words."),
    query: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .describe(
        'The product to search ("Broadlink RM4 Mini", "aire acondicionado inverter 3000 frigorías").',
      ),
    model: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe(
        'The exact model when they named one ("RM4 Mini", "Galaxy A55 256GB"): other models are flagged, never equated.',
      ),
    maxPrice: z
      .union([z.number().positive(), z.string().trim().max(30)])
      .optional()
      .describe('Their budget as said ("100 lucas", 150000).'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    condition: z.enum(["new", "used"]).optional(),
    marketplace: z
      .enum(["prefer", "only", "avoid"])
      .optional()
      .describe(
        '"solo Mercado Libre" → only · "no uses Mercado Libre" → avoid · omit = their saved choice (default prefer).',
      ),
    compareStores: z
      .boolean()
      .optional()
      .describe(
        '"¿conviene en Mercado Libre o en otra tienda?", "compará también tiendas": other stores too.',
      ),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe("ISO country they buy in, only if they said it now."),
    url: z
      .string()
      .trim()
      .max(600)
      .optional()
      .describe(
        'A Mercado Libre listing link the user gave ("¿cuánto sale esto? https://…mercadolibre…"): that exact listing is checked.',
      ),
  })
  .strict();

export const offersTool: ToolDefinition = {
  name: "shopping.offers",
  capability: "shopping",
  operation: "offers",
  description:
    '"Buscame un Broadlink RM4 Mini al mejor precio", "¿cuánto está un aire inverter de 3000 frigorías?", "tres auriculares inalámbricos por menos de 100 lucas", "¿conviene en Mercado Libre o en otra tienda?": products to buy (electronics, appliances, home…) — Mercado Libre first where the user buys, other stores apart. Not groceries (shopping.findProduct), not services, travel or real estate.',
  input: offersInput,
  async describe(raw) {
    return { summary: `Offers: ${offersInput.parse(raw).query}` };
  },
  async run(raw, env) {
    const q = offersInput.parse(raw);
    const s = shop(env);
    const mode: MarketplaceMode = q.marketplace ?? (await s.marketplaceMode()) ?? "prefer";
    const country = buyingCountry({
      said: q.country ?? null,
      savedRegion: await s.region(),
      timezone: env.ctx.timezone,
    });
    const site = isMarketplaceCountry(country) ? MARKETPLACE_SITES[country] : null;
    const maxPrice = q.maxPrice !== undefined ? parseAmount(q.maxPrice) : null;
    // A budget in pesos only for someone buying in Argentina; never converted with an unknown rate.
    const currency = q.currency ?? (maxPrice !== null && site ? site.currency : null);
    const notes: string[] = [];
    const now = env.ctx.now.toISOString();
    let method: Payload["marketplace"]["method"] = "link";
    let offers: Offer[] = [];
    let refused: { status: number | null; endpoint: string | null } | null = null;

    if (site && mode !== "avoid") {
      const pasted = q.url ? safeMarketplaceUrl(q.url, site) : null;
      const pastedKey = pasted ? listingKey(pasted) : null;
      // 1) The official catalog: listings of the matching products with their official price.
      if (s.marketplace) {
        try {
          if (pasted && pastedKey) {
            // The listing they gave: exactly that one, nothing searched instead.
            const official = await s.marketplace.listings(site, [pastedKey]);
            offers = [official.get(pastedKey) ?? listingStub(pasted, pastedTitle(pastedKey), now)];
          } else offers = await s.marketplace.search(site, searchWords(q.query), 8);
          if (offers.some((o) => o.evidence === "api")) method = "api";
        } catch (e) {
          // 401/403/429 or down: what can be shown honestly stays, nothing is invented.
          const d = toAppError(e).details as
            { providerStatus?: number; endpoint?: string } | undefined;
          refused = { status: d?.providerStatus ?? null, endpoint: d?.endpoint ?? null };
          if (pasted && pastedKey) offers = [listingStub(pasted, pastedTitle(pastedKey), now)];
        }
      } else if (pasted && pastedKey) offers = [listingStub(pasted, pastedTitle(pastedKey), now)];
      // 2) Without official results: listings a web search found (links only, never read).
      if (!offers.length) {
        const found = await web(env)
          .search({
            query: `${searchWords(q.query)}${q.condition === "used" ? " usado" : ""}`,
            kind: "web",
            recency: null,
            limit: 8,
            language: "es",
            domains: [site.host],
          })
          .catch(() => []);
        offers = found.flatMap((r): Offer[] => {
          const url = safeMarketplaceUrl(r.url, site);
          // A results page is a search, not a listing: only item pages become offers.
          if (!url || !LISTING_ID.test(url) || new URL(url).hostname.startsWith("listado."))
            return [];
          return [
            {
              ...listingStub(url, r.title.replace(/\s*\|\s*Mercado ?Libre.*$/i, ""), now),
              condition: conditionOf(r.title),
            },
          ];
        });
      }
      if (method !== "api") method = offers.length ? "search" : "link";
      offers = rankOffers(
        dedupeOffers(offers.map((o) => ({ ...o, match: matchOffer(q.model ?? null, o.title) }))),
        { condition: q.condition ?? null, maxPrice, currency },
      ).slice(0, 8);
      if (refused)
        notes.push(
          refused.status === 401 || refused.status === 403
            ? "Mercado Libre no autorizó a ELISE a consultar estas publicaciones: muestro los enlaces, sin precio."
            : "La API de Mercado Libre no respondió: muestro los enlaces, sin precio.",
        );
    }

    // Other stores: when asked, when Mercado Libre is avoided or unavailable here, or when it
    // gave no verified price — always as their own Surface (web.discover), never merged.
    const wantStores =
      mode !== "only" &&
      (q.compareStores || mode === "avoid" || !site || !offers.some((o) => o.price !== null));
    let stores: { title: string; price?: string; url: string }[] = [];
    if (wantStores && env.invoke) {
      const r = await env
        .invoke("web.discover", {
          request: q.request,
          query: searchWords(q.query),
          count: 5,
          exclude: Object.values(MARKETPLACE_SITES).map((x) => x.host),
          ...(maxPrice !== null && currency ? { maxPrice, currency } : {}),
          ...(q.model ? { mustMatch: [q.model] } : {}),
        })
        .catch(() => null);
      if (r?.status === "succeeded")
        stores = (((r.output as { items?: unknown[] })?.items ?? []) as typeof stores).slice(0, 5);
    }

    const sitePayload = site ?? MARKETPLACE_SITES.AR;
    const payload: Payload | null =
      site && mode !== "avoid"
        ? {
            query: q.request.slice(0, 300),
            marketplace: {
              name: "Mercado Libre",
              site: site.site,
              method,
              searchUrl: marketplaceSearchUrl(
                q.query,
                sitePayload,
                currency === site.currency ? maxPrice : null,
              ),
              offers: offers.map((o) => ({
                title: o.title,
                url: o.url,
                price: o.price,
                currency: o.currency,
                condition: o.condition,
                match: o.match,
                freeShipping: o.freeShipping,
                installments: o.installments,
                seller: o.seller,
                image: o.image,
                evidence: o.evidence,
                checkedAt: o.checkedAt,
              })),
            },
            maxPrice,
            currency,
            notes,
            model: q.model ?? null,
          }
        : null;

    const verified = offers.filter((o) => o.price !== null);
    return {
      output: {
        buyingIn: country ?? "unknown",
        marketplace:
          mode === "avoid"
            ? "not used (user's choice)"
            : !site
              ? "not available where the user buys"
              : {
                  method:
                    method === "api"
                      ? "official API (prices verified now)"
                      : method === "search"
                        ? "listings found by web search — titles and links only, prices NOT verified"
                        : "no listings found — only a search link",
                  offers: offers.map((o, i) => ({
                    n: i + 1,
                    title: o.title,
                    ...(o.price !== null
                      ? {
                          price: `${o.currency} ${o.price}`,
                          priceFrom: `Mercado Libre's official API, checked at ${o.checkedAt}`,
                        }
                      : { price: "not available" }),
                    ...(o.condition ? { condition: o.condition } : {}),
                    match: o.match,
                    ...(o.freeShipping !== null ? { freeShipping: o.freeShipping } : {}),
                  })),
                  searchLink: "on screen (a search, not a listing)",
                },
        ...(refused
          ? {
              officialApi: `refused (HTTP ${refused.status ?? "?"} on ${refused.endpoint ?? "?"}) — no Mercado Libre prices this time`,
            }
          : {}),
        ...(stores.length ? { otherStores: stores } : {}),
        ...(maxPrice !== null ? { maxPrice: `${currency ?? ""} ${maxPrice}`.trim() } : {}),
        instructions: [
          "Say the source of each figure (Mercado Libre or the store). Never present Mercado Libre and other stores as one ranking: give each apart.",
          verified.length
            ? `Name two or three Mercado Libre options with price and the main difference (condition, exact model, shipping only as stated) — "de los resultados que encontré", never "el más barato de Mercado Libre".`
            : site && mode !== "avoid"
              ? `There are NO verified prices for these Mercado Libre listings: say so in one short sentence${refused ? " (Mercado Libre didn't authorize ELISE to read them)" : ""} and that the listings are on screen. Never quote a Mercado Libre price.`
              : "",
          "A related or accessory item is not the model asked for: say so if you mention it. Shipping, taxes, installments and promotions only as stated; never assume free shipping or a bank promo applies to them.",
          "Voice: the actionable data in two or three short sentences (options, price, difference), never URLs, never only 'te lo dejé en pantalla'.",
          country === null
            ? "Their country isn't known: if it matters (shipping, currency), ask where they buy — don't assume Argentina."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      },
      ...(payload
        ? {
            display: {
              kind: "product_offers" as const,
              offers: payload,
              title: q.query,
              key: `product_offers:${searchWords(q.query)}`,
            },
          }
        : {}),
    };
  },
};

/** A pasted listing ELISE couldn't read: named by its id, never by a guessed title. */
const pastedTitle = (key: string) => `Publicación ${key.split(":")[1]}`;

/** A listing known only by its link (title from where it was found): no price, not verified. */
const listingStub = (url: string, title: string, now: string): Offer => ({
  source: "mercadolibre",
  externalId: null,
  title: title.slice(0, 200),
  url,
  price: null,
  currency: null,
  condition: null,
  match: "related",
  freeShipping: null,
  installments: null,
  seller: null,
  image: null,
  evidence: "search_result",
  checkedAt: now,
});

const prefInput = z
  .object({
    marketplace: z
      .enum(["prefer", "only", "avoid", "default"])
      .describe(
        '"usá siempre solo Mercado Libre" → only · "no uses más Mercado Libre" → avoid · "volvé a lo normal" → default.',
      ),
  })
  .strict();

export const marketplacePreferenceTool: ToolDefinition = {
  name: "shopping.marketplacePreference",
  capability: "shopping",
  operation: "marketplacePreference",
  description:
    'Save for next time whether ELISE uses Mercado Libre when looking for products to buy. Only when the user says it\'s a lasting preference — a one-time "solo Mercado Libre" goes in shopping.offers.',
  input: prefInput,
  async describe(raw) {
    return { summary: `Marketplace: ${prefInput.parse(raw).marketplace}` };
  },
  async run(raw, env) {
    const q = prefInput.parse(raw);
    await shop(env).saveMarketplaceMode(q.marketplace === "default" ? null : q.marketplace);
    return {
      output: { saved: true, marketplace: q.marketplace, instructions: "Confirm in a few words." },
    };
  },
};

export const MARKETPLACE_TOOLS = [offersTool, marketplacePreferenceTool] as const;
