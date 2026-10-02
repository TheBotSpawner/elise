import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  chipsFor,
  conciseTitle,
  emptyEvidence,
  groupThreads,
  linksToAdd,
  matchesFilter,
  mentionedNodes,
  nodesMatching,
  recallTiers,
  scoreEvidence,
  type HistoryLinksPort,
  type KnowledgeNode,
  type ThreadLink,
} from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import type { RecallReader } from "@/core/recall/model";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const UNI = "a0000000-0000-4000-8000-000000000001";
const MATH = "a0000000-0000-4000-8000-000000000002";
const PHYS = "a0000000-0000-4000-8000-000000000003";
const WORK = "a0000000-0000-4000-8000-000000000004";
const CLIENT = "a0000000-0000-4000-8000-000000000005";
const OLD = "a0000000-0000-4000-8000-000000000006";

const NODES: KnowledgeNode[] = [
  { id: UNI, name: "University", parentId: null, parentName: null, archived: false },
  { id: MATH, name: "Mathematics", parentId: UNI, parentName: "University", archived: false },
  { id: PHYS, name: "Physics", parentId: UNI, parentName: "University", archived: false },
  { id: WORK, name: "Work", parentId: null, parentName: null, archived: false },
  { id: CLIENT, name: "Client A", parentId: WORK, parentName: "Work", archived: false },
  { id: OLD, name: "Old course", parentId: UNI, parentName: "University", archived: true },
];
const byId = new Map(NODES.map((n) => [n.id, n]));
const conv = (id: string): ThreadRef => ({ kind: "conversation", id });
const voice = (id: string): ThreadRef => ({ kind: "session", id });

describe("automatic tagging is conservative", () => {
  it("links the active Section and the Space a conversation started in", () => {
    const e = emptyEvidence();
    e.activated.add(MATH);
    e.scoped.add(WORK);
    expect(
      scoreEvidence(e, NODES)
        .map((s) => s.spaceId)
        .sort(),
    ).toEqual([MATH, WORK].sort());
  });

  it("links from Knowledge used in two turns, or substantially in one", () => {
    const twice = emptyEvidence();
    twice.knowledgeTurns.set(MATH, 2);
    expect(scoreEvidence(twice, NODES)[0]).toMatchObject({
      spaceId: MATH,
      evidence: ["knowledge"],
    });
    const once = emptyEvidence();
    once.knowledgeTurns.set(MATH, 1);
    once.knowledgePassages.set(MATH, 1);
    expect(scoreEvidence(once, NODES)).toEqual([]);
  });

  it("naming a Space or Section exactly links at once; a weak keyword never does", () => {
    const e = emptyEvidence();
    // "Quiero probar mi carrera de Ingeniería en Sistemas de la UTN": one explicit name.
    const utn: KnowledgeNode = {
      id: "utn",
      name: "UTN",
      parentId: null,
      parentName: null,
      archived: false,
    };
    const withUtn = [...NODES, utn];
    expect(
      mentionedNodes("Ah, y ELISE, quiero probar mi carrera de ingeniería en la UTN", withUtn),
    ).toEqual(["utn"]);
    e.mentionTurns.set("utn", 1);
    e.mentionTurns.set(MATH, 1);
    expect(
      scoreEvidence(e, withUtn)
        .map((s) => s.spaceId)
        .sort(),
    ).toEqual(["utn", MATH].sort());
    // "math" is not "Mathematics"; substrings never count.
    expect(mentionedNodes("can you help with math homework", NODES)).toEqual([]);
    expect(mentionedNodes("Repasemos Mathematics para el examen", NODES)).toEqual([MATH]);
    expect(mentionedNodes("lo de university physics", NODES).sort()).toEqual([UNI, PHYS].sort());
  });

  it("a generic Space name said once is not a topic; twice it is", () => {
    const e = emptyEvidence();
    e.mentionTurns.set(WORK, 1);
    e.mentionTurns.set(UNI, 1);
    expect(scoreEvidence(e, NODES)).toEqual([]);
    e.mentionTurns.set(WORK, 2);
    expect(scoreEvidence(e, NODES).map((s) => s.spaceId)).toEqual([WORK]);
  });

  it("allows several associations, but never more than a few on its own", () => {
    const e = emptyEvidence();
    for (const id of [MATH, PHYS, CLIENT, WORK, UNI]) e.activated.add(id);
    expect(scoreEvidence(e, NODES)).toHaveLength(3);
  });

  it("never links archived Sections automatically", () => {
    const e = emptyEvidence();
    e.activated.add(OLD);
    expect(scoreEvidence(e, NODES)).toEqual([]);
  });
});

describe("the user decides last", () => {
  const removed: ThreadLink = {
    thread: conv("c1"),
    spaceId: MATH,
    source: "manual",
    state: "removed",
    updatedAt: "2026-10-01T10:00:00Z",
  };
  const strong = { spaceId: MATH, confidence: 0.95, evidence: ["active_context"] };

  it("a removed tag is not put back by ongoing evidence", () => {
    expect(linksToAdd([strong], [removed])).toEqual([]);
    // …even with the Section still active, unless the user explicitly enters it again later.
    expect(linksToAdd([strong], [removed], new Map([[MATH, "2026-10-01T09:00:00Z"]]))).toEqual([]);
    expect(linksToAdd([strong], [removed], new Map([[MATH, "2026-10-01T11:00:00Z"]]))).toEqual([
      strong,
    ]);
  });

  it("is idempotent: an existing link is never added twice", () => {
    const linked: ThreadLink = { ...removed, state: "linked", source: "automatic" };
    expect(linksToAdd([strong], [linked])).toEqual([]);
  });
});

describe("History reads by Space and Section", () => {
  const rows = [
    { id: "exam", spaceIds: [MATH] },
    { id: "lab", spaceIds: [PHYS] },
    { id: "brief", spaceIds: [CLIENT, MATH] },
    { id: "uni-general", spaceIds: [UNI] },
    { id: "loose", spaceIds: [] },
  ];

  it("chips read [Space] [Section], follow renames and mark archived ones", () => {
    expect(chipsFor([MATH], byId).map((c) => c.label)).toEqual(["University", "Mathematics"]);
    const renamed = new Map(byId);
    renamed.set(MATH, { ...byId.get(MATH)!, name: "Calculus" });
    expect(chipsFor([MATH], renamed).map((c) => c.label)).toEqual(["University", "Calculus"]);
    expect(chipsFor([OLD], byId)[1]).toMatchObject({ label: "Old course", archived: true });
  });

  it("filters by Space (with its Sections), by Section, and untagged", () => {
    const pick = (f: Parameters<typeof matchesFilter>[1]) =>
      rows.filter((r) => matchesFilter(r.spaceIds, f, byId)).map((r) => r.id);
    expect(pick({ kind: "space", spaceId: UNI })).toEqual(["exam", "lab", "brief", "uni-general"]);
    expect(pick({ kind: "space", spaceId: UNI, sectionId: MATH })).toEqual(["exam", "brief"]);
    expect(pick({ kind: "untagged" })).toEqual(["loose"]);
  });

  it("search matches Space and Section names (a Space includes its Sections)", () => {
    expect(nodesMatching("mathem", NODES)).toEqual([MATH]);
    expect(new Set(nodesMatching("Client A", NODES))).toEqual(new Set([CLIENT]));
    expect(new Set(nodesMatching("university", NODES))).toEqual(new Set([UNI, MATH, PHYS, OLD]));
  });

  it("groups by Space or by Section; a multi-tagged thread appears in each", () => {
    const bySpace = groupThreads(rows, "space", byId, "Untagged", (s) => `${s} · general`);
    expect(bySpace.map((g) => [g.label, g.items.map((r) => r.id)])).toEqual([
      ["University", ["exam", "lab", "brief", "uni-general"]],
      ["Work", ["brief"]],
      ["Untagged", ["loose"]],
    ]);
    const bySection = groupThreads(rows, "section", byId, "Untagged", (s) => `${s} · general`);
    expect(bySection.map((g) => g.label)).toEqual([
      "Mathematics",
      "Physics",
      "Client A",
      "University · general",
      "Untagged",
    ]);
    expect(bySection[0]).toMatchObject({ parentLabel: "University" });
  });
});

describe("titles", () => {
  it("drop greetings and politeness, keep what it was about", () => {
    expect(conciseTitle("Hola ELISE, ¿me podrías mostrar mi calendario de hoy?")).toBe(
      "Mostrar mi calendario de hoy",
    );
    expect(conciseTitle("Hello ELISE, can you please show me today's calendar")).toBe(
      "Show me today's calendar",
    );
    expect(conciseTitle("I wanted to ask you about the meeting preparation")).toBe(
      "The meeting preparation",
    );
    expect(conciseTitle("Hola")).toBe("Hola");
    expect(conciseTitle("a".repeat(30) + " " + "b".repeat(50)).endsWith("…")).toBe(true);
  });
});

// ── Tools: Recall tiers, manual tags, voice threads ─────────────────────────

class FakeLinks implements HistoryLinksPort {
  links: ThreadLink[] = [];
  async nodes() {
    return NODES;
  }
  async linksOf(threads: ThreadRef[]) {
    return this.links.filter((l) =>
      threads.some((t) => t.kind === l.thread.kind && t.id === l.thread.id),
    );
  }
  async set(
    thread: ThreadRef,
    spaceId: string,
    state: ThreadLink["state"],
    source: ThreadLink["source"],
  ) {
    this.links = this.links.filter(
      (l) => !(l.thread.id === thread.id && l.thread.kind === thread.kind && l.spaceId === spaceId),
    );
    this.links.push({ thread, spaceId, state, source, updatedAt: new Date().toISOString() });
  }
  async threadsFor(spaceIds: string[]) {
    return this.links
      .filter((l) => l.state === "linked" && spaceIds.includes(l.spaceId))
      .map((l) => ({
        thread: l.thread,
        spaceId: l.spaceId,
        title: `t-${l.thread.id}`,
        at: "2026-10-01T10:00:00Z",
      }));
  }
}

/** A succeeded tool call's model-facing output. */
const output = (o: Awaited<ReturnType<typeof executeToolCall>>): unknown =>
  o.status === "succeeded" ? o.output : null;

function setup(
  hitsFor: (spaceIds: string[] | null | undefined) => boolean,
  ctx: Parameters<typeof makeCtx>[0] = {},
) {
  const links = new FakeLinks();
  const searches: (string[] | null | undefined)[] = [];
  const reader: RecallReader = {
    links,
    async search(q) {
      searches.push(q.spaceIds);
      return {
        semantic: false,
        hits: hitsFor(q.spaceIds)
          ? [
              {
                chunkId: "k1",
                sessionId: "s1",
                content: "We decided to move the exam.",
                startedAt: "2026-09-20T10:00:00Z",
                endedAt: "2026-09-20T10:05:00Z",
                similarity: null,
                keywordMatched: true,
                score: 1,
              },
            ]
          : [],
      };
    },
    async sessions() {
      return [
        {
          id: "s1",
          conversationId: "c-old",
          modality: "text" as const,
          title: "Exam plan",
          summary: null,
          topics: [],
          startedAt: "2026-09-20T10:00:00Z",
          lastActivityAt: "2026-09-20T10:05:00Z",
        },
      ];
    },
    async recent() {
      return [];
    },
    async turns() {
      return [];
    },
  };
  const { ports } = makePorts();
  ports.providers = {
    get: ((c: string) => (c === "history" ? reader : null)) as ProviderFactory["get"],
  };
  const call = (name: string, args: unknown) =>
    executeToolCall(ports, makeCtx(ctx), { name, args });
  return { call, links, searches };
}

describe("Recall scoped by Space and Section", () => {
  it("searches the active Section first", async () => {
    const { call, searches } = setup((s) => Boolean(s?.includes(MATH)), {
      context: { id: "p1", name: "Mathematics", kind: "custom", sectionSpaceId: MATH },
    });
    const out = await call("history.search", { query: "exam" });
    expect(out.status).toBe("succeeded");
    expect(searches[0]).toEqual([MATH]);
    expect((output(out) as { scope: string }).scope).toBe("conversations of Mathematics");
  });

  it("falls back to the parent Space, then everything", async () => {
    const parent = setup((s) => Boolean(s?.includes(UNI)), {
      context: { id: "p1", name: "Mathematics", kind: "custom", sectionSpaceId: MATH },
    });
    const out = await parent.call("history.search", { query: "exam" });
    expect(parent.searches.slice(0, 2)).toEqual([[MATH], [UNI, PHYS, OLD]]);
    expect((output(out) as { scope: string }).scope).toBe("conversations of University");

    const broad = setup((s) => s == null || s.length === 0);
    const named = await broad.call("history.search", { query: "exam", space: "Client A" });
    expect(broad.searches[0]).toEqual([CLIENT]);
    expect((output(named) as { enough: boolean }).enough).toBe(true);
  });

  it("tiers mirror Knowledge: Section → its Space and siblings", () => {
    expect(recallTiers(MATH, NODES)).toEqual([[MATH], [UNI, PHYS, OLD]]);
    expect(recallTiers(UNI, NODES)).toEqual([[UNI, MATH, PHYS, OLD]]);
  });
});

describe("History tag tools", () => {
  it("adds, lists and removes tags on a typed conversation", async () => {
    const { call, links } = setup(() => false, { conversationId: "c1" });
    expect(
      (await call("history.addKnowledgeLink", { space: "University › Mathematics" })).status,
    ).toBe("succeeded");
    expect(links.links[0]).toMatchObject({ spaceId: MATH, source: "manual", state: "linked" });
    const listed = await call("history.listKnowledgeLinks", { space: "University" });
    expect((output(listed) as { conversations: { section?: string }[] }).conversations).toEqual([
      expect.objectContaining({ section: "Mathematics", modality: "text" }),
    ]);
    await call("history.removeKnowledgeLink", { space: "Mathematics" });
    expect(links.links[0]).toMatchObject({ spaceId: MATH, state: "removed", source: "manual" });
  });

  it("voice sessions take part in the same tags", async () => {
    const { call, links } = setup(() => false, { interactionSessionId: "v1" });
    await call("history.addKnowledgeLink", { space: "Client A" });
    expect(links.links[0]!.thread).toEqual(voice("v1"));
    const listed = await call("history.listKnowledgeLinks", { space: "Work" });
    expect(
      (output(listed) as { conversations: { modality: string }[] }).conversations[0]!.modality,
    ).toBe("voice");
  });

  it("asks when a name is ambiguous instead of guessing", async () => {
    const { call } = setup(() => false, { conversationId: "c1" });
    const out = await call("history.addKnowledgeLink", { space: "zzz-nothing" });
    expect(out.status).toBe("failed");
  });
});
