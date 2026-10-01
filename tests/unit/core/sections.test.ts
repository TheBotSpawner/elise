import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  activeContextOf,
  contextLabel,
  kindForPurpose,
  purposeOf,
  resolveContext,
  type ContextProfile,
  type ContextStore,
  type NewContext,
} from "@/core/contexts/model";
import {
  scopeSpaces,
  type KnowledgeHit,
  type KnowledgeReader,
  type SpaceInfo,
} from "@/core/knowledge/model";
import { INHERITED_WEIGHT, preferPrimary } from "@/core/knowledge/retrieval";
import { findProfile } from "@/core/tools/contexts";
import { toolForAction } from "@/core/workspace/registry";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

// UTN › Administración, UTN › Legislación; Firbot Solutions › RSFA; Posgrado › Administración.
const UTN = "10000000-0000-4000-8000-000000000001";
const ADMIN = "10000000-0000-4000-8000-000000000002";
const LEGIS = "10000000-0000-4000-8000-000000000003";
const FIRBOT = "10000000-0000-4000-8000-000000000004";
const RSFA = "10000000-0000-4000-8000-000000000005";
const POSGRADO = "10000000-0000-4000-8000-000000000006";
const ADMIN2 = "10000000-0000-4000-8000-000000000007";

const SPACES: SpaceInfo[] = [
  { id: UTN, name: "UTN", parentId: null, path: "UTN" },
  { id: ADMIN, name: "Administración", parentId: UTN, path: "UTN › Administración" },
  { id: LEGIS, name: "Legislación", parentId: UTN, path: "UTN › Legislación" },
  { id: FIRBOT, name: "Firbot Solutions", parentId: null, path: "Firbot Solutions" },
  { id: RSFA, name: "RSFA", parentId: FIRBOT, path: "Firbot Solutions › RSFA" },
  { id: POSGRADO, name: "Posgrado", parentId: null, path: "Posgrado" },
  { id: ADMIN2, name: "Administración", parentId: POSGRADO, path: "Posgrado › Administración" },
];

let seq = 0;
const uid = () => `20000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A Section's profile as the application loads it: section ref + its own Space as a link. */
function sectionProfile(
  name: string,
  spaceId: string,
  kind: ContextProfile["kind"] = "study",
): ContextProfile {
  const space = SPACES.find((s) => s.id === spaceId)!;
  const parent = SPACES.find((s) => s.id === space.parentId)!;
  return {
    id: uid(),
    kind,
    name,
    description: null,
    aliases: [],
    icon: null,
    accent: null,
    status: "active",
    instructions: null,
    study: kind === "study" ? { targetDate: null, objective: null, level: null } : null,
    links: [
      {
        id: `section:${spaceId}`,
        type: "knowledge_space",
        resourceId: spaceId,
        value: null,
        label: space.path,
        confirmed: true,
      },
    ],
    section: { spaceId, parentId: parent.id, parentName: parent.name },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

const ADMINISTRACION = sectionProfile("Administración", ADMIN);
const ADMINISTRACION_POSGRADO = sectionProfile("Administración", ADMIN2);
const RSFA_CLIENT = sectionProfile("RSFA", RSFA, "client");

function hit(spaceId: string, score: number, title = "Doc"): KnowledgeHit {
  return {
    chunkId: uid(),
    itemId: uid(),
    versionId: uid(),
    versionNumber: 1,
    title,
    itemType: "file",
    sourceType: "upload",
    sourceUrl: null,
    spaceId,
    spaceName: SPACES.find((s) => s.id === spaceId)!.path,
    headingPath: [],
    page: 1,
    content: "Teoría organizacional: Weber y la burocracia racional legal.",
    similarity: 0.8,
    keywordMatched: true,
    score,
  };
}

describe("Space › Section model", () => {
  it("purposes map onto the existing context kinds and back", () => {
    expect(kindForPurpose("study")).toBe("study");
    expect(kindForPurpose("client")).toBe("client");
    expect(kindForPurpose("general")).toBe("custom");
    expect(purposeOf("work")).toBe("client");
    expect(purposeOf("custom")).toBe("general");
  });

  it("a Section reads with its Space everywhere", () => {
    expect(contextLabel(ADMINISTRACION)).toBe("UTN › Administración");
    expect(activeContextOf(RSFA_CLIENT)).toMatchObject({
      name: "Firbot Solutions › RSFA",
      kind: "client",
    });
    expect(contextLabel({ name: "Legacy", section: null })).toBe("Legacy");
  });
});

describe("inheritance and retrieval scope", () => {
  it("a Section searches its own sources plus its parent's general ones — never its siblings", () => {
    const s = scopeSpaces(SPACES, [ADMIN]);
    expect(s.primary).toEqual([ADMIN]);
    expect(s.spaceIds.sort()).toEqual([ADMIN, UTN].sort());
    expect(s.spaceIds).not.toContain(LEGIS);
  });

  it("a Space searches its general sources and its Sections (relevance decides)", () => {
    const s = scopeSpaces(SPACES, [UTN]);
    expect(s.primary.sort()).toEqual([UTN, ADMIN, LEGIS].sort());
    expect(s.spaceIds.sort()).toEqual(s.primary.sort());
  });

  it("Section first: inherited passages weigh less, own passages keep their score", () => {
    const own = hit(ADMIN, 0.5);
    const inherited = hit(UTN, 0.52);
    const ranked = preferPrimary([inherited, own], [ADMIN]).sort((a, b) => b.score - a.score);
    expect(ranked[0]!.spaceId).toBe(ADMIN);
    expect(ranked[1]!.score).toBeCloseTo(0.52 * INHERITED_WEIGHT);
    expect(preferPrimary([inherited], null)[0]!.score).toBe(0.52);
  });
});

describe("context resolution with Sections", () => {
  const resolve = (message: string, profiles: ContextProfile[]) =>
    resolveContext({ message, profiles, entities: [], activeId: null });

  it("resolves a Section by its name", () => {
    expect(resolve("Volvamos a Administración", [ADMINISTRACION, RSFA_CLIENT])).toMatchObject({
      kind: "match",
      profile: { id: ADMINISTRACION.id },
    });
    expect(resolve("Poneme al día con RSFA", [ADMINISTRACION, RSFA_CLIENT])).toMatchObject({
      kind: "match",
      profile: { id: RSFA_CLIENT.id },
    });
  });

  it("same-named Sections in two Spaces are ambiguous until the Space is named", () => {
    const both = [ADMINISTRACION, ADMINISTRACION_POSGRADO];
    expect(resolve("Volvamos a Administración", both).kind).toBe("ambiguous");
    expect(resolve("Volvamos a Administración de UTN", both)).toMatchObject({
      kind: "match",
      profile: { id: ADMINISTRACION.id },
    });
  });

  it("tools accept the Space › Section path", async () => {
    const store = {
      list: async () => [ADMINISTRACION, ADMINISTRACION_POSGRADO],
    } as unknown as ContextStore;
    await expect(findProfile(store, "Administración")).rejects.toMatchObject({
      message: expect.stringContaining("UTN › Administración"),
    });
    expect((await findProfile(store, "Posgrado › Administración")).id).toBe(
      ADMINISTRACION_POSGRADO.id,
    );
    expect((await findProfile(store, "UTN Administración")).id).toBe(ADMINISTRACION.id);
  });
});

// ── Tools through the executor ───────────────────────────────────────────────

function setup(profiles: ContextProfile[]) {
  const { ports } = makePorts();
  const searches: (string[] | null)[] = [];
  const reader = {
    spaces: async () => SPACES,
    search: async (q: { spaceIds: string[] | null }) => {
      searches.push(q.spaceIds);
      return {
        hits: [hit(UTN, 0.9, "Reglamento UTN"), hit(ADMIN, 0.85, "Weber")].filter(
          (h) => !q.spaceIds || q.spaceIds.includes(h.spaceId),
        ),
        semantic: true,
      };
    },
    getItem: async () => null,
    listSources: async () => [],
    recentChanges: async () => [],
    versionText: async () => null,
    overview: async () => ({ total: 0, items: [] }),
  } as unknown as KnowledgeReader;
  const created: NewContext[] = [];
  const contexts = {
    list: async () => profiles,
    entities: async () => [],
    catalog: async () => ({
      spaces: [],
      taskLists: [],
      structuredSources: [],
      accounts: [],
      lists: [],
    }),
    create: async (input: NewContext) => {
      created.push(input);
      return { ...RSFA_CLIENT, id: uid(), name: input.name };
    },
    associate: async () => {},
    lastInteraction: async () => null,
  } as unknown as ContextStore;
  ports.providers = {
    get: ((capability: string) =>
      capability === "knowledge" ? reader : contexts) as ProviderFactory["get"],
  };
  return { ports, searches, created };
}

describe("knowledge.search in a Section", () => {
  it("asking from a Section searches the Section and its Space, Section passages first", async () => {
    const { ports, searches } = setup([ADMINISTRACION]);
    const out = await executeToolCall(ports, makeCtx({ knowledgeSpaceId: ADMIN }), {
      name: "knowledge.search",
      args: { query: "teoría organizacional" },
    });
    expect(out.status).toBe("succeeded");
    expect(searches[0]!.sort()).toEqual([ADMIN, UTN].sort());
    const evidence = (out as { output: { evidence: { space: string }[] } }).output.evidence;
    // 0.85 (own) beats 0.9 × 0.85 (inherited).
    expect(evidence[0]!.space).toBe("UTN › Administración");
    expect(evidence.map((e) => e.space)).toContain("UTN");
  });

  it("an active Section context scopes search the same way, with no Space selected", async () => {
    const { ports, searches } = setup([ADMINISTRACION]);
    await executeToolCall(
      ports,
      makeCtx({ context: { id: ADMINISTRACION.id, name: "UTN › Administración", kind: "study" } }),
      { name: "knowledge.search", args: { query: "Weber" } },
    );
    expect(searches[0]!.sort()).toEqual([ADMIN, UTN].sort());
    expect(searches[0]).not.toContain(LEGIS);
  });

  it('from the root Space, results name the Section they come from ("which subjects cover X?")', async () => {
    const { ports, searches } = setup([]);
    const out = await executeToolCall(ports, makeCtx({ knowledgeSpaceId: UTN }), {
      name: "knowledge.search",
      args: { query: "teoría organizacional" },
    });
    expect(searches[0]!.sort()).toEqual([UTN, ADMIN, LEGIS].sort());
    const spaces = (out as { output: { evidence: { space: string }[] } }).output.evidence.map(
      (e) => e.space,
    );
    expect(spaces).toContain("UTN › Administración");
  });
});

describe("ELISE creating a Section", () => {
  it("propose carries the parent Space; Create on screen passes it; create makes a Section", async () => {
    const { ports, created } = setup([]);
    const proposed = await executeToolCall(ports, makeCtx(), {
      name: "contexts.propose",
      args: { name: "Mazalup", kind: "client", space: "Firbot Solutions" },
    });
    expect(proposed.status).toBe("succeeded");
    const display = (proposed as { display: { proposal: { space: unknown } } }).display;
    expect(display.proposal.space).toEqual({ id: FIRBOT, name: "Firbot Solutions" });
    const call = toolForAction(
      {
        id: "s",
        type: "context_proposal",
        payload: display.proposal,
        actions: [{ id: "create_context", kind: "tool" }],
        createdAt: "",
        updatedAt: "",
      } as never,
      "create_context",
      "",
    );
    expect(call).toMatchObject({ name: "contexts.create", args: { space: FIRBOT } });
    const made = await executeToolCall(ports, makeCtx(), {
      name: "contexts.create",
      args: { name: "Mazalup", kind: "client", space: FIRBOT },
    });
    expect(made.status).toBe("succeeded");
    expect(created[0]).toMatchObject({ name: "Mazalup", parentSpaceId: FIRBOT });
  });

  it("a Section can't be created under a Section, nor under an unknown Space", async () => {
    const { ports, created } = setup([]);
    for (const space of ["Administración", "Nowhere"]) {
      const out = await executeToolCall(ports, makeCtx(), {
        name: "contexts.create",
        args: { name: "X", kind: "project", space },
      });
      expect(out.status).toBe("failed");
    }
    expect(created).toHaveLength(0);
  });
});
