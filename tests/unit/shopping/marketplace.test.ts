import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/errors";
import {
  buyingCountry,
  dedupeOffers,
  isMarketplaceHost,
  MARKETPLACE_SITES,
  marketplaceSearchUrl,
  matchOffer,
  parseAmount,
  rankOffers,
  safeMarketplaceUrl,
  searchWords,
  type MarketplaceApi,
  type Offer,
} from "@/core/shopping/marketplace";
import { offersTool } from "@/core/tools/marketplace";
import type { WebResult } from "@/core/web/model";
import { productOffersPayload } from "@/core/workspace/registry";

import { memoryShoppingData, shoppingEnv } from "../../fixtures/shopping";

/**
 * ADR-112 acceptance (synthetic fixtures — never presented as real listings): Mercado Libre first
 * for buyers in Argentina, honest about what's verified, never read, never mixed with other
 * stores, and safe links only.
 */

const AR = MARKETPLACE_SITES.AR;
const NOW = "2026-10-22T18:00:00.000Z";
const offer = (over: Partial<Offer>): Offer => ({
  source: "mercadolibre",
  externalId: null,
  title: "Broadlink RM4 Mini Control Universal Wifi",
  url: "https://articulo.mercadolibre.com.ar/MLA-1111111111-broadlink-rm4-mini-_JM",
  price: null,
  currency: null,
  condition: null,
  match: "related",
  freeShipping: null,
  installments: null,
  seller: null,
  image: null,
  evidence: "search_result",
  checkedAt: NOW,
  ...over,
});
const result = (url: string, title: string): WebResult => ({
  url,
  title,
  domain: new URL(url).hostname,
  snippet: "$ 45.999 envío gratis", // a snippet's price is never shown as verified
  publishedAt: null,
  retrievedAt: NOW,
  kind: "web",
  provider: "test",
  rank: 0,
});
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;
const shown = (r: unknown) => (r as { display?: { offers: unknown } }).display?.offers;

function setup(over: Parameters<typeof shoppingEnv>[1] = {}, results: WebResult[] = []) {
  const search = vi.fn(async () => results);
  const invoke = vi.fn(async () => ({
    status: "succeeded" as const,
    output: {
      items: [
        {
          n: 1,
          title: "Broadlink RM4 Mini",
          price: "ARS 52000",
          url: "https://tienda.example/rm4",
        },
      ],
    },
  }));
  const s = shoppingEnv(memoryShoppingData([], new Map()), {
    timezone: "America/Argentina/Buenos_Aires",
    web: { search },
    invoke: invoke as never,
    ...over,
  });
  return { ...s, search, invoke };
}

describe("words and amounts (Argentina)", () => {
  it("lucas, mil, palos, prices as written", () => {
    expect(parseAmount("100 lucas")).toBe(100_000);
    expect(parseAmount("150 mil")).toBe(150_000);
    expect(parseAmount("1 palo")).toBe(1_000_000);
    expect(parseAmount("$ 45.999")).toBe(45_999);
    expect(parseAmount("45999,90")).toBe(45_999.9);
    expect(parseAmount("80k")).toBe(80_000);
    expect(parseAmount("barato")).toBeNull();
    expect(searchWords("celu y tele")).toBe("celular y televisor");
  });

  it("the country comes from what they said or configured, never the language", () => {
    expect(buyingCountry({ timezone: "America/Argentina/Buenos_Aires" })).toBe("AR");
    expect(buyingCountry({ savedRegion: "AR-X", timezone: "Europe/Madrid" })).toBe("AR");
    expect(buyingCountry({ said: "mx", timezone: "America/Argentina/Cordoba" })).toBe("MX");
    expect(buyingCountry({ timezone: "Europe/Madrid" })).toBeNull();
  });
});

describe("matching (case 9)", () => {
  it("the exact model; another model, a used one or an accessory is never equated", () => {
    expect(matchOffer("RM4 Mini", "Broadlink RM4 Mini Wifi IR")).toBe("exact");
    expect(matchOffer("RM4 Mini", "Broadlink RM-4 mini universal")).toBe("exact");
    expect(matchOffer("RM4 Mini", "Broadlink RM4 Pro RF")).toBe("related");
    expect(matchOffer("RM4 Mini", "Cable USB para Broadlink RM4 Mini")).toBe("accessory");
    expect(matchOffer("Galaxy A55", "Funda Samsung Galaxy A55 silicona")).toBe("accessory");
    expect(matchOffer(null, "Aire acondicionado split inverter para 3000 frigorías")).toBe(
      "related",
    );
  });

  it("ranking: right product and condition before the lowest number", () => {
    const ranked = rankOffers(
      [
        offer({
          title: "Cable RM4",
          match: "accessory",
          price: 3000,
          currency: "ARS",
          evidence: "api",
        }),
        offer({
          title: "RM4 usado",
          match: "exact",
          condition: "used",
          price: 30000,
          currency: "ARS",
          evidence: "api",
        }),
        offer({
          title: "RM4 nuevo",
          match: "exact",
          condition: "new",
          price: 45000,
          currency: "ARS",
          evidence: "api",
        }),
        offer({
          title: "RM4 caro",
          match: "exact",
          condition: "new",
          price: 150000,
          currency: "ARS",
          evidence: "api",
        }),
      ],
      { condition: "new", maxPrice: 100_000, currency: "ARS" },
    );
    expect(ranked.map((o) => o.title)).toEqual(["RM4 nuevo", "RM4 usado", "Cable RM4"]);
  });

  it("the same listing twice is kept once", () => {
    expect(
      dedupeOffers([
        offer({}),
        offer({ url: "https://articulo.mercadolibre.com.ar/MLA-1111111111-otra-url" }),
      ]),
    ).toHaveLength(1);
  });
});

describe("real Mercado Libre URL shapes (seen live on 2026-10-22)", () => {
  it("user products and catalog pages are listings; open box is not new", async () => {
    const t = setup({}, [
      result(
        "https://www.mercadolibre.com.ar/broadlink-rm-4-mini-control-remoto-wifi-alexa-google-home/up/MLAU187474134",
        "Broadlink Rm 4 Mini Control Remoto Wifi Alexa Google Home | MercadoLibre",
      ),
      result(
        "https://www.mercadolibre.com.ar/smartphone-samsung-galaxy-a55-256gb-nuevo-con-caja-abierta/p/MLA2015837765",
        "Smartphone Samsung Galaxy A55 256GB Nuevo Con Caja Abierta | MercadoLibre",
      ),
      result("https://listado.mercadolibre.com.ar/rm4-mini", "Rm4 Mini | MercadoLibre"),
    ]);
    const r = await offersTool.run(
      { request: "rm4 mini", query: "Broadlink RM4 Mini", model: "RM4 Mini" },
      t.env,
    );
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace.offers.map((o) => [o.match, o.condition])).toEqual([
      ["exact", null],
      ["related", "used"],
    ]);
  });
});

describe("links (case 12)", () => {
  it("only the country's own Mercado Libre domain, over https, without tracking", () => {
    expect(
      safeMarketplaceUrl(
        "https://articulo.mercadolibre.com.ar/MLA-1-x?tracking_id=abc#reviews",
        AR,
      ),
    ).toBe("https://articulo.mercadolibre.com.ar/MLA-1-x");
    for (const bad of [
      "https://articulo.mercadolibre.com.ar.evil.com/MLA-1",
      "https://mercadoIibre.com.ar/MLA-1",
      "http://articulo.mercadolibre.com.ar/MLA-1",
      "https://user:pass@articulo.mercadolibre.com.ar/MLA-1",
      "https://articulo.mercadolibre.com.mx/MLM-1",
      "javascript:alert(1)",
    ])
      expect(safeMarketplaceUrl(bad, AR), bad).toBeNull();
    expect(isMarketplaceHost("https://www.mercadolivre.com.br/x")).toBe(true);
    expect(isMarketplaceHost("https://mercadolibre.com.ar.evil.com/")).toBe(false);
    expect(marketplaceSearchUrl("Broadlink RM4 Mini", AR, 100_000)).toBe(
      "https://listado.mercadolibre.com.ar/broadlink-rm4-mini_PriceRange_0-100000",
    );
  });
});

describe("shopping.offers", () => {
  const ITEM = "https://articulo.mercadolibre.com.ar/MLA-1111111111-broadlink-rm4-mini-_JM";

  it("case 1: Argentina, ARS budget in 'lucas', Mercado Libre first; no API → listings without price", async () => {
    const t = setup({}, [
      result(ITEM, "Broadlink Rm4 Mini Control Universal | MercadoLibre"),
      result("https://listado.mercadolibre.com.ar/broadlink-rm4", "Broadlink Rm4 en Mercado Libre"),
      result(
        "https://articulo.mercadolibre.com.ar/MLA-2222222222-cable-usb-para-broadlink-rm4-mini-_JM",
        "Cable USB para Broadlink RM4 Mini",
      ),
    ]);
    const r = await offersTool.run(
      {
        request: "Buscame Broadlink RM4 Mini nuevo por menos de 100 mil pesos",
        query: "Broadlink RM4 Mini",
        model: "RM4 Mini",
        maxPrice: "100 mil",
        condition: "new",
      },
      t.env,
    );
    expect(t.search).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ["mercadolibre.com.ar"] }),
    );
    const p = productOffersPayload.parse(shown(r));
    expect(p).toMatchObject({
      maxPrice: 100_000,
      currency: "ARS",
      marketplace: { method: "search", site: "MLA" },
    });
    // case 6: the results page is not a listing; case 8/9: no price, accessory flagged.
    expect(p.marketplace.offers.map((o) => [o.match, o.price, o.freeShipping])).toEqual([
      ["exact", null, null],
      ["accessory", null, null],
    ]);
    expect(String(out(r).instructions)).toMatch(/NO verified Mercado Libre prices/);
    // No verified price: other stores are brought, apart, without Mercado Libre.
    expect(t.invoke).toHaveBeenCalledWith(
      "web.discover",
      expect.objectContaining({ exclude: expect.arrayContaining(["mercadolibre.com.ar"]) }),
    );
    expect(out(r).otherStores).toHaveLength(1);
  });

  it("case 2: 'solo Mercado Libre' with the API: verified prices, no other stores, variants apart", async () => {
    const api: MarketplaceApi = {
      search: vi.fn(async () => [
        offer({
          title: "Samsung Galaxy A55 5G 256GB",
          price: 650000,
          currency: "ARS",
          evidence: "api",
          condition: "new",
          freeShipping: true,
          externalId: "MLA1",
        }),
        offer({
          title: "Samsung Galaxy A35 128GB",
          price: 450000,
          currency: "ARS",
          evidence: "api",
          condition: "new",
          externalId: "MLA2",
          url: "https://articulo.mercadolibre.com.ar/MLA-2",
        }),
      ]),
    };
    const t = setup({ marketplace: api });
    const r = await offersTool.run(
      {
        request: "¿Cuánto está un Samsung A55 en Mercado Libre?",
        query: "Samsung Galaxy A55",
        model: "Galaxy A55",
        marketplace: "only",
      },
      t.env,
    );
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace.method).toBe("api");
    expect(p.marketplace.offers.map((o) => [o.title, o.match])).toEqual([
      ["Samsung Galaxy A55 5G 256GB", "exact"],
      ["Samsung Galaxy A35 128GB", "related"],
    ]);
    expect(t.search).not.toHaveBeenCalled();
    expect(t.invoke).not.toHaveBeenCalled();
  });

  it("case 3: 'compará con otras tiendas' → both, each apart", async () => {
    const api: MarketplaceApi = {
      search: async () => [
        offer({ price: 48000, currency: "ARS", evidence: "api", match: "exact" }),
      ],
    };
    const t = setup({ marketplace: api });
    const r = await offersTool.run(
      {
        request: "¿Es más barato en Mercado Libre que en otra tienda?",
        query: "Broadlink RM4 Mini",
        compareStores: true,
      },
      t.env,
    );
    expect(out(r).otherStores).toHaveLength(1);
    expect(String(out(r).instructions)).toMatch(
      /Never present Mercado Libre and other stores as one ranking/,
    );
  });

  it("case 4: 'no uses Mercado Libre' → not consulted, no Mercado Libre card", async () => {
    const api: MarketplaceApi = { search: vi.fn(async () => []) };
    const t = setup({ marketplace: api });
    const r = await offersTool.run(
      {
        request: "Buscame auriculares, no uses Mercado Libre",
        query: "auriculares inalámbricos",
        marketplace: "avoid",
      },
      t.env,
    );
    expect(api.search).not.toHaveBeenCalled();
    expect(t.search).not.toHaveBeenCalled();
    expect(shown(r)).toBeUndefined();
    expect(t.invoke).toHaveBeenCalled();
  });

  it("case 5: API 403/429 → degrades to listings without prices, says why", async () => {
    const api: MarketplaceApi = {
      search: async () => {
        throw new AppError("PROVIDER_UNAVAILABLE", "Mercado Libre refused ELISE's access", {
          details: { providerStatus: 403 },
        });
      },
    };
    const t = setup({ marketplace: api }, [result(ITEM, "Broadlink RM4 Mini")]);
    const r = await offersTool.run({ request: "RM4 mini", query: "Broadlink RM4 Mini" }, t.env);
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace.method).toBe("search");
    expect(p.marketplace.offers.every((o) => o.price === null)).toBe(true);
    expect(p.notes[0]).toMatch(/no respondió/);
  });

  it("case 6/7: nothing found → only a labeled search link (never a product); an API price says when it was checked", async () => {
    const t = setup({}, []);
    const r = await offersTool.run(
      {
        request: "aire inverter 3000 frigorías",
        query: "aire acondicionado inverter 3000 frigorias",
      },
      t.env,
    );
    const p = productOffersPayload.parse(shown(r));
    expect(p.marketplace).toMatchObject({ method: "link", offers: [] });
    expect(p.marketplace.searchUrl).toMatch(/^https:\/\/listado\.mercadolibre\.com\.ar\//);
  });

  it("case 11: buying in Mexico → mercadolibre.com.mx and MXN, never ARS", async () => {
    const t = setup({}, [
      result("https://articulo.mercadolibre.com.mx/MLM-123456789-audifonos-_JM", "Audífonos"),
    ]);
    const r = await offersTool.run(
      {
        request: "audífonos en México hasta 1500",
        query: "audifonos inalambricos",
        maxPrice: 1500,
        country: "MX",
      },
      t.env,
    );
    expect(t.search).toHaveBeenCalledWith(
      expect.objectContaining({ domains: ["mercadolibre.com.mx"] }),
    );
    expect(productOffersPayload.parse(shown(r))).toMatchObject({
      currency: "MXN",
      marketplace: { site: "MLM" },
    });
  });

  it("unknown country (not Argentina by language): no Mercado Libre guess, asks where", async () => {
    const t = setup({ timezone: "Europe/Madrid" });
    const r = await offersTool.run(
      { request: "buscame un RM4 mini", query: "Broadlink RM4 Mini" },
      t.env,
    );
    expect(shown(r)).toBeUndefined();
    expect(String(out(r).instructions)).toMatch(/don't assume Argentina/);
  });

  it("a saved 'avoid' is respected; a one-time 'only' overrides it", async () => {
    const t = setup({ mode: "avoid" }, [result(ITEM, "RM4 mini")]);
    await offersTool.run({ request: "rm4", query: "rm4 mini" }, t.env);
    expect(t.search).not.toHaveBeenCalled();
    await offersTool.run(
      { request: "solo en Mercado Libre", query: "rm4 mini", marketplace: "only" },
      t.env,
    );
    expect(t.search).toHaveBeenCalled();
    expect(t.mode()).toBe("avoid");
  });
});
