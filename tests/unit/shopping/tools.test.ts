import { describe, expect, it } from "vitest";

import type { NativeList } from "@/core/capabilities/lists";
import { sizeIn, type ChainPrice, type Product, type Region } from "@/core/shopping/model";
import {
  alertsTool,
  compareTool,
  findProductTool,
  linkItemTool,
  setRegionTool,
} from "@/core/tools/shopping";
import { shoppingPayload } from "@/core/workspace/registry";

import { memoryShoppingData, shoppingEnv } from "../../fixtures/shopping";

/**
 * ADR-111: the tools over fixtures. A province is asked, never assumed; names give real options,
 * never a pick; a list's comparison is honest about what couldn't be compared; the button and the
 * chat call the same tool.
 */

const P = (ean: string, name: string): Product => ({ ean, name, brand: null, size: sizeIn(name) });
const MILK = P("7790742656018", "LECHE ENTERA LA SERENISIMA 1 L");
const MILK_LACT = P("7790742656049", "LECHE ENTERA DESLACTOSADA LA SERENISIMA 1 L");
const YERBA = P("7790387013504", "YERBA MATE PLAYADITO 1 KG");
const price = (chain: string, name: string, listCents: number): ChainPrice => ({
  chain: { id: chain, name },
  region: "AR-C",
  listCents,
  minCents: listCents,
  branches: 12,
  promoCents: null,
  promoLabel: null,
  conditionalLabel: null,
  quoteDate: "2026-10-22",
});
const PRICES = new Map<Region, Map<string, ChainPrice[]>>([
  [
    "AR-C",
    new Map([
      [
        MILK.ean,
        [price("15-1", "Supermercados DIA", 120_000), price("12-1", "COTO CICSA", 130_000)],
      ],
      [MILK_LACT.ean, [price("15-1", "Supermercados DIA", 150_000)]],
      [YERBA.ean, [price("12-1", "COTO CICSA", 450_000)]],
    ]),
  ],
]);
const data = () => memoryShoppingData([MILK, MILK_LACT, YERBA], PRICES);
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;
const shown = (r: unknown) => (r as { display?: { shopping: unknown } }).display?.shopping;

const LIST: NativeList = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Compras",
  description: null,
  updatedAt: "2026-10-22T00:00:00Z",
  items: [
    {
      id: "21111111-1111-4111-8111-111111111111",
      content: "2 leches",
      checked: false,
      position: 1,
      notes: null,
      labels: [],
    },
    {
      id: "31111111-1111-4111-8111-111111111111",
      content: "yerba",
      checked: false,
      position: 2,
      notes: null,
      labels: [],
    },
    {
      id: "41111111-1111-4111-8111-111111111111",
      content: "pilas",
      checked: true,
      position: 3,
      notes: null,
      labels: [],
    },
  ] as unknown as NativeList["items"],
};

describe("region", () => {
  it("no saved province → ask once (never Buenos Aires by default); saving is explicit", async () => {
    const s = shoppingEnv(data());
    const r = out(await findProductTool.run({ query: "leche entera 1 L" }, s.env));
    expect(r.needsRegion).toBe(true);
    expect(String(r.instructions)).toMatch(/Never assume Buenos Aires/);
    expect(out(await setRegionTool.run({ place: "Buenos Aires" }, s.env)).saved).toBe(false);
    expect(out(await setRegionTool.run({ place: "CABA" }, s.env)).saved).toBe(true);
    expect(s.region()).toBe("AR-C");
  });

  it("a province with no data says so (never prices from elsewhere)", async () => {
    const s = shoppingEnv(data(), { region: "AR-X" });
    expect(out(await findProductTool.run({ query: MILK.ean }, s.env)).available).toBe(false);
  });
});

describe("finding products", () => {
  it("a barcode is exact: prices per chain, cheapest first, valid surface", async () => {
    const s = shoppingEnv(data(), { region: "AR-C" });
    const r = await findProductTool.run({ query: MILK.ean }, s.env);
    expect(out(r).match).toBe("barcode");
    const p = shoppingPayload.parse(shown(r));
    expect(p.chains.map((c) => [c.name, c.listCents, c.perUnit])).toEqual([
      ["Supermercados DIA", 120_000, { cents: 120_000, per: "L" }],
      ["COTO CICSA", 130_000, { cents: 130_000, per: "L" }],
    ]);
    expect(p.regionName).toBe("Ciudad de Buenos Aires");
  });

  it("words give real options; the different variant is flagged, nothing is picked", async () => {
    const s = shoppingEnv(data(), { region: "AR-C" });
    const r = await findProductTool.run({ query: "leche entera 1 L" }, s.env);
    const o = out(r);
    expect(o.match).toBe("name");
    const options = o.options as { ean: string; differs?: string[] }[];
    expect(options[0]!.ean).toBe(MILK.ean);
    expect(options.find((x) => x.ean === MILK_LACT.ean)?.differs).toContain("deslactosada");
    expect(shoppingPayload.parse(shown(r)).candidates).toHaveLength(2);
  });

  it("nothing like it → says so; never an invented product", async () => {
    const s = shoppingEnv(data(), { region: "AR-C" });
    expect(out(await findProductTool.run({ query: "fernet 750" }, s.env)).found).toBe(false);
  });
});

describe("comparing a list", () => {
  it("unlinked items aren't compared; options are offered; checked items are left out", async () => {
    const s = shoppingEnv(data(), { region: "AR-C", lists: [LIST] });
    const r = await compareTool.run({ list: "compras" }, s.env);
    const o = out(r);
    expect(o.requested).toBe(2);
    expect(o.withoutProduct).toEqual(["2 leches", "yerba"]);
    expect(o.cheapestForCommonProducts).toBeNull();
    const p = shoppingPayload.parse(shown(r));
    expect(p.candidates.map((c) => c.forLine)).toEqual(
      expect.arrayContaining(["2 leches", "yerba"]),
    );
  });

  it("after the person links them: honest totals — Día lacks the yerba, so only the milk compares", async () => {
    const s = shoppingEnv(data(), { region: "AR-C", lists: [LIST] });
    await linkItemTool.run(
      { list: "Compras", item: "2 leches", ean: MILK.ean, quantity: 2 },
      s.env,
    );
    await linkItemTool.run({ list: "Compras", item: "yerba", ean: YERBA.ean }, s.env);
    const o = out(await compareTool.run({ list: "Compras" }, s.env));
    expect(o.inEveryChain).toBe(1);
    expect(o.cheapestForCommonProducts).toEqual({
      chain: "Supermercados DIA",
      saves: "$200",
      vs: "COTO CICSA",
    });
    expect(o.chains).toEqual([
      { chain: "COTO CICSA", inCommon: "$2.600", has: "2/2", fullList: "$7.100" },
      { chain: "Supermercados DIA", inCommon: "$2.400", has: "1/2" },
    ]);
    // Only Coto has the whole list.
    expect(o.fullListCheapest).toBe("COTO CICSA");
  });

  it("a chain filter, and a chain without data named as such", async () => {
    const s = shoppingEnv(data(), { region: "AR-C" });
    const o = out(
      await compareTool.run(
        { items: [{ ean: MILK.ean, quantity: 1 }], chains: ["Coto", "Changomas"] },
        s.env,
      ),
    );
    expect(o.chains).toEqual([
      { chain: "COTO CICSA", inCommon: "$1.300", has: "1/1", fullList: "$1.300" },
    ]);
    expect(o.chainsWithoutData).toEqual(["Changomas"]);
  });

  it("linking never takes a code that isn't a real product (unless the person typed the barcode)", async () => {
    const s = shoppingEnv(data(), { region: "AR-C", lists: [LIST] });
    await expect(
      linkItemTool.run({ list: "Compras", item: "yerba", ean: "7790000000003" }, s.env),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.links.size).toBe(0);
  });
});

describe("alerts", () => {
  it("one product, a price in pesos, the person's province", async () => {
    const s = shoppingEnv(data(), { region: "AR-C" });
    const o = out(await alertsTool.run({ action: "create", ean: YERBA.ean, below: 5000 }, s.env));
    expect(o).toMatchObject({ created: true, below: "$5.000", today: "$4.500 en COTO CICSA" });
    expect(s.alerts[0]).toMatchObject({ thresholdCents: 500_000, region: "AR-C", chains: null });
    expect(out(await alertsTool.run({ action: "create", below: 5000 }, s.env)).created).toBe(false);
  });
});
