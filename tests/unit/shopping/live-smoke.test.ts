import { describe, expect, it } from "vitest";

import { compareTool, findProductTool } from "@/core/tools/shopping";
import { shoppingPayload } from "@/core/workspace/registry";

import { realShoppingData, shoppingEnv } from "../../fixtures/shopping";

/**
 * ADR-111 live smoke: the tools over a REAL SEPA day measured locally
 * (`scripts/sepa-measure.ts <sepa_dia.zip> <dir>`), no database. Skipped unless SEPA_SMOKE_DIR
 * points at that directory — it never passes on fixtures alone.
 */
const dir = process.env.SEPA_SMOKE_DIR;
const data = dir ? realShoppingData(dir) : null;
const out = (r: unknown) => (r as { output: Record<string, unknown> }).output;

describe.skipIf(!data)("live SEPA day", () => {
  it("names give real products and a real basket compares in CABA", async () => {
    const s = shoppingEnv(data!, { region: "AR-C" });
    const picks: string[] = [];
    for (const q of ["leche entera 1 L", "yerba mate 1 kg", "aceite de girasol 1,5 L"]) {
      const r = out(await findProductTool.run({ query: q }, s.env));
      const options = (r.options ?? []) as {
        ean: string;
        name: string;
        from: string;
        differs?: string[];
      }[];
      console.log(
        `\n${q}:`,
        options
          .slice(0, 3)
          .map((o) => `${o.name} ${o.from}${o.differs ? ` (${o.differs.join(",")})` : ""}`),
      );
      expect(options.length).toBeGreaterThan(0);
      picks.push(options.find((o) => !o.differs)?.ean ?? options[0]!.ean);
    }
    const r = await compareTool.run(
      { items: picks.map((ean, i) => ({ ean, quantity: i === 0 ? 2 : 1 })) },
      s.env,
    );
    const o = out(r);
    console.log(
      "\nbasket:",
      JSON.stringify(
        {
          date: o.dataDate,
          common: o.inEveryChain,
          cheapest: o.cheapestForCommonProducts,
          chains: o.chains,
        },
        null,
        1,
      ),
    );
    expect(
      shoppingPayload.safeParse((r as { display: { shopping: unknown } }).display.shopping).success,
    ).toBe(true);
    expect((o.chains as unknown[]).length).toBeGreaterThan(1);
  });
});
