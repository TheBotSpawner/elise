import { describe, expect, it } from "vitest";

import {
  ageDays,
  canonicalEan,
  compareBasket,
  evaluateAlert,
  perUnitCents,
  priceChange,
  rankCandidates,
  regionFromWords,
  sizeIn,
  stepSeries,
  type ChainPrice,
  type Product,
} from "@/core/shopping/model";

/**
 * ADR-111: the deterministic core. Names never become products by themselves, sizes and variants
 * separate products, and a basket's totals never call a chain cheaper when it lacks products.
 */

const P = (ean: string, name: string, brand: string | null = null): Product => ({
  ean,
  name,
  brand,
  size: sizeIn(name),
});

const MILK_WHOLE = P("7790742656018", "LECHE ENTERA LA SERENISIMA 1 L", "LA SERENISIMA");
const MILK_WHOLE_500 = P("7790742656025", "LECHE ENTERA LA SERENISIMA 500 ML", "LA SERENISIMA");
const MILK_SKIM = P("7790742656032", "LECHE DESCREMADA LA SERENISIMA 1 L", "LA SERENISIMA");
const MILK_LACTOSE = P("7790742656049", "LECHE ENTERA DESLACTOSADA SERENISIMA 1 L");
const MILK_POWDER = P("7790742656056", "LECHE EN POLVO ENTERA 800 G");
const YERBA = P("7790387013504", "YERBA MATE PLAYADITO 1 KG", "PLAYADITO");

describe("barcodes", () => {
  it("canonical GTIN-13, check digit enforced, no invented codes", () => {
    expect(canonicalEan("7790742656018")).toBe("7790742656018");
    expect(canonicalEan("079400509048")).toBe("0079400509048"); // UPC-12 padded
    expect(canonicalEan("00079400509048")).toBe("0079400509048"); // GTIN-14 with a leading 0
    expect(canonicalEan("7790742656019")).toBeNull(); // wrong check digit
    expect(canonicalEan("1234")).toBeNull();
    expect(canonicalEan("77907426560AB")).toBeNull();
  });
});

describe("sizes and matching", () => {
  it("reads sizes the way people and chains write them", () => {
    expect(sizeIn("yerba de un kilo")).toEqual({ amount: 1000, unit: "g" });
    expect(sizeIn("Leche 1 L")).toEqual({ amount: 1000, unit: "ml" });
    expect(sizeIn("aceite 1,5 lts")).toEqual({ amount: 1500, unit: "ml" });
    expect(sizeIn("medio kilo de azúcar")).toEqual({ amount: 500, unit: "g" });
    expect(sizeIn("leche")).toBeNull();
  });

  const all = [MILK_WHOLE, MILK_WHOLE_500, MILK_SKIM, MILK_LACTOSE, MILK_POWDER, YERBA];

  it("whole milk 1 L: never the 500 ml, never skimmed", () => {
    const r = rankCandidates("leche entera 1 L", all).map((c) => c.product.ean);
    expect(r[0]).toBe(MILK_WHOLE.ean);
    expect(r).not.toContain(MILK_WHOLE_500.ean);
    expect(r).not.toContain(MILK_SKIM.ean);
  });

  it("a variant the request didn't name is offered as different, ranked lower", () => {
    const r = rankCandidates("leche entera 1 L", all);
    const lactose = r.find((c) => c.product.ean === MILK_LACTOSE.ean);
    expect(lactose?.extraVariant).toContain("deslactosada");
    expect(r[0]!.confidence).toBeGreaterThan(lactose!.confidence);
  });

  it("accents, case and generic words: options, not a pick", () => {
    const r = rankCandidates("LÉCHE", all);
    expect(r.length).toBeGreaterThan(1);
    expect(rankCandidates("yerba de un kilo", all).map((c) => c.product.ean)).toEqual([YERBA.ean]);
    expect(rankCandidates("fernet", all)).toEqual([]);
  });

  it("price per liter / kilo", () => {
    expect(perUnitCents(150_000, { amount: 500, unit: "ml" })).toEqual({
      cents: 300_000,
      per: "L",
    });
    expect(perUnitCents(450_000, { amount: 1000, unit: "g" })).toEqual({
      cents: 450_000,
      per: "kg",
    });
    expect(perUnitCents(100, null)).toBeNull();
  });
});

describe("regions", () => {
  it("a province by name or alias; Buenos Aires alone is asked, never assumed", () => {
    expect(regionFromWords("Córdoba")).toEqual({ kind: "one", region: "AR-X" });
    expect(regionFromWords("caba")).toEqual({ kind: "one", region: "AR-C" });
    expect(regionFromWords("AR-B")).toEqual({ kind: "one", region: "AR-B" });
    expect(regionFromWords("AMBA").kind).toBe("ambiguous");
    expect(regionFromWords("Buenos Aires").kind).toBe("ambiguous");
    expect(regionFromWords("Montevideo").kind).toBe("none");
  });
});

const price = (chain: string, listCents: number, over: Partial<ChainPrice> = {}): ChainPrice => ({
  chain: { id: chain, name: chain.toUpperCase() },
  region: "AR-C",
  listCents,
  minCents: listCents,
  branches: 10,
  promoCents: null,
  promoLabel: null,
  conditionalLabel: null,
  quoteDate: "2026-10-22",
  ...over,
});

describe("basket", () => {
  const products = new Map([MILK_WHOLE, YERBA].map((p) => [p.ean, p]));
  const prices = new Map<string, ChainPrice[]>([
    [MILK_WHOLE.ean, [price("dia", 120_050), price("coto", 130_000), price("jumbo", 140_000)]],
    // Día doesn't have the yerba: it must never look cheaper for the whole list.
    [YERBA.ean, [price("coto", 450_000), price("jumbo", 430_000)]],
  ]);

  it("quantities multiply in cents; common lines are the comparable total", () => {
    const r = compareBasket(
      "AR-C",
      [
        { key: "1", label: "dos leches", ean: MILK_WHOLE.ean, quantity: 2 },
        { key: "2", label: "yerba", ean: YERBA.ean, quantity: 1 },
        { key: "3", label: "aceite", ean: null, quantity: 1 },
      ],
      prices,
      products,
    );
    const by = Object.fromEntries(r.chains.map((c) => [c.chain.id, c]));
    expect(by.dia).toMatchObject({
      covered: 1,
      availableCents: 240_100,
      commonCents: 240_100,
      full: false,
      fullCents: null,
    });
    // Only the milk is in every chain: Día is cheapest on the comparable line…
    expect(r.commonLines).toBe(1);
    expect(r.cheapestCommon).toEqual({ chainId: "dia", savingsCents: 39_900, vsChainId: "jumbo" });
    // …while nobody has the full list (the oil has no product).
    expect(r.fullCoverage).toEqual([]);
    expect(r.lines[2]!.status).toBe("unresolved");
    expect(r.warnings).toEqual(expect.arrayContaining(["unresolved_lines", "coverage_differs"]));
  });

  it("full list only where every line is priced", () => {
    const r = compareBasket(
      "AR-C",
      [
        { key: "1", label: "leche", ean: MILK_WHOLE.ean, quantity: 1 },
        { key: "2", label: "yerba", ean: YERBA.ean, quantity: 1 },
      ],
      prices,
      products,
    );
    expect(r.fullCoverage).toEqual(
      [
        { chainId: "coto", cents: 580_000 },
        { chainId: "jumbo", cents: 570_000 },
      ].sort((a, b) => a.cents - b.cents),
    );
  });

  it("a chain filter, another province's price, zero or duplicate prices are ignored", () => {
    const odd = new Map<string, ChainPrice[]>([
      [
        MILK_WHOLE.ean,
        [
          price("dia", 0),
          price("coto", 130_000),
          price("coto", 1),
          price("jumbo", 1, { region: "AR-X" }),
        ],
      ],
    ]);
    const r = compareBasket(
      "AR-C",
      [{ key: "1", label: "leche", ean: MILK_WHOLE.ean, quantity: 1 }],
      odd,
      products,
      {
        chains: ["coto", "dia"],
      },
    );
    expect(r.chains.map((c) => [c.chain.id, c.availableCents])).toEqual([["coto", 130_000]]);
    expect(r.cheapestCommon).toBeNull(); // one chain: nothing to compare
  });

  it("conditional promos never change a total", () => {
    const promo = new Map([
      [
        MILK_WHOLE.ean,
        [price("dia", 120_000, { promoCents: 60_000, conditionalLabel: "30% con Banco X" })],
      ],
    ]);
    const r = compareBasket(
      "AR-C",
      [{ key: "1", label: "leche", ean: MILK_WHOLE.ean, quantity: 1 }],
      promo,
      products,
    );
    expect(r.chains[0]!.availableCents).toBe(120_000);
  });
});

describe("history", () => {
  it("delta-only points become a step series; nothing before the first observation", () => {
    const s = stepSeries(
      [
        { date: "2026-10-03", cents: 100_000 },
        { date: "2026-10-06", cents: 110_000 },
      ],
      "2026-10-01",
      "2026-10-07",
    );
    expect(s.map((d) => d.cents)).toEqual([
      null,
      null,
      100_000,
      100_000,
      100_000,
      110_000,
      110_000,
    ]);
    expect(s.filter((d) => d.observed).map((d) => d.date)).toEqual(["2026-10-03", "2026-10-06"]);
  });

  it("a change needs two real observations", () => {
    expect(priceChange([{ date: "2026-10-03", cents: 100_000 }])).toBeNull();
    expect(
      priceChange([
        { date: "2026-10-06", cents: 110_000 },
        { date: "2026-10-03", cents: 100_000 },
      ]),
    ).toMatchObject({ percent: 10 });
  });
});

describe("alerts", () => {
  const now = new Date("2026-10-22T15:00:00-03:00");
  const base = { ean: YERBA.ean, region: "AR-C" as const, thresholdCents: 440_000, chains: null };

  it("fires once on a crossing, holds while under, re-arms above", () => {
    const under = [price("jumbo", 430_000)];
    expect(evaluateAlert({ ...base, state: "armed" }, under, now).outcome).toBe("fire");
    expect(evaluateAlert({ ...base, state: "triggered" }, under, now).outcome).toBe("hold");
    expect(
      evaluateAlert({ ...base, state: "triggered" }, [price("jumbo", 450_000)], now).outcome,
    ).toBe("rearm");
    expect(evaluateAlert({ ...base, state: "armed" }, [price("jumbo", 450_000)], now).outcome).toBe(
      "hold",
    );
  });

  it("old data, another province or another chain never fire", () => {
    const old = [price("jumbo", 100, { quoteDate: "2026-10-01" })];
    expect(ageDays("2026-10-01", now)).toBeGreaterThan(4);
    expect(evaluateAlert({ ...base, state: "armed" }, old, now).outcome).toBe("stale");
    expect(
      evaluateAlert({ ...base, state: "armed" }, [price("jumbo", 100, { region: "AR-X" })], now)
        .outcome,
    ).toBe("no_data");
    expect(
      evaluateAlert({ ...base, chains: ["coto"], state: "armed" }, [price("jumbo", 100)], now)
        .outcome,
    ).toBe("no_data");
  });
});
