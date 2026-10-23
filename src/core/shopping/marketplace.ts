/**
 * Buying physical products (ADR-112): Mercado Libre first for people who shop in a country it
 * serves — never the only source, never for groceries (SEPA, ADR-111). Provider-independent: an
 * offer says where it comes from and how much of it was verified. A price exists only when a
 * source authorized to give it gave it; a search link is never presented as a listing.
 *
 * Mercado Libre's developer terms forbid robots and scraping of its site (cl. 7.6) and mixing
 * its content with third parties' (shown apart, never in one ranking). So ELISE never reads its
 * pages: prices come only from the official API, when ELISE has an approved application.
 */

export const MARKETPLACE_SITES = {
  AR: {
    site: "MLA",
    currency: "ARS",
    host: "mercadolibre.com.ar",
    list: "listado.mercadolibre.com.ar",
  },
  MX: {
    site: "MLM",
    currency: "MXN",
    host: "mercadolibre.com.mx",
    list: "listado.mercadolibre.com.mx",
  },
  BR: {
    site: "MLB",
    currency: "BRL",
    host: "mercadolivre.com.br",
    list: "lista.mercadolivre.com.br",
  },
  CL: { site: "MLC", currency: "CLP", host: "mercadolibre.cl", list: "listado.mercadolibre.cl" },
  CO: {
    site: "MCO",
    currency: "COP",
    host: "mercadolibre.com.co",
    list: "listado.mercadolibre.com.co",
  },
  UY: {
    site: "MLU",
    currency: "UYU",
    host: "mercadolibre.com.uy",
    list: "listado.mercadolibre.com.uy",
  },
  PE: {
    site: "MPE",
    currency: "PEN",
    host: "mercadolibre.com.pe",
    list: "listado.mercadolibre.com.pe",
  },
} as const;
export type MarketplaceCountry = keyof typeof MARKETPLACE_SITES;
export type MarketplaceSite = (typeof MARKETPLACE_SITES)[MarketplaceCountry];

export const isMarketplaceCountry = (c: string | null | undefined): c is MarketplaceCountry =>
  Boolean(c && Object.hasOwn(MARKETPLACE_SITES, c));

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

// ── Where they buy ───────────────────────────────────────────────────────────

/**
 * The country they buy in: what they said, their saved shopping province (Argentina), or an
 * Argentine timezone they configured — never the language of the question or an IP.
 */
export function buyingCountry(opts: {
  said?: string | null;
  savedRegion?: string | null;
  timezone?: string | null;
}): string | null {
  if (opts.said) return opts.said.toUpperCase().slice(0, 2);
  if (opts.savedRegion?.startsWith("AR-")) return "AR";
  if (opts.timezone?.startsWith("America/Argentina/") || opts.timezone === "America/Buenos_Aires")
    return "AR";
  return null;
}

/** "solo Mercado Libre" / "no uses Mercado Libre" / default. */
export type MarketplaceMode = "prefer" | "only" | "avoid";

// ── Amounts and words ────────────────────────────────────────────────────────

/**
 * An amount as Argentines say it → a number: "100 lucas" = 100.000, "1 palo" = 1.000.000,
 * "150 mil", "80k", "$ 45.999", "45999,90". Null when it isn't an amount.
 */
export function parseAmount(raw: string | number): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const s = fold(raw)
    .replace(/^\$\s?|ars\s?|pesos?/g, "")
    .trim();
  const m = /^(\d+(?:[.,]\d+)*)\s*(lucas?|luca|mil|k|palos?|millon(?:es)?|m)?$/.exec(s);
  if (!m) return null;
  let digits = m[1]!;
  // "45.999" / "1.250.000" are thousands; "45999,90" / "1,5" are decimals.
  if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, "");
  else digits = digits.replace(/\./g, "").replace(",", ".");
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "";
  const factor = /^(luca|lucas|mil|k)$/.test(unit)
    ? 1000
    : /^(palo|palos|millon|millones|m)$/.test(unit)
      ? 1_000_000
      : 1;
  return Math.round(n * factor * 100) / 100;
}

/** Everyday names for what people buy ("celu" → "celular"): search words, not a rewrite of intent. */
const SLANG: Record<string, string> = {
  celu: "celular",
  celus: "celulares",
  compu: "computadora",
  notebook: "notebook",
  tele: "televisor",
  tv: "televisor",
  heladera: "heladera",
  aire: "aire acondicionado",
  lavarropas: "lavarropas",
  auris: "auriculares",
  play: "playstation",
  joystick: "joystick",
  bici: "bicicleta",
};

export function searchWords(query: string): string {
  return fold(query)
    .split(" ")
    .map((w) => SLANG[w] ?? w)
    .join(" ");
}

// ── Matching an offer to what they asked for ─────────────────────────────────

/** Parts, cases and add-ons: never the product itself. */
const ACCESSORY =
  /\b(funda|carcasa|vidrio templado|templado|protector|cable|cargador|adaptador|soporte|repuesto|bateria para|control remoto para|compatible con|estuche|correa|malla|kit de|filtro para|tapa|bolso|caja vacia)\b/;
const USED =
  /\b(usad[oa]s?|reacondicionad[oa]s?|refurbished|seminuev[oa]|como nuev[oa]|outlet|caja abierta|open box)\b/;

/**
 * A listing's own page: a classic item (MLA-123…), a catalog product (/p/MLA123…) or a user
 * product (/up/MLAU123…). A results page (listado…) is a search, never a listing.
 */
export const LISTING_ID = /M[A-Z]{2}U?-?\d{6,}/;

/** "RM4 Mini", "rm4mini", "RM-4 mini" → the same tokens. */
const modelTokens = (s: string) =>
  fold(s)
    // "RM-4", "rm 4" → "rm4"; a code like "5g" never swallows the next number ("5g 256").
    .replace(/\b([a-z]{1,4})[-\s](\d)/g, "$1$2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export type OfferMatch = "exact" | "related" | "accessory";

/**
 * How a listing's title relates to the model asked for: every model token present (and no
 * accessory wording) is "exact"; a part or add-on is "accessory"; anything else is "related" —
 * never presented as the model they asked for.
 */
export function matchOffer(model: string | null, title: string): OfferMatch {
  const t = fold(title);
  if (
    ACCESSORY.test(t) &&
    !(
      model &&
      fold(model)
        .split(" ")
        .some((w) => ACCESSORY.test(w))
    )
  )
    return "accessory";
  if (!model) return "related";
  return covers(modelTokens(model), modelTokens(title)) ? "exact" : "related";
}

/** Joined runs of up to 3 neighbouring tokens: "rm 4", "rm4 mini" → "rm4", "rm4mini". */
const runs = (tokens: string[]) => {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++)
    for (let j = i; j < Math.min(tokens.length, i + 3); j++)
      out.add(tokens.slice(i, j + 1).join(""));
  return out;
};

/**
 * Every model token is in the title as whole tokens, however they're split ("rm4mini" ↔ "RM4
 * Mini") — never as a substring: "RM4" is not inside "RM4C Mini", a different model.
 */
function covers(model: string[], title: string[]): boolean {
  const inTitle = runs(title);
  const titleTokens = new Set(title);
  return model.every(
    (w, i) =>
      inTitle.has(w) ||
      // The title joins what the model splits: "rm4mini" for "rm4" + "mini".
      [...runs(model.slice(Math.max(0, i - 2), i + 3))].some(
        (r) => r.includes(w) && titleTokens.has(r) && r !== w,
      ),
  );
}

export const conditionOf = (title: string): "new" | "used" | null =>
  USED.test(fold(title)) ? "used" : /\b(nuev[oa]s?|sellad[oa])\b/.test(fold(title)) ? "new" : null;

// ── Links ────────────────────────────────────────────────────────────────────

/**
 * A Mercado Libre link ELISE may show: https, on that country's own domain (lookalikes like
 * "mercadolibre.com.ar.evil.com" or "mercadoIibre" rejected), without tracking parameters.
 */
export function safeMarketplaceUrl(raw: string, site: MarketplaceSite): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (host !== site.host && !host.endsWith(`.${site.host}`)) return null;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Every Mercado Libre domain: pages ELISE never reads automatically (terms, cl. 7.6). */
export function isMarketplaceHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return Object.values(MARKETPLACE_SITES).some(
      (s) => host === s.host || host.endsWith(`.${s.host}`),
    );
  } catch {
    return false;
  }
}

/** The marketplace's own public search for these words — a search, never a listing. */
export function marketplaceSearchUrl(
  query: string,
  site: MarketplaceSite,
  maxPrice?: number | null,
): string {
  const slug = searchWords(query)
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  const range = maxPrice ? `_PriceRange_0-${Math.round(maxPrice)}` : "";
  return `https://${site.list}/${encodeURIComponent(slug).replace(/%2D/g, "-")}${range}`;
}

// ── Offers ───────────────────────────────────────────────────────────────────

/**
 * How much of an offer is known: "api" = from the marketplace's official API (price, condition,
 * shipping as it states them); "search_result" = a listing a web search found (title and link
 * only — its page isn't read, so no price).
 */
export type OfferEvidence = "api" | "search_result";

export interface Offer {
  source: "mercadolibre";
  externalId: string | null;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  condition: "new" | "used" | null;
  match: OfferMatch;
  /** True/false only when the source says so; null = unknown (never "free"). */
  freeShipping: boolean | null;
  installments: string | null;
  seller: string | null;
  image: string | null;
  evidence: OfferEvidence;
  /** Where the price came from: the official API, or Google Shopping linking this exact listing. */
  priceSource?: "api" | "google_shopping";
  checkedAt: string;
}

/**
 * What they asked for first: the exact model, the condition they want, priced offers, then the
 * lowest price — the cheapest number alone never wins over the right product.
 */
export function rankOffers(
  offers: readonly Offer[],
  want: { condition?: "new" | "used" | null; maxPrice?: number | null; currency?: string | null },
): Offer[] {
  const rank = (o: Offer) =>
    (o.match === "exact" ? 0 : o.match === "related" ? 10 : 100) +
    (want.condition && o.condition && o.condition !== want.condition ? 50 : 0) +
    (o.price === null ? 5 : 0);
  return offers
    .filter(
      (o) =>
        !(
          want.maxPrice &&
          o.price !== null &&
          o.currency === want.currency &&
          o.price > want.maxPrice
        ),
    )
    .map((o, i) => ({ o, i }))
    .sort(
      (a, b) =>
        rank(a.o) - rank(b.o) || (a.o.price ?? Infinity) - (b.o.price ?? Infinity) || a.i - b.i,
    )
    .map((x) => x.o);
}

/** The same listing twice (two URLs for one item, a variant link): kept once. */
export function dedupeOffers(offers: readonly Offer[]): Offer[] {
  const seen = new Set<string>();
  return offers.filter((o) => {
    const id = o.externalId ?? LISTING_ID.exec(o.url)?.[0]?.replace("-", "") ?? o.url;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** The official API, when ELISE has an approved application (infrastructure). */
export interface MarketplaceApi {
  /** Catalog products for words, with their current best offer when the API gives one. */
  search(site: MarketplaceSite, query: string, limit: number): Promise<Offer[]>;
}
