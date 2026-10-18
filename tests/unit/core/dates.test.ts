import { describe, expect, it } from "vitest";

import { resolveDateOrder, shortDay, withShortDays } from "@/core/dates";

/** Short dates (ADR-078): day first unless the user chose month first. */
describe("short dates", () => {
  it("day first by default; month first when chosen; anything else untouched", () => {
    expect(shortDay("2026-10-05")).toBe("05-10");
    expect(shortDay("2026-10-05", "mdy")).toBe("10-05");
    expect(shortDay("2026-10")).toBe("2026-10");
    expect(shortDay("SETTLEMENT")).toBe("SETTLEMENT");
    expect(resolveDateOrder(undefined)).toBe("dmy");
    expect(resolveDateOrder("mdy")).toBe("mdy");
  });

  it("'Mayores gastos': table day cells and chart axes are shortened, nothing else", () => {
    const table = withShortDays({
      type: "table",
      title: "Mayores gastos 2026-10-05",
      rows: [["2026-10-05", "SETTLEMENT", "1151400"]],
    });
    expect(table.rows).toEqual([["05-10", "SETTLEMENT", "1151400"]]);
    expect(table.title).toBe("Mayores gastos 2026-10-05");
    expect(withShortDays({ type: "line", x: ["2026-10-01", "2026-10-02"] }).x).toEqual([
      "01-10",
      "02-10",
    ]);
    // Temporal data stays ISO.
    const timeline = { type: "timeline", items: [{ start: "2026-10-05" }] };
    expect(withShortDays(timeline)).toEqual(timeline);
  });
});
