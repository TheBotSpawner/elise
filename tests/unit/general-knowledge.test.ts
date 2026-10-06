import { describe, expect, it } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall, INTERNAL_CONNECTION_ID } from "@/core/agents/executor";
import type { KnowledgeManager, SpaceOverview } from "@/core/knowledge/admin";
import {
  generalContextApplies,
  type KnowledgeReader,
  type SpaceInfo,
} from "@/core/knowledge/model";
import {
  crossDomainSignal,
  planTurnMethods,
  teachingHint,
  teachingSignal,
  type MethodSummary,
  type SpaceRef,
} from "@/core/skills/model";

import { makeCtx, makePorts } from "../fixtures/core-fakes";
import { InMemoryMethodStore } from "../fixtures/methods-fakes";

/** ADR-047: General Knowledge — one per workspace, horizontal, least specific, fully editable. */

const GENERAL = "00000000-0000-4000-8000-0000000000aa";
const SPACES = [
  { id: GENERAL, name: "General Knowledge", parentId: null, general: true },
  { id: "s-rsfa", name: "RSFA", parentId: null },
  { id: "s-utn", name: "UTN", parentId: null },
  { id: "s-leg", name: "Legislación", parentId: "s-utn" },
];
const path = (s: (typeof SPACES)[number]) =>
  s.parentId ? `${SPACES.find((p) => p.id === s.parentId)!.name} › ${s.name}` : s.name;

// ── Knowledge tools ──────────────────────────────────────────────────────────

function knowledge() {
  const calls: string[] = [];
  const overview = (s: (typeof SPACES)[number]): SpaceOverview => ({
    id: s.id,
    name: s.name,
    path: path(s),
    parentId: s.parentId,
    general: s.general,
    description: null,
    context: null,
    sections: SPACES.filter((c) => c.parentId === s.id).length,
    sources: 0,
    documents: { ready: 0, processing: 0, attention: 0 },
  });
  const lastSearch: (string[] | null)[] = [];
  const impl = {
    async spaces(): Promise<SpaceInfo[]> {
      return SPACES.map((s) => ({ ...s, path: path(s), aliases: [] }));
    },
    search: async (q: { spaceIds: string[] | null }) => (
      lastSearch.push(q.spaceIds),
      { hits: [], semantic: true }
    ),
    getItem: async () => null,
    listSources: async () => [],
    recentChanges: async () => [],
    versionText: async () => null,
    overview: async () => ({ total: 0, items: [] }),
    listSpaces: async () => SPACES.map(overview),
    contents: async () => {
      throw new Error("unused");
    },
    createSpace: async (input: { name: string; parentId?: string | null }) => (
      calls.push(`create:${input.name}:${input.parentId ?? ""}`),
      { id: "new", section: Boolean(input.parentId) }
    ),
    updateSpace: async (id: string, patch: Record<string, unknown>) =>
      void calls.push(`update:${id}:${Object.keys(patch).join(",")}`),
    archiveSpace: async (id: string) => void calls.push(`archive:${id}`),
  } as unknown as KnowledgeReader & KnowledgeManager;
  const { ports } = makePorts(undefined, { [INTERNAL_CONNECTION_ID]: impl });
  const call = (name: string, args: unknown, ctx = makeCtx()) =>
    executeToolCall(ports, ctx, { name, args });
  return { call, calls, lastSearch };
}

describe("General Knowledge can't be renamed or deleted — anywhere", () => {
  it("archive/delete is refused before any approval is asked, with the reason", async () => {
    const k = knowledge();
    const out = await k.call("knowledge.archiveSpace", { space: "General Knowledge" });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(out.status).not.toBe("approval_required");
    expect(JSON.stringify(out)).toContain("General Knowledge is ELISE's base Space");
    expect(k.calls).toEqual([]);
  });

  it("rename is refused; description, context and Sections are not", async () => {
    const k = knowledge();
    const renamed = await k.call("knowledge.updateSpace", {
      space: "General Knowledge",
      name: "Mi base",
    });
    expect(renamed).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    const edited = await k.call("knowledge.updateSpace", {
      space: "General Knowledge",
      addToContext: "Trabajo mejor en lo importante antes del almuerzo.",
    });
    expect(edited.status).toBe("succeeded");
    const section = await k.call("knowledge.createSpace", {
      name: "Productividad",
      parent: "General Knowledge",
    });
    expect(section.status).toBe("succeeded");
    expect(k.calls).toEqual([`update:${GENERAL}:context`, `create:Productividad:${GENERAL}`]);
  });

  it("other Spaces are still archived normally (with approval)", async () => {
    const k = knowledge();
    const out = await k.call("knowledge.archiveSpace", { space: "RSFA" });
    expect(out.status).toBe("approval_required");
  });

  it("is listed for the model as General Knowledge", async () => {
    const k = knowledge();
    const out = (await k.call("knowledge.listSpaces", {})) as {
      output: { spaces: { path: string; generalKnowledge?: boolean }[] };
    };
    expect(out.output.spaces.find((s) => s.generalKnowledge)?.path).toBe("General Knowledge");
  });
});

describe("General Knowledge retrieval (supplement, least specific)", () => {
  it("inside a Section: the Section, then its Space, then General Knowledge as inherited tier", async () => {
    const k = knowledge();
    await k.call(
      "knowledge.search",
      { query: "material de cátedra para ejercicios" },
      makeCtx({ knowledgeSpaceId: "s-leg" }),
    );
    // First the Section's own; then, separately, what it inherits (UTN + General).
    expect(k.lastSearch[0]).toEqual(["s-leg"]);
    expect(k.lastSearch[1]?.sort()).toEqual([GENERAL, "s-utn"].sort());
  });

  it("no Space active: all Knowledge (General included), other Spaces still reachable by name", async () => {
    const k = knowledge();
    await k.call("knowledge.search", { query: "cómo prefiero organizar mi día" });
    expect(k.lastSearch[0]).toBeNull();
    await k.call("knowledge.search", { query: "qué pasó con el cliente", space: "RSFA" });
    expect(k.lastSearch.at(-2)).toEqual(["s-rsfa"]);
  });

  it("its context joins a turn only when it applies — never all of it every time", () => {
    const ctx =
      "Trabajo mejor en tareas importantes antes del almuerzo. Propuestas: empezar por el problema.";
    expect(generalContextApplies(ctx, "Planificame mañana", false)).toBe(true);
    expect(generalContextApplies(ctx, "¿qué dice el apunte de integrales?", true)).toBe(false);
    expect(generalContextApplies(ctx, "armame una propuesta para RSFA", true)).toBe(true);
    expect(generalContextApplies("", "lo que sea", false)).toBe(false);
  });

  it("the prompt states precedence: Section, then Space, then General Knowledge", () => {
    const pkg = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "America/Argentina/Buenos_Aires" },
      now: new Date("2026-10-06T12:00:00Z"),
      availableCapabilities: [],
      history: [],
      userMessage: "armame una propuesta",
      activeSpace: "Firbot",
      spaceNotes: [
        {
          path: "Firbot",
          context: "Propuestas Firbot: síntesis ejecutiva de 3 bullets.",
          active: true,
        },
        {
          path: "General Knowledge",
          context: "Propuestas: empezar explicando el problema.",
          active: false,
          general: true,
        },
      ],
    });
    expect(pkg.instructions).toContain('general="true"');
    expect(pkg.instructions).toContain(
      "the most specific wins — the Section, then its Space, then General Knowledge",
    );
  });
});

// ── Methods ──────────────────────────────────────────────────────────────────

const REFS: SpaceRef[] = SPACES.map((s) => ({ ...s, path: path(s) }));

function methods() {
  const store = new InMemoryMethodStore(REFS);
  const { ports } = makePorts(undefined, { [INTERNAL_CONNECTION_ID]: store });
  const call = (name: string, args: unknown, ctx = makeCtx()) =>
    executeToolCall(ports, ctx, { name, args });
  return { store, call };
}

const planning = {
  name: "Planificar el día",
  description: "Cómo planificar el día del usuario",
  purpose: "Ordenar el día",
  steps: ["Revisar el calendario", "Revisar tareas vencidas", "Elegir las tres prioridades"],
  reason: "explicit",
};

describe("General Knowledge Methods", () => {
  it('"guardalo como método general" from Home is saved in General Knowledge (workspace-wide)', async () => {
    const m = methods();
    const out = await m.call("methods.create", { ...planning, space: "General Knowledge" });
    expect(out.status).toBe("succeeded");
    const [saved] = [...m.store.methods.values()];
    expect(saved!.spaceId).toBeNull();
    expect(JSON.stringify(out)).toContain("General Knowledge");
    // Omitting the scope from Home (no Space) lands there too.
    const home = await m.call("methods.create", { ...planning, name: "Escribir para mí" });
    expect(home.status).toBe("succeeded");
    expect([...m.store.methods.values()].every((x) => x.spaceId === null)).toBe(true);
  });

  it("the General Space's own id also means workspace-wide; a Space or Section keeps its scope", async () => {
    const m = methods();
    await m.call("methods.create", { ...planning, space: GENERAL });
    await m.call("methods.create", { ...planning, name: "Reunión con Rod", space: "RSFA" });
    await m.call("methods.create", {
      ...planning,
      name: "Ejercicios",
      space: "UTN › Legislación",
    });
    expect([...m.store.methods.values()].map((x) => x.spaceId)).toEqual([null, "s-rsfa", "s-leg"]);
  });

  it('"¿qué métodos generales tengo?" lists only General Knowledge Methods', async () => {
    const m = methods();
    await m.call("methods.create", { ...planning, space: "General Knowledge" });
    await m.call("methods.create", { ...planning, name: "Reunión con Rod", space: "RSFA" });
    const out = (await m.call("methods.list", { space: "General Knowledge" })) as {
      output: { methods: { name: string; scope: string }[] };
    };
    expect(out.output.methods).toEqual([
      expect.objectContaining({ name: "Planificar el día", scope: "General Knowledge" }),
    ]);
  });

  it("precedence: Section > Space > General Knowledge, resolved deterministically", () => {
    const m = (name: string, spaceId: string | null, hints: string[]): MethodSummary => ({
      id: `${spaceId ?? "general"}:${name}`,
      name,
      description: name,
      hints,
      spaceId,
      platforms: ["web"],
      version: 1,
      updatedAt: "2026-10-01T00:00:00Z",
    });
    const index = [
      m("Planificar el día", null, ["planificar", "planificame"]),
      m("Planificar el día UTN", "s-utn", ["planificar", "planificame"]),
      m("Planificar el día Legislación", "s-leg", ["planificar", "planificame"]),
    ];
    const plan = (spaceIds: (string | null)[]) =>
      planTurnMethods({ index, spaces: REFS, message: "planificame mañana", spaceIds }).load?.method
        .name;
    expect(plan([])).toBe("Planificar el día");
    expect(plan(["s-utn"])).toBe("Planificar el día UTN");
    expect(plan(["s-leg"])).toBe("Planificar el día Legislación");
  });

  it("teaching: 'guardalo como método' is a durable instruction; global wording points to General", () => {
    const message =
      "ELISE, cuando me ayudes a planificar el día, primero revisá calendario, tareas vencidas y mis prioridades. Guardalo como método.";
    expect(teachingSignal(message)).toBe("durable");
    const hint = teachingHint(
      "durable",
      null,
      "Siempre que planifiques mi día, empezá por el calendario.",
    )!;
    expect(crossDomainSignal("en general, para cualquier proyecto")).toBe(true);
    expect(hint).toContain("General Knowledge");
    expect(hint).toContain("narrowest scope");
    // Not memory, not settings.
    expect(hint).toContain("Settings");
    expect(hint).toContain("Never save something you only inferred from past conversations");
  });
});
