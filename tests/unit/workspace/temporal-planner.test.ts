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
import { distinctDates, representationHint } from "@/core/workspace/representation";
import {
  matches,
  parseWhen,
  planTemporal,
  type TemporalEventInput,
  type TemporalPlanInput,
} from "@/core/workspace/temporal-planner";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

/**
 * Temporal planner (ADR-028): density picks the view, dates are validated in code, every event
 * keeps its source, and disagreeing sources are surfaced. Synthetic schedules only — no real
 * institution, course or date values.
 */

const doc = { title: "Programa · p. 2", url: "/knowledge/items/doc-1", excerpt: "Inicio 2 mar…" };
const other = { title: "Calendario web", url: "https://uni.example/cal" };
const ev = (title: string, start: string, over: Partial<TemporalEventInput> = {}) =>
  ({ title, start, source: doc, ...over }) as TemporalEventInput;

const plan = (events: TemporalEventInput[], over: Partial<TemporalPlanInput> = {}) =>
  planTemporal({
    title: "Cronograma",
    events,
    view: "auto",
    today: "2026-06-01",
    explicit: false,
    locale: "es",
    ...over,
  });

const sparse = [
  ev("Inicio de clases", "2026-03-02", { kind: "start" }),
  ev("Segundo cuatrimestre", "2026-08-03", { kind: "start" }),
  ev("Turno de finales", "2026-09-21", { end: "2026-09-22", kind: "exam" }),
  ev("Cierre", "2026-11-27", { kind: "end" }),
];

describe("dates are validated in code", () => {
  it("accepts days, local times and whole months; rejects impossible dates", () => {
    expect(parseWhen("2026-03-02")?.precision).toBe("day");
    expect(parseWhen("2026-03-02T09:30")?.precision).toBe("time");
    expect(parseWhen("2026-03")?.precision).toBe("month");
    expect(parseWhen("2026-02-30")).toBeNull();
    expect(parseWhen("2026-13-01")).toBeNull();
    expect(parseWhen("2 de marzo")).toBeNull();
  });

  it("drops invalid, reversed and unsourced events, and says why", () => {
    const r = plan([
      ...sparse,
      ev("Mal", "2026-02-31"),
      ev("Al revés", "2026-05-10", { end: "2026-05-01" }),
      ev("Sin fuente", "2026-05-12", { source: null }),
    ]);
    expect(r.ok && r.dropped.map((d) => d.reason)).toEqual([
      "invalid_date",
      "invalid_range",
      "unsourced",
    ]);
  });

  it("a date range stays a range, never one point", () => {
    const r = plan(sparse);
    expect(r.ok && r.spec.events.find((e) => e.kind === "exam")).toMatchObject({
      start: "2026-09-21",
      end: "2026-09-22",
    });
  });
});

describe("density decides the representation", () => {
  it("sparse milestones over months → timeline, in order, with the next date as a fact", () => {
    const r = plan([...sparse].reverse());
    expect(r.ok && r.view).toBe("timeline");
    expect(r.ok && r.spec.events.map((e) => e.start)).toEqual([
      "2026-03-02",
      "2026-08-03",
      "2026-09-21",
      "2026-11-27",
    ]);
    expect(r.ok && r.facts.some((f) => f.includes("próxima: Segundo cuatrimestre"))).toBe(true);
  });

  it("many exact dates within a few months → calendar", () => {
    const dense = [
      "2026-09-01",
      "2026-09-08",
      "2026-09-15",
      "2026-09-22",
      "2026-10-06",
      "2026-10-13",
    ];
    const r = plan(dense.map((d, i) => ev(`Entrega ${i + 1}`, d, { kind: "delivery" })));
    expect(r.ok && r.view).toBe("calendar");
  });

  it("one day of timed events → agenda", () => {
    const r = plan([
      ev("Daily", "2026-06-01T09:00", { end: "2026-06-01T09:15", kind: "meeting" }),
      ev("Cliente", "2026-06-01T11:00", { end: "2026-06-01T12:00", kind: "meeting" }),
      ev("Revisión", "2026-06-01T16:30", { kind: "meeting" }),
    ]);
    expect(r.ok && r.view).toBe("agenda");
  });

  it("meaningful durations → intervals; a few scattered dates never become a Gantt", () => {
    const r = plan([
      ev("Diseño", "2026-01-05", { end: "2026-02-20" }),
      ev("Construcción", "2026-02-23", { end: "2026-05-29" }),
      ev("Lanzamiento", "2026-06-01", { kind: "milestone" }),
    ]);
    expect(r.ok && r.view).toBe("intervals");
    expect(plan(sparse).ok && (plan(sparse) as { view: string }).view).not.toBe("intervals");
  });

  it("one or two dates read better as a sentence — unless the user asked for a schedule", () => {
    expect(plan(sparse.slice(0, 2)).ok).toBe(false);
    const asked = plan(sparse.slice(0, 2), { explicit: true });
    expect(asked.ok && asked.view).toBe("list");
  });

  it("a requested view is honoured only when it fits, with a notice otherwise", () => {
    const cal = plan(sparse.slice(1), { view: "calendar" });
    const tooLong = plan(sparse, { view: "calendar" });
    expect(tooLong.ok && tooLong.view).toBe("timeline");
    expect(cal.ok && cal.view).toBe("calendar");
    const gantt = plan(
      sparse.filter((e) => !e.end),
      { view: "intervals" },
    );
    expect(gantt.ok && gantt.view).toBe("timeline");
    expect(gantt.ok && gantt.notice).toMatch(/duración/);
  });
});

describe("provenance, importance and conflicts", () => {
  it("every event points to its source, with the passage it came from", () => {
    const r = plan(sparse);
    if (!r.ok) throw new Error(r.reason);
    for (const e of r.spec.events) expect(r.spec.sources?.[e.source!]?.title).toBe(doc.title);
    expect(r.spec.sources?.[0]?.excerpt).toBe(doc.excerpt);
  });

  it("exams and deadlines stand out unless the model says otherwise", () => {
    const r = plan([...sparse, ev("Trámite", "2026-04-10", { importance: "low" })]);
    if (!r.ok) throw new Error(r.reason);
    const by = (t: string) => r.spec.events.find((e) => e.title === t)!.importance;
    expect(by("Turno de finales")).toBe("high");
    expect(by("Inicio de clases")).toBe("normal");
    expect(by("Trámite")).toBe("low");
  });

  it("two sources disagreeing on a date are both kept and flagged, never merged", () => {
    const r = plan([...sparse, ev("Cierre", "2026-12-04", { kind: "end", source: other })]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.conflicts).toEqual(["Cierre"]);
    expect(r.spec.events.filter((e) => e.title === "Cierre").every((e) => e.conflict)).toBe(true);
    // The same event twice from the same evidence is one event.
    const dup = plan([...sparse, sparse[0]!]);
    expect(dup.ok && dup.spec.events).toHaveLength(4);
  });

  it("a focus narrows what's shown without losing the rest", () => {
    const r = plan(sparse, { focus: { kinds: ["exam"] } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.spec.events).toHaveLength(4);
    expect(r.spec.events.filter((e) => matches(e, r.spec.focus))).toHaveLength(1);
    const september = { from: "2026-09-01", to: "2026-09-30" };
    expect(sparse.filter((e) => matches(e, september)).map((e) => e.title)).toEqual([
      "Turno de finales",
    ]);
  });
});

describe("representation analyzer", () => {
  it("notices a schedule in retrieved text without extracting anything", () => {
    const text =
      "Las clases comienzan el 2 de marzo. El primer parcial es el 14 de abril y el recuperatorio el 22 y 23 de septiembre. Cierre: 2026-11-27.";
    expect(distinctDates([text])).toBeGreaterThanOrEqual(3);
    expect(representationHint([text])).toBe("temporal");
  });

  it("prose, fractions and single dates are not schedules", () => {
    expect(representationHint(["El 3/4 de los alumnos aprobó. Nos vemos el 2 de marzo."])).toBe(
      null,
    );
    expect(representationHint(["El mail dice que el informe está listo."])).toBe(null);
  });
});

// ── ui.timeline: same-turn presentation, provenance and in-place updates ─────

class FakeWorkspace implements WorkspacePort {
  state_: WorkspaceState = emptyWorkspace();
  apply(ops: WorkspaceOp[]) {
    this.state_ = applyOps(this.state_, ops);
    return this.state_.version;
  }
  state() {
    return this.state_;
  }
  activity() {}
}

/** A Knowledge search already on screen: passages [1] and [2] of one document. */
function withKnowledge() {
  const ws = new FakeWorkspace();
  ws.apply([
    {
      op: "present",
      at: "2026-06-01T10:00:00Z",
      surface: {
        id: "k1",
        type: "knowledge_source",
        title: "Programa de la materia",
        state: "ready",
        priority: 55,
        size: "medium",
        source: null,
        ref: null,
        payload: {
          itemId: "doc-1",
          title: "Programa de la materia",
          sourceType: "upload",
          spaceName: "Facultad",
          url: null,
          passages: [
            { ref: 1, chunkId: "c1", section: null, page: 2, excerpt: "Inicio de clases…" },
            { ref: 2, chunkId: "c2", section: null, page: 3, excerpt: "Turno de finales…" },
          ],
        },
        actions: [],
        intentId: null,
      },
    } as never,
  ]);
  return ws;
}

const timelineArgs = {
  title: "Cronograma",
  events: [
    { title: "Inicio de clases", start: "2026-03-02", kind: "start", source: "[1]" },
    { title: "Segundo cuatrimestre", start: "2026-08-03", kind: "start", source: "1" },
    {
      title: "Turno de finales",
      start: "2026-09-21",
      end: "2026-09-22",
      kind: "exam",
      source: "[2]",
    },
    { title: "Cierre", start: "2026-11-27", kind: "end", source: "[2]" },
  ],
};

describe("ui.timeline", () => {
  it("resolves Knowledge citations to the document and passage, and leads the canvas", async () => {
    const ws = withKnowledge();
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws, userMessage: "mostrame el cronograma" });
    const out = await executeToolCall(ports, ctx, { name: "ui.timeline", args: timelineArgs });
    expect(out).toMatchObject({ status: "succeeded", output: { shown: "timeline" } });
    const s = ws.state().surfaces.find((x) => x.type === "visualization")!;
    expect(s).toMatchObject({ size: "large", priority: 86 });
    const spec = (s.payload as { spec: { sources: { url: string; excerpt: string }[] } }).spec;
    expect(spec.sources.map((x) => x.url)).toEqual([
      "/knowledge/items/doc-1",
      "/knowledge/items/doc-1",
    ]);
    expect(spec.sources[1]!.excerpt).toBe("Turno de finales…");
  });

  it('"solo los parciales" updates the same Surface without re-sending dates', async () => {
    const ws = withKnowledge();
    const { ports } = makePorts([]);
    const ctx = makeCtx({ workspace: ws });
    await executeToolCall(ports, ctx, { name: "ui.timeline", args: timelineArgs });
    await executeToolCall(ports, ctx, {
      name: "ui.timeline",
      args: { title: "Cronograma", focus: { kinds: ["exam"] }, view: "calendar" },
    });
    const all = ws.state().surfaces.filter((x) => x.type === "visualization");
    expect(all).toHaveLength(1);
    expect((all[0]!.payload as { spec: unknown }).spec).toMatchObject({
      view: "calendar",
      focus: { kinds: ["exam"] },
    });
  });

  it("dates whose sources aren't on screen are refused", async () => {
    const { ports } = makePorts([]);
    const out = await executeToolCall(ports, makeCtx({ workspace: new FakeWorkspace() }), {
      name: "ui.timeline",
      args: timelineArgs,
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
  });

  it("same turn: the answer and the timeline in one response end the turn (no extra model call)", async () => {
    const ws = withKnowledge();
    const { ports } = makePorts([]);
    ports.registry.register(...WORKSPACE_TOOLS.filter((t) => !ports.registry.get(t.name)));
    const ai = new ScriptedAI([
      () => [
        { type: "text_delta", delta: "Las fechas clave son marzo, agosto y noviembre." },
        {
          type: "tool_call",
          callId: "t",
          name: "ui.timeline",
          arguments: JSON.stringify(timelineArgs),
        },
        { type: "completed", model: "m", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    for await (const _ of runElise({
      ai,
      ports,
      ctx: makeCtx({ workspace: ws, userMessage: "cronograma de la materia" }),
      instructions: "",
      input: [],
      tools: WORKSPACE_TOOLS,
    }))
      void _;
    expect(ai.requests).toHaveLength(1);
    expect(ws.state().surfaces.some((x) => x.type === "visualization")).toBe(true);
  });
});
