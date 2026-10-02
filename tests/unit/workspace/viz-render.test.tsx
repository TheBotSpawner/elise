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
