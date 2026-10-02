import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import { AppError } from "@/core/errors";
import {
  coverageOf,
  DISCOVERY_LIMITS,
  queryPlan,
  rankItems,
  type CollectionRequest,
} from "@/core/web/discover";
import {
  extractItems,
  itemLinks,
  looksLikeItemUrl,
  parsePrice,
  readLimitation,
  type WebItem,
} from "@/core/web/items";
import type { WebCapability, WebPage, WebResult } from "@/core/web/model";
import { applyOps, emptyWorkspace, type WorkspaceOp } from "@/core/workspace/model";
import type { WorkspacePort } from "@/core/workspace/port";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Web discovery (ADR-028): concrete items from the structured data sites publish, coverage
 * against what was asked, bounded iteration, and honest limitations. Synthetic sites only.
 */

const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const product = (n: number, over: Record<string, unknown> = {}) => ({
  "@type": "Product",
  name: `Sedan XL ${2015 + n}`,
  image: `http://img.market.example/${n}.jpg`,
  offers: {
    "@type": "Offer",
    price: 10_000 + n * 1_000,
    priceCurrency: "USD",
    url: `https://market.example/AB-10000000${n}-sedan-xl`,
  },
  ...over,
});
const listingHtml = (n: number) =>
  `<html><body><h1>Sedan XL for sale</h1>${ld({
    "@context": "https://schema.org",
    "@graph": Array.from({ length: n }, (_, i) => product(i)),
  })}<p>${"Results. ".repeat(50)}</p></body></html>`;

describe("structured items", () => {
  it("reads products from JSON-LD graphs, upgrades images to https, dedupes by URL", () => {
    const html = listingHtml(3) + ld(product(0));
    const items = extractItems(html, "https://market.example/sedan-xl/");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: "Sedan XL 2015",
      price: 10_000,
      currency: "USD",
      url: "https://market.example/AB-100000000-sedan-xl",
      image: "https://img.market.example/0.jpg",
    });
  });

  it("vehicles, homes and lists carry their stated facts; malformed blocks are skipped", () => {
    const html =
      '<script type="application/ld+json">{ not json</script>' +
      ld({
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "ListItem",
            item: {
              "@type": "Car",
              name: "Hatch S",
              url: "https://cars.example/item/hatch-s",
              vehicleModelDate: "2019",
              mileageFromOdometer: { value: 85000, unitCode: "KMT" },
              itemCondition: "https://schema.org/UsedCondition",
              offers: { price: "12.500", priceCurrency: "EUR" },
            },
          },
          {
            "@type": "ListItem",
            item: {
              "@type": "Apartment",
              name: "2 rooms near the park",
              url: "https://homes.example/listing/2r",
              numberOfRooms: 2,
              address: { addressLocality: "Greenhill" },
            },
          },
        ],
      });
    const [car, flat] = extractItems(html, "https://cars.example/");
    expect(car!.attributes).toEqual(
      expect.arrayContaining([
        { label: "year", value: "2019" },
        { label: "mileage", value: "85000 km" },
        { label: "condition", value: "used" },
      ]),
    );
    expect(car!.price).toBe(12_500);
    expect([parsePrice("12500.00"), parsePrice("1.234,56"), parsePrice("1,234.5")]).toEqual([
      12_500, 1234.56, 1234.5,
    ]);
    expect(flat!.attributes).toEqual(
      expect.arrayContaining([
        { label: "rooms", value: "2" },
        { label: "location", value: "Greenhill" },
      ]),
    );
  });

  it("item-like links are followed only on the same site", () => {
    const html =
      '<a href="/AB-123456789-sedan">a</a><a href="/help">b</a><a href="https://other.example/AB-987654321-x">c</a><a href="/item/xyz">d</a>';
    expect(itemLinks(html, "https://market.example/list")).toEqual([
      "https://market.example/AB-123456789-sedan",
      "https://market.example/item/xyz",
    ]);
    expect(looksLikeItemUrl("https://market.example/sedan-xl/")).toBe(false);
  });

  it("an anti-bot page that answered 200 is 'blocked'; a script shell is 'dynamic'", () => {
    expect(
      readLimitation(
        "<html>Please verify</html>",
        "Please verify",
        "https://market.example/list",
        "https://www.market.example/gz/account-verification?go=x",
      ),
    ).toBe("blocked");
    expect(
      readLimitation(
        "<title>Just a moment...</title>",
        "Just a moment...",
        "https://a.example/",
        "https://a.example/",
      ),
    ).toBe("blocked");
    expect(
      readLimitation(
        `<div id="root"></div>${"<script></script>".repeat(10)}`,
        "",
        "https://a.example/",
        "https://a.example/",
      ),
    ).toBe("dynamic");
    expect(
      readLimitation(listingHtml(2), "x".repeat(2_000), "https://a.example/", "https://a.example/"),
    ).toBeNull();
  });
});

describe("coverage and ranking", () => {
  const req = (over: Partial<CollectionRequest> = {}): CollectionRequest => ({
    count: 5,
    domain: null,
    terms: [],
    minPrice: null,
    maxPrice: null,
    currency: null,
    ...over,
  });
  const items = extractItems(listingHtml(8), "https://market.example/");

  it("one relevant page with no items is not completion", () => {
    expect(coverageOf(req(), 0)).toBe("insufficient");
    expect(coverageOf(req(), 3)).toBe("partial");
    expect(coverageOf(req(), 5)).toBe("sufficient");
  });

  it("constraints rank and filter: price bounds, a named site, the user's words", () => {
    const cheap = rankItems(req({ maxPrice: 12_000, currency: "USD" }), items);
    expect(cheap.every((i) => i.price! <= 12_000)).toBe(true);
    const other: WebItem = {
      ...items[0]!,
      url: "https://other.example/AB-555555555-x",
      domain: "other.example",
    };
    expect(
      rankItems(req({ domain: "market.example" }), [other, ...items]).some(
        (i) => i.domain === "other.example",
      ),
    ).toBe(false);
    expect(rankItems(req({ terms: ["2020"] }), items)[0]!.title).toBe("Sedan XL 2020");
  });

  it("without a named site no single site fills the collection", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...items[0]!,
      url: `https://market.example/AB-20000000${i}`,
    }));
    expect(rankItems(req({ count: 10 }), many)).toHaveLength(DISCOVERY_LIMITS.perDomain);
  });

  it("a few purposeful query variants, never dozens", () => {
    expect(queryPlan("sedan xl", ["Sedan XL", "sedan xl 2018", "sedan xl usado", "more"])).toEqual([
      "sedan xl",
      "sedan xl 2018",
    ]);
    expect(queryPlan("sedan xl", ["publicaciones de sedan xl"])).toEqual([
      "sedan xl",
      "publicaciones de sedan xl",
    ]);
  });
});

// ── web.discover through the executor ───────────────────────────────────────

const NOW = new Date("2026-10-02T15:00:00Z");
const result = (url: string, title = url): WebResult => ({
  url,
  title,
  domain: new URL(url).hostname,
  snippet: title,
  publishedAt: null,
  retrievedAt: NOW.toISOString(),
  kind: "web",
  provider: "fake",
  rank: 0,
});
const pageOf = (url: string, html: string): WebPage => ({
  requestedUrl: url,
  url,
  domain: new URL(url).hostname,
  title: url,
  siteName: null,
  description: null,
  publishedAt: null,
  retrievedAt: NOW.toISOString(),
  text: "text",
  truncated: false,
  items: extractItems(html, url),
  itemLinks: itemLinks(html, url),
});

class FakeWeb implements WebCapability {
  searches: string[] = [];
  opens: string[] = [];
  constructor(
    private readonly results: (query: string) => WebResult[],
    private readonly pages: (url: string) => string | Error,
  ) {}
  async search(q: { query: string }) {
    this.searches.push(q.query);
    return this.results(q.query);
  }
  async open(url: string) {
    this.opens.push(url);
    const p = this.pages(url);
    if (p instanceof Error) throw p;
    return pageOf(url, p);
  }
  async saveToKnowledge(): Promise<never> {
    throw new Error("not used");
  }
}

class FakeWorkspace implements WorkspacePort {
  value = emptyWorkspace();
  ops: WorkspaceOp[] = [];
  state() {
    return this.value;
  }
  apply(ops: WorkspaceOp[]) {
    this.ops.push(...ops);
    this.value = applyOps(this.value, ops);
  }
  activity() {}
}

function setup(web: FakeWeb) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "web_search" ? web : undefined)) as ProviderFactory["get"],
  };
  const ws = new FakeWorkspace();
  return { ports, ws, ctx: makeCtx({ now: NOW, workspace: ws }) };
}

const blocked = () =>
  new AppError("PERMISSION_DENIED", "blocked", { details: { limitation: "blocked" } });

describe("web.discover", () => {
  it("a category page with structured listings → concrete items in one round, shown progressively", async () => {
    const web = new FakeWeb(
      () => [result("https://market.example/sedan-xl/", "Sedan XL for sale")],
      () => listingHtml(10),
    );
    const { ports, ws, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.discover",
      args: { request: "publicaciones de Sedan XL", query: "Sedan XL", count: 6 },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { found: 6, status: "sufficient" } });
    expect(web.searches).toHaveLength(1);
    const presents = ws.ops.filter((o) => o.op === "present");
    // Loading first, then updated in place — one Surface.
    expect(presents.length).toBeGreaterThanOrEqual(2);
    expect(ws.value.surfaces.filter((s) => s.type === "web_collection")).toHaveLength(1);
    const surface = ws.value.surfaces.find((s) => s.type === "web_collection")!;
    expect(surface.state).toBe("ready");
    expect((out as { output: { prices: string[] } }).output.prices[0]).toMatch(/^USD /);
  });

  it("a named site that blocks reading: says so precisely, keeps index-only items, substitutes nothing", async () => {
    const web = new FakeWeb(
      (q) =>
        q.includes("2018")
          ? [result("https://market.example/AB-111111111-sedan-xl-2018", "Sedan XL 2018 - Market")]
          : [
              result("https://market.example/sedan-xl/", "Sedan XL | Market"),
              result("https://othermarket.example/AB-222222222-sedan", "Sedan XL elsewhere"),
            ],
      () => blocked(),
    );
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.discover",
      args: {
        request: "Sedan XL en Market",
        query: "Sedan XL",
        domain: "market.example",
        count: 5,
        variants: ["Sedan XL 2018"],
      },
    });
    const o = (out as { output: Record<string, unknown> }).output;
    expect(o.status).toBe("insufficient");
    expect(o.limitations).toEqual(["market.example: the site blocks automated reading"]);
    expect(o.siteSearchPage).toBe("https://market.example/sedan-xl/");
    // The other marketplace was never read or offered.
    expect(web.opens.some((u) => u.includes("othermarket"))).toBe(false);
    expect(o.items).toEqual([
      expect.objectContaining({ title: "Sedan XL 2018 - Market", fromSearchIndexOnly: true }),
    ]);
  });

  it("a listing page without structured items: its item links are followed", async () => {
    const web = new FakeWeb(
      () => [result("https://shop.example/list", "List")],
      (url) =>
        url.endsWith("/list")
          ? '<a href="/AB-300000001-a">a</a><a href="/AB-300000002-b">b</a>'
          : ld(
              product(1, {
                name: `Item ${url.slice(-1)}`,
                offers: { price: 5, priceCurrency: "USD", url },
              }),
            ),
    );
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.discover",
      args: { request: "items", query: "items", count: 2 },
    });
    expect(out).toMatchObject({ output: { found: 2, status: "sufficient" } });
    expect(web.opens).toEqual([
      "https://shop.example/list",
      "https://shop.example/AB-300000001-a",
      "https://shop.example/AB-300000002-b",
    ]);
  });

  it("iteration is bounded: rounds, searches and pages, even when nothing is found", async () => {
    let n = 0;
    const web = new FakeWeb(
      () => Array.from({ length: 8 }, () => result(`https://s${n++}.example/page`)),
      () => "<p>nothing structured here</p>",
    );
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.discover",
      args: { request: "anything", query: "anything", count: 10, variants: ["other", "third"] },
    });
    expect(web.searches.length).toBeLessThanOrEqual(DISCOVERY_LIMITS.rounds);
    expect(web.opens.length).toBeLessThanOrEqual(DISCOVERY_LIMITS.pages);
    expect(out).toMatchObject({ output: { found: 0, status: "insufficient" } });
  });
});
