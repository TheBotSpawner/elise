import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { FinanceSummary } from "@/core/capabilities/finance";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { embedSrc, isImageUrl, videoEmbed } from "@/core/workspace/media";
import {
  applyOp,
  applyOps,
  emptyWorkspace,
  WORKSPACE_LIMITS,
  type SurfaceDraft,
  type WorkspaceOp,
  type WorkspaceState,
} from "@/core/workspace/model";
import type { ActivityStep, WorkspacePort } from "@/core/workspace/port";
import { describeWorkspace, draftDefaults, parseWorkspace } from "@/core/workspace/registry";
import { financeSummaryVisuals, goalPace, visualizationSpec } from "@/core/workspace/visualization";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/** Live Canvas (ADR-021): view operations, chart specs, media and their tools. */

const AT = "2026-10-02T12:00:00.000Z";

function draft(id: string, over: Partial<SurfaceDraft> = {}): SurfaceDraft {
  const payload = { sections: [{ kind: "facts" as const, heading: "Facts", items: ["x"] }] };
  return {
    id,
    type: "summary",
    title: id,
    state: "ready",
    source: null,
    ref: null,
    payload,
    intentId: null,
    ...draftDefaults("summary", payload),
    priority: 50,
    ...over,
  };
}

const present = (s: WorkspaceState, ...ids: string[]) =>
  applyOps(
    s,
    ids.map((id) => ({ op: "present" as const, surface: draft(id), at: AT })),
  );

describe("view operations", () => {
  it("focus an item, compare two, and go back clears the view flags", () => {
    let s = present(emptyWorkspace(), "a", "b", "c");
    s = applyOp(s, { op: "focus", id: "a", item: "thread-1", at: AT });
    expect(s.focusId).toBe("a");
    expect(s.surfaces.find((x) => x.id === "a")?.focusItem).toBe("thread-1");
    s = applyOp(s, { op: "focus", id: "a", compareWith: "b", at: AT });
    expect(s.surfaces.filter((x) => x.compared).map((x) => x.id)).toEqual(["a", "b"]);
    expect(s.surfaces.find((x) => x.id === "a")?.focusItem).toBeUndefined();
    const same = applyOp(s, { op: "focus", id: "a", compareWith: "b", at: AT });
    expect(same).toBe(s);
    s = applyOp(s, { op: "focus", id: null, at: AT });
    expect(s.focusId).toBeNull();
    expect(s.surfaces.some((x) => x.compared || x.focusItem)).toBe(false);
    // A Surface that isn't there can't be focused or compared.
    expect(applyOp(s, { op: "focus", id: "zzz", at: AT })).toBe(s);
    expect(
      applyOp(s, { op: "focus", id: "a", compareWith: "zzz", at: AT }).surfaces.some(
        (x) => x.compared,
      ),
    ).toBe(false);
  });

  it("pinned Surfaces survive decay, a new intent, clear and eviction; at most three", () => {
    let s = present(emptyWorkspace(), "keep", "other");
    s = applyOp(s, { op: "pin", id: "keep", pinned: true, at: AT });
    for (let i = 0; i < WORKSPACE_LIMITS.decayTurns + 1; i++)
      s = applyOp(s, { op: "turn", at: AT });
    expect(s.surfaces.map((x) => x.id)).toEqual(["keep"]);
    s = applyOp(s, {
      op: "intent",
      intent: { id: "i2", kind: "research", description: "x", startedAt: AT },
      at: AT,
    });
    expect(s.surfaces.map((x) => x.id)).toEqual(["keep"]);
    s = applyOp(s, { op: "clear", at: AT });
    expect(s.surfaces.map((x) => x.id)).toEqual(["keep"]);
    // Eviction never takes a pinned Surface, whatever its priority.
    s = applyOps(
      s,
      Array.from({ length: 8 }, (_, i) => ({
        op: "present" as const,
        surface: draft(`n${i}`, { priority: 90 }),
        at: `2026-10-02T12:0${i}:00.000Z`,
      })),
    );
    expect(s.surfaces.some((x) => x.id === "keep")).toBe(true);
    expect(s.surfaces.length).toBe(WORKSPACE_LIMITS.maxVisible);
    // A fourth pin releases the least recently touched one.
    const ids = s.surfaces.filter((x) => x.id !== "keep").map((x) => x.id);
    for (const [i, id] of ids.slice(0, 3).entries())
      s = applyOp(s, { op: "pin", id, pinned: true, at: `2026-10-02T13:0${i}:00.000Z` });
    expect(s.surfaces.filter((x) => x.pinned).length).toBe(WORKSPACE_LIMITS.maxPinned);
    expect(s.surfaces.find((x) => x.id === "keep")?.pinned).toBeUndefined();
    s = applyOp(s, { op: "pin", id: ids[0]!, pinned: false, at: AT });
    expect(s.surfaces.find((x) => x.id === ids[0])?.pinned).toBeUndefined();
  });

  it("arranging in time order keeps every Surface and the intent", () => {
    let s = applyOp(present(emptyWorkspace(), "a"), {
      op: "intent",
      intent: { id: "i", kind: "recall", description: "today", startedAt: AT },
      at: AT,
    });
    s = present(s, "b");
    const timed = applyOp(s, { op: "arrange", order: "time", at: AT });
    expect(timed.intent).toMatchObject({ id: "i", arrangement: "time" });
    expect(timed.surfaces.length).toBe(s.surfaces.length);
    const back = applyOp(timed, { op: "arrange", order: "relevance", at: AT });
    expect(back.intent?.arrangement).toBeUndefined();
    expect(applyOp(back, { op: "arrange", order: "relevance", at: AT })).toBe(back);
    expect(describeWorkspace(timed, "UTC")).toContain("time order");
  });

  it("restores old rows without the new fields, and keeps the new ones", () => {
    const old = parseWorkspace({
      version: 3,
      turn: 1,
      intent: { id: "i", kind: "general", description: "", startedAt: AT },
      surfaces: [{ ...draft("a"), handle: "S1", turn: 1, createdAt: AT, updatedAt: AT }],
      focusId: "a",
      nextHandle: 2,
    });
    expect(old.surfaces[0]).toMatchObject({ id: "a" });
    expect(old.surfaces[0]?.pinned).toBeUndefined();
    let s = applyOp(old, { op: "pin", id: "a", pinned: true, at: AT });
    s = applyOp(s, { op: "arrange", order: "time", at: AT });
    s = applyOp(s, { op: "focus", id: "a", item: "x", at: AT });
    const round = parseWorkspace(JSON.parse(JSON.stringify(s)));
    expect(round.surfaces[0]).toMatchObject({ pinned: true, focusItem: "x" });
    expect(round.intent?.arrangement).toBe("time");
    // Anything malformed is dropped, never trusted.
    expect(
      parseWorkspace({
        surfaces: [
          { ...draft("b"), handle: "S1", turn: 0, createdAt: AT, updatedAt: AT, pinned: "yes" },
        ],
      }).surfaces,
    ).toEqual([]);
  });
});

describe("visualization specs", () => {
  it("accept supported templates and refuse the rest", () => {
    expect(
      visualizationSpec.safeParse({
        type: "bar",
        title: "Spend",
        x: ["Jul", "Aug"],
        series: [{ name: "€", values: [1, 2] }],
      }).success,
    ).toBe(true);
    // One value per label.
    expect(
      visualizationSpec.safeParse({
        type: "line",
        title: "x",
        x: ["a", "b", "c"],
        series: [{ name: "s", values: [1, 2] }],
      }).success,
    ).toBe(false);
    // No arbitrary templates, no markup or code fields.
    expect(visualizationSpec.safeParse({ type: "pie3d", title: "x" }).success).toBe(false);
    expect(
      visualizationSpec.safeParse({
        type: "kpi",
        title: "x",
        value: 1,
        svg: "<svg onload=alert(1)>",
      }).success,
    ).toBe(false);
    expect(
      visualizationSpec.safeParse({
        type: "kpi",
        title: "x",
        value: 1,
        format: { kind: "currency" },
      }).success,
    ).toBe(false);
    expect(
      visualizationSpec.safeParse({
        type: "table",
        title: "x",
        columns: [{ label: "a" }, { label: "b" }],
        rows: [["1"]],
      }).success,
    ).toBe(false);
  });

  it("finance summaries become a headline, where it went and what changed — from their numbers", () => {
    const totals = (expense: string) => ({
      currency: "EUR",
      income: "3000",
      expense,
      net: String(3000 - Number(expense)),
      incomeCount: 1,
      expenseCount: 10,
    });
    const g = (key: string, total: string) => ({
      key,
      type: "expense" as const,
      currency: "EUR",
      total,
      count: 1,
    });
    const summary = {
      period: { from: "2026-09-01", to: "2026-09-30" },
      comparison: { from: "2026-08-01", to: "2026-08-31" },
      current: {
        totals: [totals("2851")],
        byCategory: [g("Housing", "1150"), g("Restaurants", "214"), g("Groceries", "498")],
        largest: [
          {
            id: "t",
            date: "2026-09-01",
            type: "expense" as const,
            amount: "1150",
            currency: "EUR",
            label: "Rent",
            category: "Housing",
            source: "ELISE",
          },
        ],
        count: 10,
        excluded: { pending: 0, cancelled: 0 },
      },
      previous: {
        totals: [totals("3240")],
        byCategory: [g("Housing", "1150"), g("Restaurants", "452"), g("Groceries", "472")],
        largest: [],
        count: 12,
        excluded: { pending: 0, cancelled: 0 },
      },
      sources: [
        { key: "native", name: "ELISE", kind: "native", lastSyncedAt: null, included: true },
      ],
      truncated: false,
      changes: [],
      insights: [],
    } as unknown as FinanceSummary;
    const visuals = financeSummaryVisuals(summary, "es");
    expect(visuals.map((v) => v.role)).toEqual(["kpi", "categories", "change", "largest"]);
    expect(visuals[0]!.spec).toMatchObject({
      type: "kpi",
      value: 2851,
      previous: 3240,
      goodWhen: "down",
      title: "Gastado",
    });
    const change = visuals[2]!.spec;
    expect(change.type === "diverging" && change.rows[0]).toEqual({
      label: "Restaurants",
      value: -238,
    });
    for (const v of visuals) expect(visualizationSpec.safeParse(v.spec).success).toBe(true);

    // Through the presenter: charts replace the generic card; nothing invented without data.
    const drafts = surfacesFromOutcome(
      "finance.summary",
      { status: "succeeded", display: { kind: "finance_summary", summary } },
      { key: "call", locale: "en" },
    );
    expect(drafts.map((d) => d.type)).toEqual([
      "visualization",
      "visualization",
      "visualization",
      "visualization",
    ]);
    expect(drafts[0]!.priority).toBeGreaterThan(drafts[1]!.priority);
    const none = { ...summary, current: { ...summary.current, totals: [] } } as FinanceSummary;
    expect(
      surfacesFromOutcome(
        "finance.summary",
        { status: "succeeded", display: { kind: "finance_summary", summary: none } },
        { key: "c2" },
      ).map((d) => d.type),
    ).toEqual(["result"]);
  });

  it("goal pace is a straight line from creation to target, or nothing", () => {
    expect(goalPace("2026-09-01T10:00:00Z", "2026-11-01", "2026-10-01")).toBeCloseTo(49.2, 0);
    expect(goalPace("2026-09-01T10:00:00Z", null, "2026-10-01")).toBeNull();
  });
});

describe("media", () => {
  it("plays only YouTube or Vimeo by id; everything else is a link", () => {
    expect(videoEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90")).toEqual({
      provider: "youtube",
      id: "dQw4w9WgXcQ",
      start: 90,
    });
    expect(videoEmbed("https://youtu.be/dQw4w9WgXcQ")?.id).toBe("dQw4w9WgXcQ");
    expect(videoEmbed("https://vimeo.com/123456789")?.provider).toBe("vimeo");
    expect(videoEmbed("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(videoEmbed("https://evil.example/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(videoEmbed("https://www.youtube.com/watch?v=<script>")).toBeNull();
    expect(embedSrc({ provider: "youtube", id: "dQw4w9WgXcQ", start: 0 }, false)).toMatch(
      /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/,
    );
    expect(isImageUrl("https://cdn.example.com/a/photo.JPG")).toBe(true);
    expect(isImageUrl("https://cdn.example.com/page")).toBe(false);
  });
});

// ── Tools: the same view operations, by voice ────────────────────────────────

class FakeWorkspace implements WorkspacePort {
  value = emptyWorkspace();
  steps: ActivityStep[] = [];
  state() {
    return this.value;
  }
  apply(ops: WorkspaceOp[]) {
    this.value = applyOps(this.value, ops);
  }
  activity(step: ActivityStep) {
    this.steps.push(step);
  }
}

const webResults = (urls: string[]) =>
  surfacesFromOutcome(
    "web.search",
    {
      status: "succeeded",
      display: {
        kind: "web_results",
        query: "q",
        retrievedAt: AT,
        results: urls.map((url) => ({
          title: url,
          url,
          domain: new URL(url).hostname,
          snippet: "",
          publishedAt: null,
          inspected: false,
          passages: [],
        })),
      },
    } as never,
    { key: "web" },
  );

describe("ui tools for the Live Canvas", () => {
  it("focus with an item or a comparison, go back, pin and arrange", async () => {
    const ws = new FakeWorkspace();
    ws.apply([
      { op: "present", surface: draft("a"), at: AT },
      { op: "present", surface: draft("b"), at: AT },
    ]);
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws });
    const call = (name: string, args: object) => executeToolCall(ports, ctx, { name, args });
    expect(await call("ui.focus", { surface: "S1", compareWith: "S2" })).toMatchObject({
      status: "succeeded",
    });
    expect(ws.value.surfaces.every((s) => s.compared)).toBe(true);
    expect(await call("ui.focus", { surface: "none" })).toMatchObject({ status: "succeeded" });
    expect(ws.value.focusId).toBeNull();
    expect(await call("ui.pin", { surface: "S2" })).toMatchObject({ status: "succeeded" });
    expect(ws.value.surfaces.find((s) => s.id === "b")?.pinned).toBe(true);
    expect(await call("ui.arrange", { order: "time" })).toMatchObject({ status: "succeeded" });
    expect(ws.value.intent?.arrangement).toBe("time");
    expect(await call("ui.pin", { surface: "S9" })).toMatchObject({ status: "failed" });
    expect(await call("ui.arrange", { order: "x" })).toMatchObject({ status: "failed" });
  });

  it("present a chart only as a valid template grounded in visible Surfaces", async () => {
    const ws = new FakeWorkspace();
    ws.apply([{ op: "present", surface: draft("a"), at: AT }]);
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws });
    const chart = { type: "hbar", format: { kind: "number" }, rows: [{ label: "A", value: 3 }] };
    const call = (args: object) => executeToolCall(ports, ctx, { name: "ui.present", args });
    expect(await call({ type: "visualization", title: "Chart", chart })).toMatchObject({
      status: "failed",
      error: { code: "VALIDATION_ERROR" },
    });
    expect(
      await call({
        type: "visualization",
        title: "Chart",
        chart: { type: "html", html: "<b/>" },
        basis: ["S1"],
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      await call({ type: "visualization", title: "Chart", chart, basis: ["S1"] }),
    ).toMatchObject({
      status: "succeeded",
    });
    const viz = ws.value.surfaces.find((s) => s.type === "visualization");
    expect(viz?.payload).toMatchObject({ spec: { type: "hbar", title: "Chart" } });
  });

  it("present media only from URLs the workspace already holds", async () => {
    const ws = new FakeWorkspace();
    const yt = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    ws.apply(
      webResults([yt, "https://example.com/page"]).map((surface) => ({
        op: "present" as const,
        surface,
        at: AT,
      })),
    );
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws });
    const call = (media: object) =>
      executeToolCall(ports, ctx, {
        name: "ui.present",
        args: { type: "media", title: "Video", media },
      });
    expect(
      await call({ kind: "video", items: [{ url: "https://youtu.be/aaaaaaaaaaa", title: "x" }] }),
    ).toMatchObject({
      status: "failed",
    });
    expect(
      await call({ kind: "video", items: [{ url: "https://example.com/page", title: "x" }] }),
    ).toMatchObject({
      status: "failed",
    });
    expect(
      await call({ kind: "image", items: [{ url: "https://example.com/page", title: "x" }] }),
    ).toMatchObject({
      status: "failed",
    });
    expect(await call({ kind: "video", items: [{ url: yt, title: "Review" }] })).toMatchObject({
      status: "succeeded",
    });
    expect(ws.value.surfaces.find((s) => s.type === "media")?.payload).toMatchObject({
      kind: "video",
      items: [{ url: yt, domain: "youtube.com" }],
    });
  });
});
