import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/errors";
import { MARKETPLACE_SITES, matchOffer, type Offer } from "@/core/shopping/marketplace";
import {
  attachPrices,
  listingKey,
  parseShoppingResults,
  type PriceIndex,
} from "@/core/shopping/price-reference";
import { offersTool } from "@/core/tools/marketplace";
import type { WebResult } from "@/core/web/model";
import { productOffersPayload } from "@/core/workspace/registry";

import { memoryShoppingData, shoppingEnv } from "../../fixtures/shopping";

/**
 * ADR-116 acceptance, on synthetic Google Shopping responses (never real listings): a price
 * reaches a Mercado Libre listing only when the result links THAT listing; RM4 ≠ RM4C; totals
 * in pesos, never installments, dollars or packs; failures never break the answer.
 */

const AR = MARKETPLACE_SITES.AR;
const NOW = new Date("2026-10-23T16:00:00.000Z");
const ITEM = "https://articulo.mercadolibre.com.ar/MLA-1111111111-broadlink-rm4c-mini-_JM";

const parse = (raw: unknown[], model: string | null = "RM4C Mini") =>
  parseShoppingResults(raw, { model, site: AR, now: NOW, images: false });

describe("matching models", () => {
  it("RM4 Mini and RM4C Mini are different models", () => {
    expect(matchOffer("RM4 Mini", "Broadlink RM4C Mini")).toBe("related");
    expect(matchOffer("RM4C Mini", "Broadlink Rm4 Mini")).toBe("related");
    expect(matchOffer("RM4 Mini", "Broadlink RM-4 mini")).toBe("exact");
    expect(matchOffer("Galaxy A55 256GB", "Samsung Galaxy A55 5G 256 GB")).toBe("exact");
  });
});

describe("parseShoppingResults", () => {
  it("keeps total ARS prices; drops installments, dollars, zero, packs and accessories", () => {
    const refs = parse([
      {
        title: "Broadlink RM4C Mini",
        price: "$ 45.999",
        extracted_price: 45999,
        source: "Garbarino",
      },
      { title: "Broadlink RM4C Mini", price: "12 x $ 4.999", extracted_price: 4999, source: "X" },
      { title: "Broadlink RM4C Mini", price: "US$ 40", extracted_price: 40, source: "Y" },
      { title: "Broadlink RM4C Mini", price: "$ 0", extracted_price: 0, source: "Z" },
      {
        title: "Broadlink RM4C Mini pack x 3 unidades",
        price: "$ 120.000",
        extracted_price: 120000,
      },
      { title: "Cable USB para Broadlink RM4C Mini", price: "$ 3.000", extracted_price: 3000 },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      price: 45999,
      currency: "ARS",
      merchant: "Garbarino",
      match: "exact",
    });
  });

  it("images only when allowed, and only from the index's image hosts", () => {
    const raw = [
      {
        title: "Broadlink RM4C Mini",
        price: "$ 45.999",
        extracted_price: 45999,
        thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=x",
      },
    ];
    expect(parse(raw)[0]!.image).toBeNull();
    expect(
      parseShoppingResults(raw, { model: null, site: AR, now: NOW, images: true })[0]!.image,
    ).toMatch(/^https:\/\/encrypted-tbn0/);
  });
});

describe("listing identity", () => {
  it("item, catalog product and user product are never equal", () => {
    expect(listingKey(ITEM)).toBe("item:MLA1111111111");
    expect(listingKey("https://www.mercadolibre.com.ar/x/p/MLA1111111111")).toBe("p:MLA1111111111");
    expect(listingKey("https://www.mercadolibre.com.ar/x/up/MLAU187474134")).toBe(
      "up:MLAU187474134",
    );
  });
});

const offer = (over: Partial<Offer> = {}): Offer => ({
  source: "mercadolibre",
  externalId: null,
  title: "Broadlink RM4C Mini Control Universal",
  url: ITEM,
  price: null,
  currency: null,
  condition: null,
  match: "exact",
  freeShipping: null,
  installments: null,
  seller: null,
  image: null,
  evidence: "search_result",
  checkedAt: NOW.toISOString(),
  ...over,
});

describe("attachPrices", () => {
  it("a price reaches a listing only through its own link", () => {
    const refs = parse([
      // Links this exact listing (tracking params dropped): it's this listing's price.
      {
        title: "Broadlink RM4C Mini",
        price: "$ 45.999",
        extracted_price: 45999,
        source: "Mercado Libre",
        link: `${ITEM}?tracking=1`,
      },
      // Same title, Mercado Libre, but no listing link: a reference, never this card's price.
      {
        title: "Broadlink RM4C Mini Control Universal",
        price: "$ 39.999",
        extracted_price: 39999,
        source: "Mercado Libre",
        product_link: "https://www.google.com/shopping/product/1",
      },
      // Another store.
      {
        title: "Broadlink RM4C Mini",
        price: "$ 52.000",
        extracted_price: 52000,
        source: "Frávega",
        link: "https://www.fravega.com/p/rm4c",
      },
    ]);
    const a = attachPrices([offer()], refs);
    expect(a.offers[0]).toMatchObject({
      price: 45999,
      currency: "ARS",
      priceSource: "google_shopping",
    });
    expect(a.marketplaceRefs.map((r) => r.price)).toEqual([39999]);
    expect(a.otherRefs.map((r) => r.merchant)).toEqual(["Frávega"]);
  });

  it("a similar title alone never prices a listing", () => {
    const refs = parse([
      {
        title: "Broadlink RM4C Mini Control Universal",
        price: "$ 39.999",
        extracted_price: 39999,
        source: "Mercado Libre",
      },
    ]);
    expect(attachPrices([offer()], refs).offers[0]!.price).toBeNull();
  });
});

// ── The tool ─────────────────────────────────────────────────────────────────

const result = (url: string, title: string): WebResult => ({
  url,
  title,
  domain: new URL(url).hostname,
  snippet: "",
  publishedAt: null,
  retrievedAt: NOW.toISOString(),
  kind: "web",
  provider: "test",
  rank: 0,
});

function setup(index: PriceIndex | null, results: WebResult[]) {
  const invoke = vi.fn(async () => ({ status: "succeeded" as const, output: { items: [] } }));
  return {
    invoke,
    ...shoppingEnv(memoryShoppingData([], new Map()), {
      timezone: "America/Argentina/Buenos_Aires",
      web: { search: vi.fn(async () => results) },
      invoke: invoke as never,
      priceIndex: index,
    }),
  };
}

const index = (raw: unknown[] | Error): PriceIndex => ({
  images: false,
  search: vi.fn(async () => {
    if (raw instanceof Error) throw raw;
    return raw;
  }),
});

const shown = (r: unknown) => (r as { display: { offers: unknown } }).display.offers;
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;

describe("shopping.offers with Google Shopping", () => {
  const ask = {
    request: "Buscame un Broadlink RM4C Mini en Mercado Libre",
    query: "Broadlink RM4C Mini",
    model: "RM4C Mini",
  };

  it("prices the listing it links; other stores apart; references labelled", async () => {
    const t = setup(
      index([
        {
          title: "Broadlink RM4C Mini",
          price: "$ 45.999",
          extracted_price: 45999,
          source: "Mercado Libre",
          link: ITEM,
        },
        {
          title: "Broadlink RM4 Mini",
          price: "$ 30.000",
          extracted_price: 30000,
          source: "Mercado Libre",
        },
        {
          title: "Broadlink RM4C Mini",
          price: "$ 52.000",
          extracted_price: 52000,
          source: "Frávega",
          link: "https://www.fravega.com/p/rm4c",
        },
      ]),
      [result(ITEM, "Broadlink RM4C Mini Control Universal | MercadoLibre")],
    );
    const r = await offersTool.run(ask, t.env);
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace.offers[0]).toMatchObject({ price: 45999, priceSource: "google_shopping" });
    // The RM4 (another model) is a flagged reference, never this listing's price.
    expect(p.references?.marketplace).toEqual([
      expect.objectContaining({ price: 30000, match: "related" }),
    ]);
    expect(p.references?.others).toEqual([expect.objectContaining({ merchant: "Frávega" })]);
    expect(p.model).toBe("RM4C Mini");
    expect(String(out(r).instructions)).toMatch(/según Google Shopping/);
    // Other stores came from the index: no extra web.discover call.
    expect(t.invoke).not.toHaveBeenCalled();
  });

  it("'solo Mercado Libre' leaves other stores out", async () => {
    const t = setup(
      index([
        {
          title: "Broadlink RM4C Mini",
          price: "$ 52.000",
          extracted_price: 52000,
          source: "Frávega",
        },
      ]),
      [result(ITEM, "Broadlink RM4C Mini | MercadoLibre")],
    );
    const r = await offersTool.run({ ...ask, marketplace: "only" }, t.env);
    expect(productOffersPayload.parse(shown(r)).references).toBeUndefined();
    expect(out(r).otherStorePrices).toBeUndefined();
  });

  it("a 403/429 from the index never breaks the answer and invents nothing", async () => {
    const t = setup(index(new AppError("RATE_LIMITED", "limited")), [
      result(ITEM, "Broadlink RM4C Mini | MercadoLibre"),
    ]);
    const r = await offersTool.run(ask, t.env);
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace.offers[0]!.price).toBeNull();
    expect(p.notes.join(" ")).toMatch(/Google Shopping no respondió/);
  });

  it("without a model asked, nothing is flagged as 'not the model'", async () => {
    const t = setup(null, [result(ITEM, "Broadlink RM4C Mini | MercadoLibre")]);
    const r = await offersTool.run({ request: "Broadlink", query: "Broadlink RM4C Mini" }, t.env);
    expect(productOffersPayload.parse(shown(r)).model).toBeNull();
  });
});
