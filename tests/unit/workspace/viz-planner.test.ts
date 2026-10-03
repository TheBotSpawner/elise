import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { runElise } from "@/core/agents/runtime";
import { WORKSPACE_TOOLS } from "@/core/tools/workspace";
import {
  applyOps,
  emptyWorkspace,
  type WorkspaceOp,
  type WorkspaceState,
} from "@/core/workspace/model";
import type { WorkspacePort } from "@/core/workspace/port";
import {
  planVisualization,
  timeKey,
  type Observation,
  type PlanInput,
} from "@/core/workspace/viz-planner";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

/**
 * Visualization Planner (ADR-027): the data's shape picks the chart, never the wording; every
 * point keeps its source; incomparable values never share a scale. Synthetic data only.
 */

const A = "https://bank-a.example/outlook";
const B = "https://bank-b.example/strategy";
const C = "https://bank-c.example/note";
const NOW = "https://quotes.example/index";
const known = new Map([
  [A, "Bank A outlook"],
  [B, "Bank B strategy"],
  [C, "Bank C note"],
  [NOW, "Index quote"],
  ["S3", "Finance summary"],
]);

const plan = (over: Partial<PlanInput> & { observations: Observation[] }) =>
  planVisualization(
    {
      intent: "auto",
      title: "Targets",
      metric: { name: "year-end target", unit: "points", format: "number" },
      horizon: "2026 year-end",
      locale: "es",
      ...over,
    },
    known,
  );

const targets: Observation[] = [
  { label: "Bank A", value: 7500, source: A },
  { label: "Bank B", value: 7500, source: B },
  { label: "Bank C", value: 7900, source: C },
];

describe("data shape decides the chart", () => {
  it("close categorical values → dots; with a sourced reference, deltas computed in code", () => {
    const r = plan({
      observations: targets,
      reference: { label: "Actual", value: 6800, source: NOW },
    });
    expect(r.ok && r.shape).toBe("category");
    if (!r.ok || r.spec.type !== "dot") throw new Error("expected dots");
    expect(r.spec.rows.map((x) => [x.label, x.deltaPct])).toEqual([
      ["Bank A", 10.3],
      ["Bank B", 10.3],
      ["Bank C", 16.2],
    ]);
    expect(r.spec.reference).toMatchObject({ label: "Actual", value: 6800 });
    expect(r.facts).toContain("rango 7.500–7.900");
    expect(
      r.facts.some((f) => f.includes("+10,3% a +16,2%") || f.includes("+10.3% a +16.2%")),
    ).toBe(true);
  });

  it("a few short categories from one source → vertical bars, sorted on request; many → table", () => {
    const spend: Observation[] = ["Food", "Rent", "Fun", "Taxes", "Gym"].map((label, i) => ({
      label,
      value: [300, 1200, 80, 450, 40][i]!,
      source: "S3",
    }));
    const r = plan({
      observations: spend,
      metric: { name: "spend", format: "currency", currency: "USD" },
      horizon: undefined,
      preference: { sort: "desc" },
    });
    if (!r.ok || r.spec.type !== "bar") throw new Error(`expected bar, got ${r.ok && r.spec.type}`);
    expect(r.spec.x).toEqual(["Rent", "Taxes", "Food", "Fun", "Gym"]);
    const many = plan({
      observations: Array.from({ length: 14 }, (_, i) => ({
        label: `C${i}`,
        value: i * 10 + 5,
        source: "S3",
      })),
      horizon: undefined,
    });
    expect(many.ok && many.spec.type).toBe("table");
  });

  it("points in time → a chronological line, gaps stay gaps", () => {
    const r = plan({
      title: "Index",
      horizon: undefined,
      observations: [
        { label: "2026", value: 7500, time: "2026", source: A },
        { label: "2024", value: 5880, time: "2024", source: NOW },
        { label: "2025", value: 6800, time: "2025", source: NOW },
      ],
    });
    if (!r.ok || r.spec.type !== "line") throw new Error("expected line");
    expect(r.spec.x).toEqual(["2024", "2025", "2026"]);
    expect(r.spec.series[0]!.values).toEqual([5880, 6800, 7500]);
    const gaps = plan({
      horizon: undefined,
      observations: [
        { label: "a", value: 1, time: "2025-01", series: "X", source: "S3" },
        { label: "b", value: 2, time: "2025-03", series: "X", source: "S3" },
        { label: "c", value: 3, time: "2025-03", series: "Y", source: "S3" },
      ],
    });
    if (!gaps.ok || gaps.spec.type !== "line") throw new Error("expected line");
    expect(gaps.spec.series.find((s) => s.name === "Y")!.values).toEqual([null, 3]);
    expect(timeKey("2025-Q4")).toBeLessThan(timeKey("2026"));
  });

  it("scenarios → a range, never a pie", () => {
    const r = plan({
      observations: [
        { label: "Bear", value: 6500, kind: "low", source: A },
        { label: "Base", value: 7300, kind: "base", source: A },
        { label: "Bull", value: 7900, kind: "high", source: A },
      ],
      preference: { chart: "pie" },
    });
    expect(r.ok && r.shape).toBe("range");
    expect(r.ok && r.spec.type).toBe("range");
    expect(r.ok && r.notice).toMatch(/torta/);
  });

  it("shares of a true whole → donut; one value → KPI", () => {
    const share = plan({
      intent: "distribution",
      horizon: undefined,
      metric: { name: "share", format: "percent" },
      observations: [
        { label: "Stocks", value: 60, source: "S3" },
        { label: "Bonds", value: 30, source: "S3" },
        { label: "Cash", value: 10, source: "S3" },
      ],
    });
    expect(share.ok && share.spec.type).toBe("donut");
    const one = plan({ observations: [targets[0]!] });
    expect(one.ok && one.spec.type).toBe("kpi");
  });

  it("a line for unordered categories is refused with a reason", () => {
    const r = plan({ observations: targets, preference: { chart: "line" } });
    expect(r.ok && r.spec.type).not.toBe("line");
    expect(r.ok && r.notice).toMatch(/categorías/);
    const bars = plan({ observations: targets, preference: { chart: "bar" } });
    expect(bars.ok && bars.spec.type).toBe("bar");
  });
});

describe("evidence rules", () => {
  it("unsourced points are never drawn; nothing sourced → no chart", () => {
    const r = plan({
      observations: [
        ...targets,
        { label: "Rumor", value: 9000, source: "https://unknown.example" },
      ],
    });
    expect(r.ok && r.dropped).toEqual([{ label: "Rumor", reason: "unsourced" }]);
    expect(plan({ observations: [{ label: "x", value: 1 }] }).ok).toBe(false);
  });

  it("different horizons or units never share a scale", () => {
    const r = plan({
      observations: [
        ...targets,
        { label: "Bank D", value: 7700, horizon: "next 12 months", source: A },
      ],
    });
    expect(r.ok && r.dropped).toEqual([{ label: "Bank D", reason: "not_comparable" }]);
    const mixed = plan({
      horizon: undefined,
      observations: [
        { label: "Price", value: 7000, unit: "points", source: A },
        { label: "Yield", value: 4.2, unit: "%", source: B },
      ],
    });
    expect(mixed.ok && mixed.shape).toBe("heterogeneous");
    expect(mixed.ok && mixed.spec.type).toBe("table");
  });

  it("every point keeps its source; weak evidence is marked", () => {
    const r = plan({
      observations: [...targets.slice(0, 2), { ...targets[2]!, confidence: "inferred" }],
    });
    // Research values from several sources: horizontal bars, each with its source.
    if (!r.ok || r.spec.type !== "hbar") throw new Error("expected hbar");
    expect(r.spec.sources!.map((s) => s.url)).toEqual([A, B, C]);
    expect(r.spec.rows.map((x) => x.source)).toEqual([0, 1, 2]);
    expect(r.spec.rows[2]!.uncertain).toBe(true);
  });

  it("a reference with another unit is not used for deltas", () => {
    const r = plan({
      observations: targets,
      reference: { label: "Actual", value: 6.8, unit: "thousand points", source: NOW },
    });
    if (!r.ok) throw new Error(r.reason);
    expect("reference" in r.spec && r.spec.reference).toBeFalsy();
    expect(r.dropped).toContainEqual({ label: "Actual", reason: "not_comparable" });
  });
});

// ── ui.visualize: same-turn presentation and updates ─────────────────────────

class FakeWorkspace implements WorkspacePort {
  state_: WorkspaceState = emptyWorkspace();
  ops: WorkspaceOp[] = [];
  state() {
    return this.state_;
  }
  apply(ops: WorkspaceOp[]) {
    this.ops.push(...ops);
    this.state_ = applyOps(this.state_, ops);
    return this.state_.version;
  }
  activity() {}
}

function researched() {
  const ws = new FakeWorkspace();
  ws.apply([
    {
      op: "present",
      at: "2026-10-02T10:00:00Z",
      surface: {
        id: "r1",
        type: "links",
        title: "Research",
        state: "ready",
        priority: 50,
        size: "medium",
        source: null,
        ref: null,
        payload: {
          links: [
            { title: "Bank A outlook", url: A, domain: "bank-a.example" },
            { title: "Bank B strategy", url: B, domain: "bank-b.example" },
            { title: "Bank C note", url: C, domain: "bank-c.example" },
          ],
        },
        actions: [],
        intentId: null,
      },
    } as never,
  ]);
  return ws;
}

const args = (over: Record<string, unknown> = {}) => ({
  intent: "compare",
  title: "Year-end targets",
  metric: { name: "year-end target", unit: "points" },
  horizon: "2026 year-end",
  observations: targets,
  ...over,
});

describe("ui.visualize", () => {
  it("presents a large, high-priority chart from sourced evidence and updates it in place", async () => {
    const ws = researched();
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws });
    const out = await executeToolCall(ports, ctx, { name: "ui.visualize", args: args() });
    expect(out).toMatchObject({
      status: "succeeded",
      output: { shown: "hbar", shape: "category" },
    });
    const chart = ws.state().surfaces.find((s) => s.type === "visualization")!;
    expect(chart).toMatchObject({ size: "large", priority: 82 });
    // "Sacá Bank B y ordenalos": same metric and horizon → the same Surface.
    await executeToolCall(ports, ctx, {
      name: "ui.visualize",
      args: args({ exclude: ["Bank B"], sort: "desc" }),
    });
    const charts = ws.state().surfaces.filter((s) => s.type === "visualization");
    expect(charts).toHaveLength(1);
    expect(
      (charts[0]!.payload as { spec: { rows: { label: string }[] } }).spec.rows.map((r) => r.label),
    ).toEqual(["Bank C", "Bank A"]);
  });

  it("numbers whose sources aren't on screen are refused", async () => {
    const { ports } = makePorts([]);
    const out = await executeToolCall(ports, makeCtx({ workspace: new FakeWorkspace() }), {
      name: "ui.visualize",
      args: args(),
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
  });

  it("same turn: answer + chart in one response ends the turn — but a rejected chart goes back to the model", async () => {
    const { ports } = makePorts([]);
    ports.registry.register(...WORKSPACE_TOOLS.filter((t) => !ports.registry.get(t.name)));
    const done = {
      type: "completed" as const,
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const call = (a: unknown) => ({
      type: "tool_call" as const,
      callId: "v",
      name: "ui.visualize",
      arguments: JSON.stringify(a),
    });
    const ok = new ScriptedAI([
      () => [
        { type: "text_delta", delta: "Se concentran entre 7.500 y 7.900." },
        call(args()),
        done,
      ],
    ]);
    for await (const _ of runElise({
      ai: ok,
      ports,
      ctx: makeCtx({ workspace: researched() }),
      instructions: "",
      input: [],
      tools: WORKSPACE_TOOLS,
    }))
      void _;
    expect(ok.requests).toHaveLength(1);
    const bad = new ScriptedAI([
      () => [{ type: "text_delta", delta: "Ahí va." }, call(args()), done],
      () => [{ type: "text_delta", delta: "No tengo fuentes verificables para graficarlo." }, done],
    ]);
    for await (const _ of runElise({
      ai: bad,
      ports,
      ctx: makeCtx({ workspace: new FakeWorkspace() }),
      instructions: "",
      input: [],
      tools: WORKSPACE_TOOLS,
    }))
      void _;
    expect(bad.requests).toHaveLength(2);
  });
});
