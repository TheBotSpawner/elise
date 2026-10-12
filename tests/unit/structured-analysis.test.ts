import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { explicitStructured, selectTools } from "@/core/agents/tool-selection";
import type {
  FieldMapping,
  QueryPlan,
  StructuredProvider,
  StructuredRecord,
  StructuredSource,
} from "@/core/capabilities/structured";
import { analysisVisuals, analyzeRecords } from "@/core/structured/analysis";
import { matchSourceNames } from "@/core/structured/mapping";
import { beforePresenting, overBudget, PRESENTATION } from "@/core/workspace/presentation";
import { NOTION_LIMITS, NotionHttp } from "@/infrastructure/providers/notion/http";

import { binding, makeCtx, makePorts } from "../fixtures/core-fakes";

/** ADR-048: explicit database requests go to the database, analyzed live; tool call ≠ Surface. */

// ── Routing ──────────────────────────────────────────────────────────────────

const REPRO =
  "ELIS, consultá mi base de oportunidades en Notion y quiero que me analices cómo está la situación en este momento en Firbot.";

describe("explicit structured routing", () => {
  it("the reproduced request is a database request; document questions are not", () => {
    expect(explicitStructured(REPRO)).toBe(true);
    expect(explicitStructured("¿Cuántas oportunidades abiertas tengo en mi CRM?")).toBe(true);
    expect(explicitStructured("analizame la pipeline")).toBe(true);
    expect(explicitStructured("¿Qué dice nuestro documento de posicionamiento de Firbot?")).toBe(
      false,
    );
    expect(explicitStructured("Buscame la plantilla de propuesta en Notion")).toBe(false);
    expect(explicitStructured("mi base de conocimiento sobre RSFA")).toBe(false);
  });

  it("knowledge.search is held out of the first pass (still loadable), structured is in", () => {
    const tool = (name: string) => ({ name }) as never;
    const all = [tool("knowledge.search"), tool("knowledge.getSpace"), tool("structured.analyze")];
    const sel = selectTools(all, { message: REPRO });
    expect(sel.tools.map((t) => (t as { name: string }).name)).toEqual([
      "knowledge.getSpace",
      "structured.analyze",
    ]);
    expect(sel.rest.map((t) => (t as { name: string }).name)).toEqual(["knowledge.search"]);
    const doc = selectTools(all, { message: "¿qué dice el documento de Firbot?" });
    expect(doc.tools.map((t) => (t as { name: string }).name)).toContain("knowledge.search");
  });
});

describe("database resolution", () => {
  const dbs = [
    { name: "Oportunidades" },
    { name: "Pipeline de Proyectos" },
    { name: "Pipeline Marketing" },
    { name: "Empresas", aliases: ["clientes"] },
  ];
  it("exact, normalized and alias names resolve to one database without asking", () => {
    expect(matchSourceNames("Oportunidades", dbs)).toEqual([dbs[0]]);
    expect(matchSourceNames("mi base de oportunidades en Notion", dbs)).toEqual([dbs[0]]);
    expect(matchSourceNames("OPORTUNIDADES", dbs)).toEqual([dbs[0]]);
    expect(matchSourceNames("clientes", dbs)).toEqual([dbs[3]]);
  });
  it("only a genuine tie is several (then ELISE asks)", () => {
    expect(matchSourceNames("pipeline", dbs)).toHaveLength(2);
    expect(matchSourceNames("Proyectos", dbs)).toEqual([dbs[1]]);
    expect(matchSourceNames("facturas", dbs)).toEqual([]);
  });
});

// ── Analysis ─────────────────────────────────────────────────────────────────

const field = (
  key: string,
  name: string,
  type: FieldMapping["type"],
  extra = {},
): FieldMapping => ({
  key,
  label: name,
  propertyId: key,
  propertyName: name,
  type,
  providerType: type === "text" && key === "name" ? "title" : type,
  writable: false,
  isTitle: key === "name",
  broken: null,
  ...extra,
});

const SOURCE: StructuredSource = {
  id: "x:00000000-0000-4000-8000-000000000001:live:ds",
  name: "Oportunidades",
  context: null,
  providerKey: "notion",
  connectionId: "00000000-0000-4000-8000-000000000001",
  account: "Firbot",
  semanticType: "generic",
  fields: [
    field("name", "Nombre de oportunidad", "text"),
    field("status", "Etapa", "select", {
      options: ["Descubrimiento", "Propuesta", "Negociación", "Ganada", "Perdida"].map((name) => ({
        name,
      })),
    }),
    field("valor_estimado", "Valor estimado", "number"),
    field("fecha_estimada_de_cierre", "Fecha estimada de cierre", "date"),
    field("empresa", "Empresa", "select"),
  ],
  permissions: { read: true, create: false, update: false, archive: false },
  status: "active",
  schemaCheckedAt: null,
  url: null,
};

let n = 0;
const rec = (
  stage: string | null,
  value: number | null,
  close: string | null,
  updatedAt = "2026-10-10T00:00:00Z",
  company = "Acme",
): StructuredRecord => ({
  id: `r${++n}`,
  sourceId: SOURCE.id,
  title: `Opp ${n}`,
  values: {
    name: `Opp ${n}`,
    status: stage,
    valor_estimado: value,
    fecha_estimada_de_cierre: close ? { start: close } : null,
    empresa: company,
  },
  url: null,
  updatedAt,
  provenance: {
    providerKey: "notion",
    connectionId: SOURCE.connectionId,
    source: "Oportunidades",
    account: "Firbot",
  },
});

const RECORDS = [
  rec("Propuesta", 1000, "2026-10-20"), // closing soon
  rec("Negociación", 5000, "2026-10-01"), // overdue
  rec("Descubrimiento", null, null, "2026-08-01T00:00:00Z"), // stale + missing
  rec("Ganada", 3000, "2026-09-01"),
  rec("Perdida", 2000, "2026-09-02"),
];

describe("deterministic analysis from the live schema", () => {
  const a = analyzeRecords(SOURCE, RECORDS, { today: "2026-10-12", complete: true });

  it("finds stage, value, close date and company by the database's own property names", () => {
    expect(a.fields).toEqual({
      stage: "Etapa",
      value: "Valor estimado",
      close: "Fecha estimada de cierre",
      company: "Empresa",
    });
  });

  it("counts, stages in schema order, value per state and what needs attention", () => {
    expect([a.total, a.open, a.won, a.lost]).toEqual([5, 3, 1, 1]);
    expect(a.byStage.map((s) => [s.stage, s.count])).toEqual([
      ["Descubrimiento", 1],
      ["Propuesta", 1],
      ["Negociación", 1],
      ["Ganada", 1],
      ["Perdida", 1],
    ]);
    expect(a.value).toEqual({ open: 6000, won: 3000, total: 11000 });
    expect([a.overdue, a.closingSoon, a.stale, a.missingInfo]).toEqual([1, 1, 1, 1]);
    // The two highest-value open ones are already listed (overdue, closing soon): no duplicates.
    expect(a.attention.map((x) => x.reason)).toEqual(["overdue", "closing_soon", "stale"]);
  });

  it("follow-ups: only open, ranked by value or by close", () => {
    const open = analyzeRecords(SOURCE, RECORDS, {
      today: "2026-10-12",
      complete: true,
      scope: "open",
    });
    expect(open.total).toBe(3);
    const byValue = analyzeRecords(SOURCE, RECORDS, {
      today: "2026-10-12",
      complete: true,
      rank: "value",
    });
    expect(byValue.attention.map((x) => x.value)).toEqual([5000, 1000]);
    const byClose = analyzeRecords(SOURCE, RECORDS, {
      today: "2026-10-12",
      complete: true,
      rank: "close",
    });
    expect(byClose.attention.map((x) => x.close)).toEqual(["2026-10-01", "2026-10-20"]);
  });

  it("dormant stages are their own bucket, not open pipeline", () => {
    const d = analyzeRecords(
      SOURCE,
      [...RECORDS, rec("Dormida / Follow-up futuro", 900, "2026-07-01")],
      {
        today: "2026-10-12",
        complete: true,
      },
    );
    expect([d.open, d.dormant, d.overdue]).toEqual([3, 1, 1]);
  });

  it("no invented metrics: without a value property there is no value", () => {
    const bare = { ...SOURCE, fields: SOURCE.fields.filter((f) => f.type !== "number") };
    const b = analyzeRecords(bare, RECORDS, { today: "2026-10-12", complete: true });
    expect(b.value).toBeNull();
    expect(b.attention.every((x) => x.reason !== "high_value")).toBe(true);
  });

  it("at most 3 visuals with stable roles; partial reads say so", () => {
    const v = analysisVisuals(a, "es");
    expect(v.map((x) => x.role)).toEqual(["summary", "stages", "attention"]);
    const partial = analysisVisuals({ ...a, complete: false, records: 1000 }, "es");
    expect(JSON.stringify(partial[0])).toContain("primeros 1000");
  });
});

// ── The tool: one call, paginated batches, read-only ─────────────────────────

function fakeProvider(records: StructuredRecord[]): StructuredProvider & { calls: QueryPlan[] } {
  const calls: QueryPlan[] = [];
  return {
    calls,
    listSources: async () => [SOURCE],
    findSources: async (ref: string) => matchSourceNames(ref, [SOURCE]),
    async query(_s: StructuredSource, plan: QueryPlan) {
      calls.push(plan);
      const start = Number(plan.cursor ?? 0);
      const page = records.slice(start, start + plan.limit);
      const next = start + plan.limit;
      return {
        records: page,
        hasMore: next < records.length,
        nextCursor: next < records.length ? String(next) : null,
      };
    },
    getRecord: async () => null,
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    archiveRecord: vi.fn(),
    bulkUpdate: vi.fn(),
  } as unknown as StructuredProvider & { calls: QueryPlan[] };
}

describe("structured.analyze", () => {
  const notion = binding({
    capability: "structured",
    providerKey: "notion",
    connectionId: SOURCE.connectionId,
    label: "Firbot",
    isDefault: true,
  });
  it("resolves 'Oportunidades' and reads every record in batches of 100 (not one per record)", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      rec(i % 2 ? "Propuesta" : "Ganada", 10, null),
    );
    const p = fakeProvider(many);
    const { ports } = makePorts([notion], { [SOURCE.connectionId]: p });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "structured.analyze",
      args: { source: "mi base de oportunidades en Notion" },
    });
    expect(out.status).toBe("succeeded");
    expect(p.calls.map((c) => c.limit)).toEqual([100, 100, 100]);
    expect((out as { output: { analyzed: number } }).output.analyzed).toBe(250);
    expect((out as { display: { kind: string } }).display.kind).toBe("structured_analysis");
  });

  it("a shared-only database is read-only: writes are refused", async () => {
    const p = fakeProvider([]);
    const { ports } = makePorts([notion], { [SOURCE.connectionId]: p });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "structured.createRecord",
      args: { source: "Oportunidades", values: { name: "Nueva" } },
    });
    expect(out.status).not.toBe("succeeded");
    expect(p.createRecord).not.toHaveBeenCalled();
  });
});

// ── Presentation ─────────────────────────────────────────────────────────────

describe("tool call ≠ Surface", () => {
  it("plumbing never becomes a Surface", () => {
    expect(beforePresenting("structured.listSources", []).present).toBe(false);
    expect(beforePresenting("structured.getSchema", []).present).toBe(false);
  });
  it("repeated searches consolidate; an analysis supersedes the turn's document searches", () => {
    const earlier = [
      { tool: "knowledge.search", ids: ["k1"] },
      { tool: "calendar.listEvents", ids: ["c1"] },
    ];
    expect(beforePresenting("knowledge.search", earlier).dismiss).toEqual(["k1"]);
    expect(beforePresenting("structured.analyze", earlier).dismiss).toEqual(["k1"]);
    expect(beforePresenting("calendar.listEvents", earlier).dismiss).toEqual([]);
  });
  it("a turn adds at most a few Surfaces", () => {
    expect(PRESENTATION.maxPerTurn).toBeLessThanOrEqual(4);
    expect(overBudget(["a", "b", "c"], ["d", "e"])).toEqual(["e"]);
    expect(overBudget([], ["a", "b"])).toEqual([]);
  });
});

// ── Notion rate limits ───────────────────────────────────────────────────────

describe("Notion requests: Retry-After, bounded retries, shared in-flight reads", () => {
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const limited = (after?: string) =>
    new Response("{}", { status: 429, headers: after ? { "retry-after": after } : {} });

  it("honors Retry-After and retries a read at most NOTION_LIMITS.retries times", async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn(async () => limited("2"));
    const http = new NotionHttp(
      async () => "t1",
      async () => {},
      fetchImpl,
      async (ms) => void waits.push(ms),
    );
    await expect(http.request("POST", "/data_sources/x/query", {}, true)).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1 + NOTION_LIMITS.retries);
    expect(waits).toEqual([2000, 2000]);
    expect(http.stats.retries).toBe(NOTION_LIMITS.retries);
  });

  it("recovers after a 429 without Retry-After (backoff 1 s)", async () => {
    const waits: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(ok());
    const http = new NotionHttp(
      async () => "t2",
      async () => {},
      fetchImpl,
      async (ms) => void waits.push(ms),
    );
    await expect(http.request("GET", "/pages/p")).resolves.toEqual({ ok: true });
    expect(waits).toEqual([1000]);
  });

  it("writes never retry on their own", async () => {
    const fetchImpl = vi.fn(async () => limited("1"));
    const http = new NotionHttp(
      async () => "t3",
      async () => {},
      fetchImpl,
      async () => {},
    );
    await expect(http.request("PATCH", "/pages/p", {})).rejects.toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("identical reads in flight are sent once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = vi.fn(async () => (await gate, ok()));
    const http = new NotionHttp(
      async () => "t4",
      async () => {},
      fetchImpl,
      async () => {},
    );
    const both = Promise.all([
      http.request("GET", "/data_sources/d"),
      http.request("GET", "/data_sources/d"),
    ]);
    release();
    await both;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(http.stats.shared).toBe(1);
  });

  it("never more than NOTION_LIMITS.concurrency requests in flight per connection", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return ok();
    });
    const http = new NotionHttp(
      async () => "t5",
      async () => {},
      fetchImpl,
      async () => {},
    );
    await Promise.all(Array.from({ length: 6 }, (_, i) => http.request("GET", `/pages/${i}`)));
    expect(peak).toBeLessThanOrEqual(NOTION_LIMITS.concurrency);
  }, 10_000);
});
