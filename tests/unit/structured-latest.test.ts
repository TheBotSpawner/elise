import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { selectTools } from "@/core/agents/tool-selection";
import type {
  FieldMapping,
  QueryPlan,
  StructuredProvider,
  StructuredRecord,
  StructuredSource,
} from "@/core/capabilities/structured";
import { latestPlan } from "@/core/structured/latest";
import { matchSourceNames } from "@/core/structured/mapping";
import { citedKnowledge } from "@/core/workspace/from-results";
import { beforePresenting, isPlumbing } from "@/core/workspace/presentation";

import { binding, makeCtx, makePorts } from "../fixtures/core-fakes";

/** ADR-114: "¿Cuál es mi último post publicado?" = latest by publication date among published. */

const field = (
  key: string,
  label: string,
  type: FieldMapping["type"],
  extra: Partial<FieldMapping> = {},
): FieldMapping => ({
  key,
  label,
  propertyId: key,
  propertyName: label,
  type,
  providerType: key === "name" ? "title" : type,
  writable: false,
  isTitle: key === "name",
  broken: null,
  ...extra,
});

const POSTS: StructuredSource = {
  id: "x:00000000-0000-4000-8000-000000000001:live:ds",
  name: "Posts",
  context: null,
  providerKey: "notion",
  connectionId: "00000000-0000-4000-8000-000000000001",
  account: "Test",
  semanticType: "generic",
  fields: [
    field("name", "Título", "text"),
    field("estado", "Estado", "status", {
      options: [
        { name: "Idea", group: "todo" },
        { name: "Borrador", group: "in_progress" },
        { name: "Publicado", group: "complete" },
      ],
    }),
    field("creado", "Fecha de creación", "date"),
    field("fecha_de_publicacion", "Fecha de publicación", "date"),
  ],
  permissions: { read: true, create: false, update: false, archive: false },
  status: "active",
  schemaCheckedAt: null,
  url: null,
};

const rec = (id: string, title: string, published: string | null): StructuredRecord => ({
  id,
  sourceId: POSTS.id,
  title,
  values: {
    name: title,
    estado: "Publicado",
    fecha_de_publicacion: published ? { start: published } : null,
  },
  url: null,
  updatedAt: "2026-10-20T00:00:00Z",
  provenance: {
    providerKey: "notion",
    connectionId: POSTS.connectionId,
    source: "Posts",
    account: "Test",
  },
});

describe("latestPlan", () => {
  it("sorts by the publication date (not creation or edit) among Publicado", () => {
    const l = latestPlan(POSTS, { publishedOnly: true });
    expect(l.dateField?.key).toBe("fecha_de_publicacion");
    expect(l.published).toMatchObject({ op: "any_of", value: ["Publicado"] });
    expect(l.plan.filters.map((f) => [f.field.key, f.op])).toEqual([
      ["estado", "any_of"],
      ["fecha_de_publicacion", "is_not_empty"],
    ]);
    expect(l.plan.sort[0]).toMatchObject({ direction: "desc" });
    expect((l.plan.sort[0]!.field as FieldMapping).key).toBe("fecha_de_publicacion");
  });

  it("a published checkbox counts too", () => {
    const s = {
      ...POSTS,
      fields: [field("name", "Título", "text"), field("pub", "Publicado", "checkbox")],
    };
    expect(latestPlan(s, { publishedOnly: true }).published).toMatchObject({
      op: "equals",
      value: true,
    });
  });

  it("no publication date: falls back to the last edit and says so", () => {
    const s = { ...POSTS, fields: POSTS.fields.filter((f) => f.key !== "fecha_de_publicacion") };
    const l = latestPlan(s, { publishedOnly: true });
    expect(l.dateField).toBeNull();
    expect(l.plan.sort).toEqual([{ field: "last_edited", direction: "desc" }]);
    expect(l.criterion).toMatch(/not a publication date/);
  });

  it("no published status: says it can't tell drafts apart", () => {
    const s = { ...POSTS, fields: POSTS.fields.filter((f) => f.key !== "estado") };
    expect(latestPlan(s, { publishedOnly: true }).criterion).toMatch(/can't tell published/);
  });
});

function fakeProvider(records: StructuredRecord[], body: string | null) {
  const calls: QueryPlan[] = [];
  const p = {
    listSources: async () => [POSTS],
    findSources: async (ref: string) => matchSourceNames(ref, [POSTS]),
    async query(_s: StructuredSource, plan: QueryPlan) {
      calls.push(plan);
      return { records: records.slice(0, plan.limit), hasMore: false, nextCursor: null };
    },
    recordBody: vi.fn(async () => body),
    getRecord: async () => null,
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    archiveRecord: vi.fn(),
    bulkUpdate: vi.fn(),
  };
  return { p: p as unknown as StructuredProvider, calls, recordBody: p.recordBody };
}

describe("structured.latest", () => {
  const notion = binding({
    capability: "structured",
    providerKey: "notion",
    connectionId: POSTS.connectionId,
    label: "Test",
    isDefault: true,
  });

  it("reads one query, returns the winner with its content and the previous ones", async () => {
    const { p, calls, recordBody } = fakeProvider(
      [rec("a", "Nuevo post", "2026-10-20"), rec("b", "Post anterior", "2026-10-10")],
      "Cuerpo del post.",
    );
    const { ports } = makePorts([notion], { [POSTS.connectionId]: p });
    const out = (await executeToolCall(ports, makeCtx(), {
      name: "structured.latest",
      args: { source: "Posts", previous: 1 },
    })) as {
      status: string;
      output: {
        latest: { title: string };
        content: string;
        previous: unknown[];
        criterion: string;
      };
      display: { kind: string; excerpt?: string; previous?: unknown[] };
    };
    expect(out.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.limit).toBe(2);
    expect(out.output.latest.title).toBe("Nuevo post");
    expect(out.output.content).toBe("Cuerpo del post.");
    expect(out.output.previous).toHaveLength(1);
    expect(out.output.criterion).toMatch(/Fecha de publicación/);
    expect(recordBody).toHaveBeenCalledWith("a", expect.any(Number));
    expect(out.display).toMatchObject({ kind: "structured_record", excerpt: "Cuerpo del post." });
    expect(out.display.previous).toHaveLength(1);
  });

  it("nothing published: says so, no record card", async () => {
    const { p } = fakeProvider([], null);
    const { ports } = makePorts([notion], { [POSTS.connectionId]: p });
    const out = (await executeToolCall(ports, makeCtx(), {
      name: "structured.latest",
      args: { source: "Posts" },
    })) as { status: string; output: { found: boolean }; display?: unknown };
    expect(out.status).toBe("succeeded");
    expect(out.output.found).toBe(false);
    expect(out.display).toBeUndefined();
  });
});

describe("presentation", () => {
  it("listing databases is plumbing: no card in chat or Canvas", () => {
    expect(isPlumbing("structured.listSources")).toBe(true);
    expect(isPlumbing("structured.latest")).toBe(false);
  });

  it("the latest replaces the turn's analysis and queries", () => {
    const plan = beforePresenting("structured.latest", [
      { tool: "structured.analyze", ids: ["s1"] },
      { tool: "structured.query", ids: ["s2"] },
    ]);
    expect(plan.dismiss).toEqual(["s1", "s2"]);
  });

  it("'¿Cuál es mi último post publicado?' brings the structured tools", () => {
    const tool = (name: string) => ({ name }) as never;
    const sel = selectTools([tool("structured.latest")], {
      message: "¿Cuál es mi último post publicado?",
    });
    expect(sel.groups).toContain("structured");
  });
});

describe("documents card keeps what the answer cited (ADR-114)", () => {
  const src = (itemId: string, ref: number) => ({
    itemId,
    title: itemId,
    sourceType: "notion",
    spaceName: "Firbot",
    url: null,
    passages: [{ ref, chunkId: `c${ref}`, section: null, page: null, excerpt: "x" }],
  });
  const payload = { enough: true, sources: [src("claude", 1), src("openai", 2), src("mkt", 3)] };

  it("one cited document → only that one", () => {
    expect(
      citedKnowledge(payload, "Encontré el artículo [1].")?.sources.map((s) => s.itemId),
    ).toEqual(["claude"]);
  });
  it("no citations, or all cited → unchanged", () => {
    expect(citedKnowledge(payload, "Sin citas.")).toBeNull();
    expect(citedKnowledge(payload, "[1] [2] [3]")).toBeNull();
  });
});
