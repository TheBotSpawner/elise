import { decodeEntities } from "./extract";
import { cleanUrl, domainOf, normalizeUrl } from "./url";

/**
 * Concrete items on a page (ADR-028): products, listings, vehicles, homes, courses, events —
 * read from the schema.org JSON-LD the site publishes for search engines, never guessed from
 * layout. Site-independent: no marketplace is special-cased. Also tells a page that refuses
 * automated reading (an anti-bot check) or renders only in the browser from one that is empty.
 * Deterministic and dependency-free; the values are untrusted data.
 */

export interface WebItem {
  title: string;
  /** The item's own page (https), canonical. */
  url: string;
  domain: string;
  price: number | null;
  currency: string | null;
  image: string | null;
  /** A few labelled facts the site states ("Year 2019", "Mileage 85,000 km"). */
  attributes: { label: string; value: string }[];
}

export type ReadLimitation = "blocked" | "dynamic";

type Json = Record<string, unknown>;

const ITEM_TYPES =
  /^(Product|ProductModel|IndividualProduct|Vehicle|Car|Motorcycle|Offer|AggregateOffer|Accommodation|Apartment|House|SingleFamilyResidence|Residence|Room|Course|Event|Book|Service|RealEstateListing|JobPosting|Hotel|LodgingBusiness)$/i;

const str = (v: unknown): string | null =>
  typeof v === "string"
    ? decodeEntities(v).trim() || null
    : typeof v === "number"
      ? String(v)
      : null;
const types = (o: Json) => [o["@type"]].flat().filter((t): t is string => typeof t === "string");

/** schema.org condition URLs → plain words. */
const CONDITION: Record<string, string> = {
  NewCondition: "new",
  UsedCondition: "used",
  RefurbishedCondition: "refurbished",
  DamagedCondition: "damaged",
};

function https(raw: unknown, base: string): string | null {
  const v = str(raw);
  if (!v) return null;
  try {
    const u = new URL(v.replace(/^http:\/\//, "https://"), base);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * schema.org wants "12500.00", but sites also publish "12.500" or "1.234,56". Groups of exactly
 * three digits after a separator are thousands (a price never has three decimals).
 */
export function parsePrice(raw: string): number {
  const s = raw.replace(/[^\d.,]/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ""));
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  return Number(s.replace(/,/g, ""));
}

function priceOf(o: Json): { price: number | null; currency: string | null } {
  const offers = [o.offers].flat()[0] as Json | undefined;
  const src = offers && typeof offers === "object" ? offers : o;
  const raw = src.price ?? src.lowPrice ?? (src.priceSpecification as Json | undefined)?.price;
  const price = typeof raw === "number" ? raw : raw ? parsePrice(String(raw)) : NaN;
  const currency = str(
    src.priceCurrency ?? (src.priceSpecification as Json | undefined)?.priceCurrency,
  );
  return {
    price: Number.isFinite(price) && price > 0 ? price : null,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
  };
}

function attributesOf(o: Json): WebItem["attributes"] {
  const out: WebItem["attributes"] = [];
  const add = (label: string, v: unknown) => {
    const s = str(v);
    if (s && out.length < 6 && !out.some((a) => a.label === label))
      out.push({ label, value: s.slice(0, 60) });
  };
  const brand = o.brand;
  add("brand", typeof brand === "object" && brand ? (brand as Json).name : brand);
  add("year", o.vehicleModelDate ?? o.modelDate ?? o.productionDate ?? o.releaseDate);
  const km = o.mileageFromOdometer as Json | string | undefined;
  if (km && typeof km === "object")
    add(
      "mileage",
      `${str(km.value) ?? ""} ${str(km.unitText) ?? (str(km.unitCode) === "KMT" ? "km" : str(km.unitCode) === "SMI" ? "mi" : "")}`.trim(),
    );
  else add("mileage", km);
  const condition = str(
    o.itemCondition ?? ([o.offers].flat()[0] as Json | undefined)?.itemCondition,
  );
  if (condition)
    add("condition", CONDITION[condition.split("/").pop() ?? ""] ?? condition.split("/").pop());
  const place = (o.address ??
    o.location ??
    ([o.offers].flat()[0] as Json | undefined)?.availableAtOrFrom) as Json | string | undefined;
  const address =
    place && typeof place === "object" ? ((place.address as Json | undefined) ?? place) : place;
  add(
    "location",
    address && typeof address === "object"
      ? [address.addressLocality, address.addressRegion].map(str).filter(Boolean).join(", ")
      : address,
  );
  add("rooms", o.numberOfRooms);
  const size = o.floorSize as Json | undefined;
  if (size && typeof size === "object")
    add("size", `${str(size.value) ?? ""} ${str(size.unitText) ?? "m²"}`.trim());
  add("fuel", o.fuelType);
  add("transmission", o.vehicleTransmission);
  add("starts", o.startDate);
  const provider = o.provider as Json | undefined;
  add("by", provider && typeof provider === "object" ? provider.name : provider);
  return out;
}

/** Every JSON object in the page's JSON-LD blocks, flattened (@graph, ItemList, arrays). */
function jsonLd(html: string): Json[] {
  const out: Json[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5 || out.length > 400) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const o = v as Json;
    out.push(o);
    if (o["@graph"]) visit(o["@graph"], depth + 1);
    if (o.itemListElement) visit(o.itemListElement, depth + 1);
    if (o.item && typeof o.item === "object") visit(o.item, depth + 1);
  };
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(m[1]!.trim()), 0);
    } catch {
      // A malformed block is skipped; the rest of the page still counts.
    }
  }
  return out;
}

/** Concrete items the page publishes (deduplicated by canonical URL). */
export function extractItems(html: string, pageUrl: string): WebItem[] {
  const items: WebItem[] = [];
  const seen = new Set<string>();
  for (const o of jsonLd(html)) {
    if (!types(o).some((t) => ITEM_TYPES.test(t))) continue;
    // An Offer inside a Product is part of it, not an item of its own.
    if (types(o).every((t) => /^(Offer|AggregateOffer)$/i.test(t)) && !o.name) continue;
    const title = str(o.name)?.slice(0, 200);
    const url =
      https(o.url, pageUrl) ??
      https(([o.offers].flat()[0] as Json | undefined)?.url, pageUrl) ??
      https(o["@id"], pageUrl);
    if (!title || !url) continue;
    const clean = cleanUrl(url.split("#")[0]!);
    const key = normalizeUrl(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    const image = https(
      [o.image].flat()[0] && typeof [o.image].flat()[0] === "object"
        ? ([o.image].flat()[0] as Json).url
        : [o.image].flat()[0],
      pageUrl,
    );
    items.push({
      title,
      url: clean,
      domain: domainOf(clean),
      ...priceOf(o),
      image,
      attributes: attributesOf(o),
    });
    if (items.length >= 60) break;
  }
  return items;
}

/** A URL whose path carries an item id ("/AB-123456789-…", "/item/abc", "/dp/B0…"). */
export function looksLikeItemUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return /(?:^|[/_-])[A-Z]{0,4}-?\d{6,}(?:[/_.-]|$)|\/(item|items|p|dp|listing|ad|anuncio|propiedad|property)\/[\w-]+/i.test(
      path,
    );
  } catch {
    return false;
  }
}

/** Same-site links that look like individual item pages (an id in the path), for following. */
export function itemLinks(html: string, pageUrl: string, limit = 20): string[] {
  const site = domainOf(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    const url = https(m[1], pageUrl);
    if (!url || domainOf(url) !== site) continue;
    if (!looksLikeItemUrl(url)) continue;
    out.add(cleanUrl(url));
    if (out.size >= limit) break;
  }
  return [...out];
}

const BLOCK_MARKERS =
  /captcha|cf-challenge|challenge-platform|just a moment\.\.\.|are you a (ro)?bot|access denied|unusual traffic|verify you are human|account-verification|request blocked|px-captcha|perimeterx|datadome/i;

/**
 * Why a page that answered can't be read: an anti-bot check (often a 200 with a verification
 * page, or a redirect to one) or a page whose content only renders in a browser.
 */
export function readLimitation(
  html: string,
  text: string,
  requestedUrl: string,
  finalUrl: string,
): ReadLimitation | null {
  const moved = new URL(finalUrl).pathname !== new URL(requestedUrl).pathname;
  if (
    (moved && /captcha|challenge|verif|blocked|denied|robot/i.test(finalUrl)) ||
    (text.length < 1_500 && BLOCK_MARKERS.test(html))
  )
    return "blocked";
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (
    text.length < 300 &&
    (scripts >= 8 ||
      /enable javascript|requires javascript|id=["'](root|__next|app)["']\s*>\s*<\/div>/i.test(
        html,
      ))
  )
    return "dynamic";
  return null;
}

/** Item identity across pages and searches: canonical URL. */
export const itemKey = (i: Pick<WebItem, "url">) => normalizeUrl(i.url);
