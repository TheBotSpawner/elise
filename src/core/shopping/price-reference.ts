import { z } from "zod";

import {
  LISTING_ID,
  matchOffer,
  safeMarketplaceUrl,
  type MarketplaceSite,
  type Offer,
  type OfferMatch,
} from "./marketplace";

/**
 * Prices from a shopping index (ADR-116): Google Shopping results through an authorized API
 * (SerpApi). Never Mercado Libre's own pages (its terms, ADR-112). A price is attached to a
 * Mercado Libre listing only when the result links to THAT listing (same id, same kind); a
 * similar title is never enough. What can't be attached is shown apart, labelled as a
 * reference — and a reference from another store never sits in Mercado Libre's block.
 */

/** One result as the shopping index returns it (only the fields ELISE reads). */
export const shoppingResultSchema = z
  .object({
    title: z.string().max(400),
    price: z.string().max(80).optional(),
    extracted_price: z.number().optional(),
    source: z.string().max(120).optional(),
    link: z.string().max(2000).optional(),
    product_link: z.string().max(2000).optional(),
    thumbnail: z.string().max(2000).optional(),
    second_hand_condition: z.string().max(40).optional(),
    installment: z
      .object({ months: z.union([z.number(), z.string()]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ShoppingResult = z.infer<typeof shoppingResultSchema>;

export interface PriceReference {
  title: string;
  merchant: string;
  /** The merchant is Mercado Libre (as the index names it). */
  marketplace: boolean;
  /** Total price, in `currency` — never an installment. */
  price: number;
  currency: string;
  /** A link to the offer itself when the index gives one (else the index's product page). */
  url: string | null;
  /** The Mercado Libre listing it links to, when it does: "item:MLA123", "p:MLA123", "up:MLAU123". */
  listingKey: string | null;
  image: string | null;
  condition: "new" | "used" | null;
  match: OfferMatch;
  checkedAt: string;
}

/**
 * A Mercado Libre listing's identity from its URL: classic item (/MLA-123…), catalog product
 * (/p/MLA123) or user product (/up/MLAU123). Different kinds are never equal: a catalog
 * product's price is not one listing's price.
 */
export function listingKey(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const product = /\/p\/(M[A-Z]{2}\d{6,})/.exec(path);
  if (product) return `p:${product[1]}`;
  const user = /\/up\/(M[A-Z]{2}U\d{6,})/.exec(path);
  if (user) return `up:${user[1]}`;
  const item = LISTING_ID.exec(path);
  return item && !item[0].includes("U") ? `item:${item[0].replace("-", "")}` : null;
}

const USD = /US\$|U\$S|USD|u\$d|dólar|dolar/i;
/** "12 x $ 4.999", "cuotas": a monthly amount, not the price. */
const INSTALLMENT = /\bcuotas?\b|\d+\s*x\s*\$|\bx\s*mes\b|\/mes\b/i;
/** A pack or a set: its price is not one unit's. */
const PACK =
  /\b(pack|kit|combo|set)\s+(x\s*)?\d|\bx\s?\d+\s*(u|un|unid|unidades)\b|\b\d+\s*unidades\b/i;
const MARKETPLACE_MERCHANT = /mercado\s*libre|mercadolibre/i;

/** Only images from the index's own image hosts (no arbitrary URLs in ELISE's page). */
const safeImage = (raw: string | undefined) =>
  raw && /^https:\/\/(encrypted-tbn\d\.gstatic\.com|[a-z0-9-]+\.googleusercontent\.com)\//.test(raw)
    ? raw
    : null;

/**
 * The index's results as prices ELISE may show: total price in the site's currency, the right
 * model, not a pack, not an installment, not zero. Anything doubtful is dropped, not guessed.
 */
export function parseShoppingResults(
  raw: unknown,
  opts: { model: string | null; site: MarketplaceSite; now: Date; images: boolean },
): PriceReference[] {
  const list = z.array(z.unknown()).safeParse(raw);
  if (!list.success) return [];
  const out: PriceReference[] = [];
  for (const item of list.data) {
    const r = shoppingResultSchema.safeParse(item);
    if (!r.success) continue;
    const x = r.data;
    const priceText = x.price ?? "";
    const price = x.extracted_price;
    if (!price || !Number.isFinite(price) || price <= 0) continue;
    if (USD.test(priceText) || INSTALLMENT.test(priceText) || x.installment) continue;
    if (PACK.test(x.title)) continue;
    const match = matchOffer(opts.model, x.title);
    if (match === "accessory") continue;
    const merchant = (x.source ?? "").trim();
    const direct = x.link ?? null;
    const listing = direct ? safeMarketplaceUrl(direct, opts.site) : null;
    out.push({
      title: x.title.slice(0, 200),
      merchant: merchant.slice(0, 80) || "—",
      marketplace: MARKETPLACE_MERCHANT.test(merchant),
      price,
      currency: opts.site.currency,
      url: listing ?? (direct && /^https:\/\//.test(direct) ? direct : (x.product_link ?? null)),
      listingKey: listing ? listingKey(listing) : null,
      image: opts.images ? safeImage(x.thumbnail) : null,
      condition: x.second_hand_condition ? "used" : null,
      match,
      checkedAt: opts.now.toISOString(),
    });
  }
  return out;
}

/**
 * Prices for Mercado Libre's listings, only by identity: a reference whose link is the same
 * listing (same kind and id) gives that listing its price. Returns the offers (priced where
 * proven) and the references left over, split into Mercado Libre's (no provable listing: shown
 * as "reference, store: Mercado Libre", never inside a listing's card) and other stores'.
 */
export function attachPrices(
  offers: readonly Offer[],
  refs: readonly PriceReference[],
): { offers: Offer[]; marketplaceRefs: PriceReference[]; otherRefs: PriceReference[] } {
  const used = new Set<PriceReference>();
  const priced = offers.map((o) => {
    if (o.price !== null) return o;
    const key = listingKey(o.url);
    const ref = key ? refs.find((r) => r.marketplace && r.listingKey === key) : undefined;
    if (!ref) return o;
    used.add(ref);
    return {
      ...o,
      price: ref.price,
      currency: ref.currency,
      priceSource: "google_shopping" as const,
      checkedAt: ref.checkedAt,
      image: o.image ?? ref.image,
    };
  });
  const left = refs.filter((r) => !used.has(r));
  return {
    offers: priced,
    marketplaceRefs: left.filter((r) => r.marketplace),
    otherRefs: left.filter((r) => !r.marketplace),
  };
}

/** Exact model first, then the lowest price; related models after, never mixed in. */
export const rankReferences = (refs: readonly PriceReference[]) =>
  [...refs].sort(
    (a, b) => (a.match === "exact" ? 0 : 1) - (b.match === "exact" ? 0 : 1) || a.price - b.price,
  );

/** The shopping index, when configured and allowed (infrastructure). */
export interface PriceIndex {
  search(query: string, site: MarketplaceSite): Promise<unknown[]>;
  /** Whether its thumbnails may be shown (licence checked; off by default). */
  readonly images: boolean;
}
