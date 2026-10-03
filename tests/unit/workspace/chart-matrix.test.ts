import { describe, expect, it } from "vitest";

import { visualizationSpec } from "@/core/workspace/visualization";
import {
  histogramBins,
  planVisualization,
  timeLabel,
  type Observation,
  type PlanInput,
} from "@/core/workspace/viz-planner";

/**
 * Chart selection matrix (ADR-029): the familiar chart for the data's shape, decided in code.
 * Synthetic numbers only.
 */

const SRC = "https://quotes.example/history";
const known = new Map([
  [SRC, "Quote history"],
  ["S1", "Finance summary"],
]);
const plan = (over: Partial<PlanInput> & { observations: Observation[] }) =>
  planVisualization(
    {
      intent: "auto",
      title: "Chart",
      metric: { name: "price", unit: "USD", format: "number" },
      locale: "en",
      ...over,
    },
    known,
  );
const o = (label: string, value: number, over: Partial<Observation> = {}): Observation => ({
  label,
  value,
  source: SRC,
  ...over,
});
const type = (r: ReturnType<typeof plan>) => (r.ok ? r.spec.type : `refused: ${r.reason}`);

describe("selection matrix", () => {
  it("A. a current price alone → KPI, never a pseudo-chart", () => {
    expect(type(plan({ observations: [o("ACME", 182.4)] }))).toBe("kpi");
  });

  it("B. a price history → a conventional line, even when dates are only in the labels", () => {
    const r = plan({
      observations: [o("2025-10-03", 181), o("2025-10-01", 176.5), o("2025-10-02", 179.2)],
    });
    if (!r.ok || r.spec.type !== "line") throw new Error(type(r));
    expect(r.spec.x).toEqual(["2025-10-01", "2025-10-02", "2025-10-03"]);
    expect(r.facts.some((f) => f.startsWith("period 2025-10-01 – 2025-10-03"))).toBe(true);
    expect(
      type(plan({ observations: [o("Oct 2025", 1), o("Nov 2025", 2), o("Dec 2025", 3)] })),
    ).toBe("line");
  });

  it("C. real OHLC → candlestick; a close-only series never gets invented candles", () => {
    const ohlc = [
      o("2025-10-01", 179, { open: 176, high: 180, low: 175 }),
      o("2025-10-02", 177, { open: 179, high: 181, low: 176 }),
      o("2025-10-03", 182, { open: 177, high: 183, low: 177 }),
    ];
    expect(type(plan({ observations: ohlc }))).toBe("candlestick");
    const closes = plan({
      observations: [o("2025-10-01", 1), o("2025-10-02", 2), o("2025-10-03", 3)],
      preference: { chart: "candlestick" },
    });
    expect(type(closes)).toBe("line");
    expect(closes.ok && closes.notice).toMatch(/invent candles/);
  });

  it("D/F. spending by category, a true whole → donut; many parts → horizontal bars", () => {
    const parts = ["Rent", "Food", "Transport", "Fun"].map((l, i) =>
      o(l, [50, 25, 15, 10][i]!, { source: "S1", kind: "share" }),
    );
    expect(type(plan({ observations: parts, metric: { name: "share", format: "percent" } }))).toBe(
      "donut",
    );
    const many = Array.from({ length: 8 }, (_, i) =>
      o(`C${i}`, 12.5, { source: "S1", kind: "share" }),
    );
    expect(type(plan({ observations: many, metric: { name: "share", format: "percent" } }))).toBe(
      "hbar",
    );
  });

  it("E. a category comparison → bars; long labels or many → horizontal bars", () => {
    const short = ["Mon", "Tue", "Wed"].map((l, i) => o(l, [3, 5, 2][i]!, { source: "S1" }));
    expect(type(plan({ observations: short, metric: { name: "visits", format: "count" } }))).toBe(
      "bar",
    );
    const long = ["Investment banking division", "Retail branch network", "Asset management"].map(
      (l, i) => o(l, [3, 5, 2][i]!, { source: "S1" }),
    );
    expect(type(plan({ observations: long, metric: { name: "x", format: "count" } }))).toBe("hbar");
  });

  it("a pie for values that aren't a whole is refused; a line for categories is refused", () => {
    const independent = ["A", "B", "C"].map((l, i) => o(l, [80, 70, 90][i]!, { source: "S1" }));
    const pie = plan({ observations: independent, preference: { chart: "pie" } });
    expect(type(pie)).toBe("bar");
    expect(pie.ok && pie.notice).toMatch(/whole/);
    expect(type(plan({ observations: independent, preference: { chart: "line" } }))).toBe("bar");
  });

  it("G. several series over time → multi-line", () => {
    const r = plan({
      observations: [
        o("2024", 1, { series: "A" }),
        o("2025", 2, { series: "A" }),
        o("2024", 3, { series: "B" }),
        o("2025", 4, { series: "B" }),
      ],
    });
    expect(r.ok && r.spec.type === "line" && r.spec.series.length).toBe(2);
  });

  it("H. raw values with a frequency intent → histogram, bins computed in code", () => {
    const values = [12, 15, 18, 22, 25, 27, 31, 33, 35, 41, 48, 52];
    const r = plan({
      intent: "frequency",
      observations: values.map((v, i) => o(`t${i}`, v, { source: "S1" })),
    });
    if (!r.ok || r.spec.type !== "histogram") throw new Error(type(r));
    expect(r.spec.bins.reduce((n, b) => n + b.count, 0)).toBe(values.length);
    const bins = histogramBins([1, 2, 3, 4, 5, 10]);
    expect(bins[0]!.from).toBeLessThanOrEqual(1);
    expect(bins.at(-1)!.to).toBeGreaterThan(10);
  });

  it("I. a start plus additive changes → waterfall; the end is computed, a gap is shown", () => {
    const r = plan({
      intent: "contribution",
      observations: [
        o("Last month", 1000, { kind: "start", source: "S1" }),
        o("Salary", 400, { kind: "delta", source: "S1" }),
        o("Rent", -600, { kind: "delta", source: "S1" }),
        o("This month", 850, { kind: "end", source: "S1" }),
      ],
    });
    if (!r.ok || r.spec.type !== "waterfall") throw new Error(type(r));
    expect(r.spec.steps.map((s) => [s.label, s.value])).toEqual([
      ["Last month", 1000],
      ["Salary", 400],
      ["Rent", -600],
      ["Unexplained", 50],
      ["This month", 850],
    ]);
  });

  it("two numeric variables → scatter, with the correlation computed here", () => {
    const r = plan({
      intent: "relationship",
      xMetric: { name: "ad spend" },
      observations: [1, 2, 3, 4, 5].map((x) => o(`m${x}`, x * 2 + 1, { x, source: "S1" })),
    });
    if (!r.ok || r.spec.type !== "scatter") throw new Error(type(r));
    expect(r.facts).toContain("correlation r = 1");
  });

  it("a sourced reference keeps dots with deltas; heterogeneous data → table", () => {
    const r = plan({
      observations: [o("Bank A", 7500), o("Bank B", 7900, { source: "S1" })],
      reference: { label: "Current", value: 6800, source: SRC },
    });
    expect(type(r)).toBe("dot");
    const mixed = plan({
      observations: [
        o("Price", 7000, { unit: "points" }),
        o("Yield", 4.2, { unit: "%", source: "S1" }),
      ],
    });
    expect(type(mixed)).toBe("table");
  });

  it("labels are recognised as dates only when they are dates", () => {
    expect(timeLabel("2025-10-02")).toBe("2025-10-02");
    expect(timeLabel("Q3 2025")).toBe("2025-Q3");
    expect(timeLabel("octubre 2025")).toBe("2025-10");
    expect(timeLabel("Bank of America")).toBeNull();
    expect(timeLabel("Marzo Inversiones")).toBeNull();
  });

  it("specs refuse impossible data (bad OHLC, a waterfall without its ends)", () => {
    expect(
      visualizationSpec.safeParse({
        type: "candlestick",
        title: "x",
        x: ["a", "b"],
        ohlc: [
          { open: 1, high: 0.5, low: 0, close: 1 },
          { open: 1, high: 2, low: 0, close: 1 },
        ],
      }).success,
    ).toBe(false);
    expect(
      visualizationSpec.safeParse({
        type: "waterfall",
        title: "x",
        steps: [
          { label: "a", value: 1, kind: "delta" },
          { label: "b", value: 1, kind: "delta" },
          { label: "c", value: 2, kind: "end" },
        ],
      }).success,
    ).toBe(false);
  });
});
