import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { economyCapability } = await import("@/application/economy-service");

/**
 * The real sources (ADR-094), only on demand: `ECONOMY_LIVE=1 npx vitest run economy-live`.
 * Checks that today's responses still fit the validated contract — never run in CI.
 */
describe.skipIf(!process.env.ECONOMY_LIVE)("live: DolarApi and ArgentinaDatos", () => {
  const cap = economyCapability();

  it("current dollar markets, each with buy, sell and a time", async () => {
    const r = await cap.currentRates();
    expect(r.value.map((q) => q.market)).toEqual(
      expect.arrayContaining(["oficial", "blue", "bolsa"]),
    );
    expect(r.value.every((q) => q.sell !== null && q.asOf !== null)).toBe(true);
  }, 20_000);

  it("a past day of the blue, its history, inflation and holidays", async () => {
    expect((await cap.rateOn("blue", "2025-03-14")).value).toMatchObject({ buy: 1220, sell: 1240 });
    const h = await cap.rateHistory("blue");
    expect(h.value.length).toBeGreaterThan(1000);
    const monthly = (await cap.inflation("monthly")).value;
    expect(monthly.at(-1)!.month >= "2026-08").toBe(true);
    const y = await cap.holidays(2026, false);
    expect(y!.value.some((x) => x.kind === "puente")).toBe(true);
    expect(await cap.holidays(2099, true)).toBeNull();
    expect((await cap.depositRates()).value.length).toBeGreaterThan(5);
    expect((await cap.countryRisk()).value.value).toBeGreaterThan(0);
  }, 30_000);
});
