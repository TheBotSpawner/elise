import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { toAppError } from "../errors";
import {
  buyingCountry,
  conditionOf,
  dedupeOffers,
  isMarketplaceCountry,
  LISTING_ID,
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
import {
  attachPrices,
  parseShoppingResults,
  rankReferences,
  type PriceReference,
} from "../shopping/price-reference";
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
    let degraded: string | null = null;
    let refs: PriceReference[] = [];
    let marketplaceRefs: PriceReference[] = [];
    let otherRefs: PriceReference[] = [];

    if (site && mode !== "avoid") {
      if (s.marketplace) {
        try {
          offers = await s.marketplace.search(site, searchWords(q.query), 8);
          method = "api";
        } catch (e) {
          // 401/403/429 or down: degrade to what can be shown honestly, never invent.
          degraded = toAppError(e).message;
        }
      }
      if (method !== "api") {
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
              source: "mercadolibre",
              externalId: null,
              title: r.title.replace(/\s*\|\s*Mercado ?Libre.*$/i, "").slice(0, 200),
              url,
              price: null,
              currency: null,
              condition: conditionOf(r.title),
              match: "related",
              freeShipping: null,
              installments: null,
              seller: null,
              image: null,
              evidence: "search_result",
              checkedAt: now,
            },
          ];
        });
        method = offers.length ? "search" : "link";
      }
      offers = dedupeOffers(
        offers.map((o) => ({ ...o, match: matchOffer(q.model ?? null, o.title) })),
      );
      // ADR-116: Google Shopping prices — on a listing only when they link to that listing.
      if (s.priceIndex) {
        try {
          refs = parseShoppingResults(await s.priceIndex.search(searchWords(q.query), site), {
            model: q.model ?? null,
            site,
            now: env.ctx.now,
            images: s.priceIndex.images,
          }).filter(
            (r) =>
              !(maxPrice && currency === r.currency && r.price > maxPrice) &&
              !(q.condition && r.condition && r.condition !== q.condition),
          );
          const a = attachPrices(offers, refs);
          offers = a.offers;
          marketplaceRefs = rankReferences(a.marketplaceRefs).slice(0, 3);
          otherRefs = mode === "only" ? [] : rankReferences(a.otherRefs).slice(0, 5);
        } catch {
          notes.push("Google Shopping no respondió: no hay precios de referencia esta vez.");
        }
      }
      offers = rankOffers(offers, { condition: q.condition ?? null, maxPrice, currency }).slice(
        0,
        5,
      );
      if (degraded)
        notes.push(
          "La API de Mercado Libre no respondió: muestro publicaciones encontradas por búsqueda, sin precios.",
        );
    }

    // Other stores: when asked, when Mercado Libre is avoided or unavailable here, or when it
    // gave no verified price — always as their own Surface (web.discover), never merged.
    const wantStores =
      mode !== "only" &&
      !otherRefs.length &&
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
                ...(o.priceSource ? { priceSource: o.priceSource } : {}),
                checkedAt: o.checkedAt,
              })),
            },
            maxPrice,
            currency,
            notes,
            model: q.model ?? null,
            ...(marketplaceRefs.length || otherRefs.length
              ? {
                  references: {
                    marketplace: marketplaceRefs.map(refView),
                    others: otherRefs.map(refView),
                  },
                }
              : {}),
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
                          priceFrom:
                            o.priceSource === "google_shopping"
                              ? `Google Shopping, linking this listing, at ${o.checkedAt}`
                              : "Mercado Libre's official API",
                        }
                      : {}),
                    ...(o.condition ? { condition: o.condition } : {}),
                    match: o.match,
                    ...(o.freeShipping !== null ? { freeShipping: o.freeShipping } : {}),
                  })),
                  searchLink: "on screen (a search, not a listing)",
                },
        ...(marketplaceRefs.length
          ? {
              mercadoLibreReferencePrices: marketplaceRefs.map((r) => ({
                title: r.title,
                price: `${r.currency} ${r.price}`,
                match: r.match,
                note: "Google Shopping says the store is Mercado Libre, but it doesn't link a listing above: a reference price, not one listing's",
              })),
            }
          : {}),
        ...(otherRefs.length
          ? {
              otherStorePrices: otherRefs.map((r) => ({
                store: r.merchant,
                title: r.title,
                price: `${r.currency} ${r.price}`,
                match: r.match,
              })),
              otherStorePricesFrom: `Google Shopping, consulted at ${otherRefs[0]!.checkedAt}`,
            }
          : {}),
        ...(stores.length ? { otherStores: stores } : {}),
        ...(maxPrice !== null ? { maxPrice: `${currency ?? ""} ${maxPrice}`.trim() } : {}),
        instructions: [
          "Say the source of each figure (Mercado Libre or the store). Never present Mercado Libre and other stores as one ranking: give each apart.",
          refs.length
            ? 'Google Shopping prices are what the index showed when consulted, not live: say "según Google Shopping" and that they may have changed. A price belongs to a Mercado Libre listing only where priceFrom says so; mercadoLibreReferencePrices and otherStorePrices are references — never say a listing costs that.'
            : "",
          verified.length
            ? `Name two or three Mercado Libre options with price and the main difference (condition, exact model, shipping only as stated) — "de los resultados que encontré", never "el más barato de Mercado Libre".`
            : site && mode !== "avoid"
              ? `There are NO verified prices for these Mercado Libre listings: say so in one short sentence and that the listings are on screen.${otherRefs.length || marketplaceRefs.length ? " Then give two or three reference prices (exact model first) saying where each is from." : " Never quote a Mercado Libre price."}`
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

const refView = (r: PriceReference) => ({
  title: r.title,
  merchant: r.merchant,
  price: r.price,
  currency: r.currency,
  url: r.url && /^https:\/\//.test(r.url) ? r.url : null,
  image: r.image,
  match: r.match,
  condition: r.condition,
  checkedAt: r.checkedAt,
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
