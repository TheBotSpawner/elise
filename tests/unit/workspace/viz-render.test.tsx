// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { visualizationSpec } from "@/core/workspace/visualization";
import { Visualization } from "@/features/workspace/viz/visualization";
import { I18nProvider } from "@/lib/i18n/client";

const dot = visualizationSpec.parse({
  type: "dot",
  title: "Year-end targets",
  subtitle: "2026 · index points",
  sources: [
    { title: "Bank A outlook", url: "https://bank-a.example/outlook" },
    { title: "Index quote", url: "https://quotes.example/index" },
  ],
  rows: [
    { label: "Bank A", value: 7500, delta: 700, deltaPct: 10.3, source: 0 },
    { label: "Bank C", value: 7900, delta: 1100, deltaPct: 16.2, source: 0, uncertain: true },
  ],
  reference: { label: "Actual", value: 6800, source: 1 },
});

const range = visualizationSpec.parse({
  type: "range",
  title: "Scenarios",
  scenarios: [
    { label: "Bear", value: 6500, kind: "low" },
    { label: "Base", value: 7300, kind: "base" },
    { label: "Bull", value: 7900, kind: "high" },
  ],
});

const view = (spec: Parameters<typeof Visualization>[0]["spec"], dark = false) =>
  render(
    <div className={dark ? "dark" : undefined}>
      <I18nProvider locale="en">
        <Visualization spec={spec} size="large" />
      </I18nProvider>
    </div>,
  );

describe("comparison charts", () => {
  it("dots: accessible values with deltas, provenance on demand, weak points labelled", () => {
    view(dot);
    expect(screen.getByText("2026 · index points")).toBeTruthy();
    const a = screen.getByRole("button", {
      name: /Bank A: 7,500, \+10.3% vs Actual\. Source: Bank A outlook/,
    });
    expect(screen.getByRole("button", { name: /Bank C.*weakly evidenced/ })).toBeTruthy();
    fireEvent.click(a);
    expect(screen.getAllByRole("link", { name: /Bank A outlook/ }).length).toBeGreaterThan(0);
    // Sources are always listed; the reference shows its own source.
    expect(screen.getAllByRole("link", { name: /Index quote/ }).length).toBeGreaterThan(0);
  });

  it("every comparison has a table view with each value's source", () => {
    view(dot, true);
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("Actual (Reference)");
    expect(table.textContent).toContain("7,900 (+16.2%)");
    expect(table.textContent).toContain("Bank A outlook");
  });

  it("ranges: the span and scenarios, explicitly not probabilities", () => {
    view(range);
    expect(
      screen.getByRole("img", { name: /Range 6,500–7,900: Bear 6,500, Base 7,300, Bull 7,900/ }),
    ).toBeTruthy();
    expect(screen.getByText("Scenarios, not probabilities.")).toBeTruthy();
  });
});

const schedule = (view: "timeline" | "calendar" | "agenda" | "intervals", over = {}) =>
  visualizationSpec.parse({
    type: "temporal",
    title: "Course schedule",
    view,
    today: "2026-08-01",
    sources: [{ title: "Syllabus · p. 2", url: "/knowledge/items/doc-1", excerpt: "Finals on…" }],
    events: [
      { title: "Classes start", start: "2026-08-03", kind: "start", source: 0 },
      { title: "Midterm", start: "2026-08-20", kind: "exam", importance: "high", source: 0 },
      { title: "Finals", start: "2026-08-24", end: "2026-08-25", kind: "exam", source: 0 },
      { title: "Term ends", start: "2026-08-28", kind: "end", source: 0, conflict: true },
    ],
    ...over,
  });

describe("temporal views", () => {
  it("timeline: ranges stay ranges, the source passage opens on demand, conflicts are labelled", () => {
    view(schedule("timeline"));
    expect(screen.getByText(/^Aug 24\s–\s25$/)).toBeTruthy();
    expect(screen.getByText("Sources disagree")).toBeTruthy();
    expect(screen.queryByText("Finals on…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Midterm/ }));
    expect(screen.getByText("Finals on…")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Syllabus · p. 2" }).getAttribute("href")).toBe(
      "/knowledge/items/doc-1",
    );
  });

  it("calendar: a month grid whose dated days name their events", () => {
    view(schedule("calendar"));
    expect(screen.getByRole("grid", { name: /August 2026/ })).toBeTruthy();
    expect(screen.getByRole("gridcell", { name: /Midterm/ })).toBeTruthy();
    // A two-day range marks both days.
    expect(screen.getAllByRole("gridcell", { name: /Finals/ })).toHaveLength(2);
  });

  it("a focus shows only its events and can reveal the rest", () => {
    view(schedule("timeline", { focus: { kinds: ["exam"] } }));
    expect(screen.queryByText("Classes start")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 4" }));
    expect(screen.getByText("Classes start")).toBeTruthy();
  });

  it("agenda and intervals render in dark mode without errors", () => {
    view(
      schedule("agenda", {
        events: [
          { title: "Standup", start: "2026-08-03T09:00", end: "2026-08-03T09:15", kind: "meeting" },
          { title: "Review", start: "2026-08-03T16:30", kind: "meeting" },
        ],
        sources: undefined,
      }),
      true,
    );
    expect(screen.getByText("09:00–09:15")).toBeTruthy();
    view(schedule("intervals"), true);
    expect(screen.getAllByText("Finals").length).toBeGreaterThan(0);
  });
});

// jsdom has no layout: every observed chart gets a fixed 600 × 200 box.
globalThis.ResizeObserver ??= class {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 600, height: 200 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

describe("conventional charts", () => {
  it("donut: every part labelled with its share; the table view lists them", () => {
    view(
      visualizationSpec.parse({
        type: "donut",
        title: "Spending",
        rows: [
          { label: "Rent", value: 600 },
          { label: "Food", value: 300 },
          { label: "Fun", value: 100 },
        ],
      }),
    );
    expect(screen.getByRole("img", { name: /Rent 600 \(60%\), Food 300 \(30%\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("candlestick, waterfall, histogram and scatter expose each datapoint by name", () => {
    view(
      visualizationSpec.parse({
        type: "candlestick",
        title: "ACME",
        x: ["Oct 1", "Oct 2"],
        ohlc: [
          { open: 10, high: 12, low: 9, close: 11 },
          { open: 11, high: 11.5, low: 10, close: 10.5 },
        ],
      }),
    );
    expect(
      screen.getByRole("img", { name: /Oct 1: Open 10, High 12, Low 9, Close 11/ }),
    ).toBeTruthy();
    view(
      visualizationSpec.parse({
        type: "waterfall",
        title: "Change",
        steps: [
          { label: "Start", value: 100, kind: "start" },
          { label: "Salary", value: 40, kind: "delta" },
          { label: "End", value: 140, kind: "end" },
        ],
      }),
      true,
    );
    expect(screen.getByRole("img", { name: "Salary: +40" })).toBeTruthy();
    view(
      visualizationSpec.parse({
        type: "histogram",
        title: "Amounts",
        bins: [
          { from: 0, to: 10, count: 3 },
          { from: 10, to: 20, count: 5 },
        ],
      }),
    );
    expect(screen.getByRole("img", { name: "10–20: 5" })).toBeTruthy();
    view(
      visualizationSpec.parse({
        type: "scatter",
        title: "Spend vs sales",
        xLabel: "Spend",
        yLabel: "Sales",
        points: [
          { label: "Jan", x: 1, y: 2 },
          { label: "Feb", x: 2, y: 4 },
          { label: "Mar", x: 3, y: 5 },
        ],
      }),
    );
    expect(screen.getByRole("img", { name: "Feb: Spend 2, Sales 4" })).toBeTruthy();
  });
});

describe("line chart", () => {
  const prices = visualizationSpec.parse({
    type: "line",
    title: "ACME",
    x: ["Oct 1", "Oct 2", "Oct 3", "Oct 4"],
    series: [{ name: "Close", values: [7400, 7650, 7900, 8100] }],
  });

  it("a price series gets an axis fitted to it, not a flat line on a zero baseline", () => {
    const { container } = view(prices);
    const ticks = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(ticks).toContain("7,000");
    expect(ticks).not.toContain("0");
  });

  it("datapoints are reachable with the keyboard", () => {
    view(prices);
    const chart = screen.getAllByRole("img").find((el) => el.tagName === "svg")!;
    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip").textContent).toContain("8,100");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getByRole("tooltip").textContent).toContain("7,400");
  });
});
