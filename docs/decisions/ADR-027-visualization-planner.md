# ADR-027: Visualization Planner — deterministic chart selection with provenance

**Status:** Accepted (2026-10-02). Extends the Canvas visualization Surface (ADR on Live Canvas);
`ui.present {type:"visualization"}` stays for charts built from visible Surfaces.

## Context

ELISE answered research and finance questions with numbers in prose. When it did chart them,
the model picked the chart type and computed the numbers. That led to three problems:

- incomparable values (different units or horizons) were drawn on one scale;
- the model's own arithmetic appeared as fact;
- a web snippet looked as authoritative as audited data.

Constraints:

- No extra model round trip for planning.
- The model never generates SVG, JS or HTML.
- Never invent missing data to complete a chart.

## Decision

1. **One tool, `ui.visualize`.** The model sends:
   - its *semantic intent*;
   - a metric (name, unit, format, currency) and a horizon;
   - observations, each with a **required source**: an https URL from tool results or a Surface handle;
   - an optional sourced reference value, an optional chart preference, a sort order and exclusions.

   It may mark a value `confidence: "inferred"`. The model does not choose the final chart and
   does not compute anything.
2. **Deterministic planner** (`core/workspace/viz-planner.ts`). It is pure, with no I/O, and runs in this order:
   1. Provenance: unknown sources are refused, and unsourced or excluded points are dropped and reported in `leftOut`.
   2. Comparability: points are grouped by unit, and by horizon unless the data is temporal. Heterogeneous data falls back to a table.
   3. Shape: `single | time | range | part_of_whole | category`.
   4. Chart: the shape allows a fixed set of charts.
      - A valid preference is honoured.
      - An invalid one (a line for categories, a pie for scenarios) is replaced, and the result carries a one-sentence `notice` for the model to say.
      - Defaults: time → line; scenarios → range; close values, negatives or a reference → dot; otherwise bar or hbar; more than 12 points → table.
   5. Facts computed in code: range, median, and deltas against the reference (only when the unit matches).
   6. A typed spec, validated by the `visualizationSpec` discriminated union.
3. **New spec variants** in `core/workspace/visualization.ts`:
   - `dot` (values on one scale, with delta, source and an uncertain flag);
   - `range` (scenarios marked low/base/high, labelled "scenarios, not probabilities").

   Line, area and bar gain `reference` and `annotations`. Every spec may carry `subtitle` and up
   to 12 `sources`, and each point references a source by index.
4. **Same-turn, in-place updates.**
   - The tool returns facts and the runtime may end the turn early after a successful `ui.*` call, so no extra model call happens.
   - A *rejected* chart goes back to the model to fix.
   - The Surface id derives from intent, metric and horizon, so follow-ups like "sort them", "remove X" or "add the current value" update the same chart.
5. **Proactive but selective.** The prompt guidance asks for charts when the answer is comparable,
   temporal, scenario, share or progress numbers. Single facts, lists and prose stay as text.
   Web research calls `ui.visualize` in the same response when at least two sources give
   comparable numbers.
6. **Rendering** (`features/workspace/viz/scale-charts.tsx`):
   - Each value can be inspected with the keyboard, and its provenance shows on demand.
   - Uncertain points use a hollow mark plus a text label (not colour alone).
   - Every comparison has a table view and a sources footer.
   - Dark and light themes use the existing tokens.

## Consequences

- Chart correctness no longer depends on the model's taste. Wrong combinations are refused with a reason.
- Every number on a chart traces back to a source the user can open.
- The model must now give sources and units. When it can't, it gets a table or no chart, not a misleading one.
- New chart families need a planner rule plus a spec variant, not just prompt text.
- Validation with real web research (end to end with the model) still needs live model access. The
  planner, schema, tool and renderer are covered by unit tests with no model involved.
