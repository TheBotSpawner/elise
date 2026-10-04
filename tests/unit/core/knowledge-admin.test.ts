import { describe, expect, it } from "vitest";

import {
  executeApprovedAction,
  executeToolCall,
  INTERNAL_CONNECTION_ID,
} from "@/core/agents/executor";
import type { KnowledgeManager, SpaceOverview } from "@/core/knowledge/admin";
import type { KnowledgeReader, SpaceInfo } from "@/core/knowledge/model";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * ELISE manages her Knowledge (ADR-035): typed tools over the same services as the UI, with
 * deterministic approvals; and a Space's own description/context is Knowledge — read directly,
 * not through embeddings. In-memory Knowledge; no database, no embeddings.
 */

interface FakeSpace {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
  context: string | null;
}
interface FakeDoc {
  id: string;
  spaceId: string;
  title: string;
  status: string;
  detail: string | null;
}

function fakeKnowledge() {
  const spaces: FakeSpace[] = [
    {
      id: "s-acme",
      name: "Acme Automation",
      parentId: null,
      description:
        "Acme Automation helps small businesses reduce repetitive administrative work through automation.",
      context: null,
    },
    {
      id: "s-uni",
      name: "University",
      parentId: null,
      description: "My university studies.",
      context: null,
    },
    {
      id: "s-calc",
      name: "Calculus II",
      parentId: "s-uni",
      description: null,
      context: "Second-year mathematics course focused on integrals and series.",
    },
    {
      id: "s-photo",
      name: "Photography",
      parentId: null,
      description: "Street photography notes.",
      context: null,
    },
  ];
  const docs: FakeDoc[] = [
    {
      id: "11111111-1111-4111-8111-111111111111",
      spaceId: "s-calc",
      title: "Apunte integrales.pdf",
      status: "ready",
      detail: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      spaceId: "s-calc",
      title: "Libro escaneado.pdf",
      status: "needs_attention",
      detail: "This PDF has no readable text (it may be scanned images)",
    },
  ];
  const calls: { op: string; args: unknown[] }[] = [];
  const rec = (op: string, ...args: unknown[]) => void calls.push({ op, args });
  const path = (s: FakeSpace) =>
    s.parentId ? `${spaces.find((p) => p.id === s.parentId)!.name} › ${s.name}` : s.name;
  const overview = (s: FakeSpace): SpaceOverview => {
    const mine = docs.filter((d) => d.spaceId === s.id);
    return {
      id: s.id,
      name: s.name,
      path: path(s),
      parentId: s.parentId,
      description: s.description,
      context: s.context,
      sections: spaces.filter((c) => c.parentId === s.id).length,
      sources: mine.length,
      documents: {
        ready: mine.filter((d) => d.status === "ready").length,
        processing: 0,
        attention: mine.filter((d) => d.status === "needs_attention").length,
      },
    };
  };
  const impl: KnowledgeReader & KnowledgeManager = {
    async spaces(): Promise<SpaceInfo[]> {
      return spaces.map((s) => ({
        id: s.id,
        name: s.name,
        parentId: s.parentId,
        path: path(s),
        aliases: [],
        description: s.description,
        context: s.context,
      }));
    },
    // No embeddings, no matching chunks: what's left is the Space's own metadata.
    search: async () => ({ hits: [], semantic: true }),
    getItem: async () => null,
    listSources: async () => [],
    recentChanges: async () => [],
    versionText: async () => null,
    overview: async () => ({ total: 0, items: [] }),
    listSpaces: async () => spaces.map(overview),
    async contents(id) {
      const s = spaces.find((x) => x.id === id)!;
      const parent = s.parentId ? spaces.find((p) => p.id === s.parentId)! : null;
      return {
        space: overview(s),
        parent: parent
          ? { name: parent.name, description: parent.description, context: parent.context }
          : null,
        sections: spaces
          .filter((c) => c.parentId === id)
          .map((c) => ({ id: c.id, name: c.name, description: c.description })),
        sources: [
          {
            id: "src-drive",
            name: "Carpeta Cálculo",
            type: "google_drive",
            status: "ok",
            documents: { ready: 3, processing: 0, attention: 0 },
            lastSyncedAt: null,
            lastError: null,
          },
        ],
        documents: docs
          .filter((d) => d.spaceId === id)
          .map((d) => ({
            id: d.id,
            title: d.title,
            type: "upload",
            status: d.status,
            detail: d.detail,
          })),
      };
    },
    async createSpace(input) {
      rec("createSpace", input);
      const id = `s-${spaces.length + 1}`;
      spaces.push({
        id,
        name: input.name,
        parentId: input.parentId ?? null,
        description: input.description ?? null,
        context: null,
      });
      return { id, section: Boolean(input.parentId) };
    },
    async updateSpace(id, patch) {
      rec("updateSpace", id, patch);
      Object.assign(
        spaces.find((s) => s.id === id)!,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.context !== undefined ? { context: patch.context } : {}),
        },
      );
    },
    archiveSpace: async (id) => rec("archiveSpace", id),
    moveDocument: async (id, to) => rec("moveDocument", id, to),
    removeDocument: async (id) => rec("removeDocument", id),
    removeSource: async (id) => rec("removeSource", id),
    retryDocuments: async (ids) => (rec("retryDocuments", ids), ids.length),
    syncSource: async (id) => (rec("syncSource", id), "started" as const),
    saveAttachment: async (id, to) => (
      rec("saveAttachment", id, to),
      { itemId: `i-${id}`, title: "chapter.pdf" }
    ),
  };
  const { ports, log } = makePorts(undefined, { internal: impl });
  const call = (name: string, args: unknown) => executeToolCall(ports, makeCtx(), { name, args });
  return { call, calls, spaces, ports, log };
}

const out = (o: unknown) => (o as { output: Record<string, unknown> }).output;

describe("inspecting Knowledge (structure, not search)", () => {
  it("lists Spaces and Sections with what each is about and how much is in it", async () => {
    const k = fakeKnowledge();
    const r = await k.call("knowledge.listSpaces", {});
    const spaces = out(r).spaces as { path: string; description?: string; context?: string }[];
    expect(spaces.find((s) => s.path === "Acme Automation")?.description).toMatch(
      /administrative work/,
    );
    expect(spaces.find((s) => s.path === "University › Calculus II")).toMatchObject({
      context: expect.stringMatching(/integrals/),
      needsAttention: 1,
    });
  });

  it("a Section shows its own context, its parent's, inheritance, documents with status and Drive", async () => {
    const k = fakeKnowledge();
    const o = out(await k.call("knowledge.getSpace", { space: "Calculus II" }));
    expect(o.metadata).toMatchObject({
      sourceKind: "knowledge_section_metadata",
      context: expect.stringMatching(/integrals and series/),
      parentSpace: { name: "University", description: "My university studies." },
      inheritance: expect.stringMatching(/parent Space/),
    });
    expect(o.documents).toEqual([
      expect.objectContaining({ title: "Apunte integrales.pdf", status: "ready" }),
      expect.objectContaining({
        title: "Libro escaneado.pdf",
        status: "needs_attention",
        detail: expect.stringMatching(/no readable text/),
      }),
    ]);
    expect(o.connectedSources).toEqual([expect.objectContaining({ type: "google_drive" })]);
  });
});

describe("organizing Knowledge", () => {
  it("creates a Space, then a Section inside it — defaults, no type, no questions", async () => {
    const k = fakeKnowledge();
    await k.call("knowledge.createSpace", { name: "Francés", description: "Aprender francés." });
    const r = await k.call("knowledge.createSpace", { name: "Gramática", parent: "Francés" });
    expect(r).toMatchObject({
      status: "succeeded",
      output: { created: "Francés › Gramática", section: true },
    });
    expect(k.calls.map((c) => c.op)).toEqual(["createSpace", "createSpace"]);
    expect(k.calls[1]!.args[0]).toMatchObject({ name: "Gramática", parentId: expect.any(String) });
  });

  it("Sections stay one level deep", async () => {
    const k = fakeKnowledge();
    const r = await k.call("knowledge.createSpace", { name: "Integrales", parent: "Calculus II" });
    expect(r).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
  });

  it("an ambiguous destination is a question, a single match just works", async () => {
    const k = fakeKnowledge();
    await k.call("knowledge.createSpace", { name: "Calculus III", parent: "University" });
    const r = await k.call("knowledge.getSpace", { space: "Calculus" });
    expect(r).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect((r as { error: { message: string } }).error.message).toMatch(
      /Calculus II.*Calculus III|Calculus III.*Calculus II/,
    );
    expect(await k.call("knowledge.getSpace", { space: "calculus ii" })).toMatchObject({
      status: "succeeded",
    });
  });

  it("renames and adds to context on request — effective immediately for ELISE", async () => {
    const k = fakeKnowledge();
    await k.call("knowledge.updateSpace", {
      space: "Calculus II",
      addToContext: "El final es en diciembre.",
    });
    const o = out(await k.call("knowledge.getSpace", { space: "Calculus II" }));
    expect((o.metadata as { context: string }).context).toMatch(
      /integrals and series\.\nEl final es en diciembre\./,
    );
    await k.call("knowledge.updateSpace", {
      space: "Acme Automation",
      description: "We also build AI assistants.",
    });
    const s = out(
      await k.call("knowledge.search", { query: "What does Acme do?", space: "Acme Automation" }),
    );
    expect((s.scopeMetadata as { description: string }[])[0]!.description).toBe(
      "We also build AI assistants.",
    );
  });

  it("moves a document, retries the failed ones, syncs Drive, saves attachments", async () => {
    const k = fakeKnowledge();
    const doc = "11111111-1111-4111-8111-111111111111";
    await k.call("knowledge.moveDocument", { document: doc, to: "University" });
    expect(k.calls.at(-1)).toEqual({ op: "moveDocument", args: [doc, "s-uni"] });
    // Asked about the Space, the failed document lives in its Section: still found.
    const retried = await k.call("knowledge.retry", { failed: true, space: "University" });
    expect(out(retried).retried).toBe(1);
    expect(k.calls.at(-1)).toEqual({
      op: "retryDocuments",
      args: [["22222222-2222-4222-8222-222222222222"]],
    });
    const a = "33333333-3333-4333-8333-333333333333";
    const saved = await k.call("knowledge.saveAttachment", {
      attachments: [a],
      space: "Calculus II",
    });
    expect(saved).toMatchObject({
      status: "succeeded",
      output: { to: "University › Calculus II" },
    });
    expect(k.calls.at(-1)).toEqual({ op: "saveAttachment", args: [a, "s-calc"] });
  });

  it("archiving and removing always ask first — nothing happens before approval", async () => {
    const k = fakeKnowledge();
    const archive = await k.call("knowledge.archiveSpace", { space: "Photography" });
    expect(archive).toMatchObject({
      status: "approval_required",
      summary: "Archivar “Photography” (0 documentos)",
    });
    const remove = await k.call("knowledge.remove", {
      document: "11111111-1111-4111-8111-111111111111",
    });
    expect(remove).toMatchObject({ status: "approval_required" });
    expect(k.calls).toEqual([]);
  });
});

describe("approving an internal action", () => {
  it("an approved archive runs through ELISE's internal binding (no provider account)", async () => {
    const k = fakeKnowledge();
    await k.call("knowledge.archiveSpace", { space: "Photography" });
    const approval = k.log.approvals[0]!;
    const action = k.log.actions.get(approval.actionId)!;
    const done = await executeApprovedAction(k.ports, makeCtx({ origin: "user_ui" }), {
      actionId: approval.actionId,
      approvalId: approval.id,
      toolName: "knowledge.archiveSpace",
      input: action.input,
      connectionId: INTERNAL_CONNECTION_ID,
      payloadHash: approval.payloadHash,
    });
    expect(done).toMatchObject({ status: "succeeded", output: { archived: "Photography" } });
    expect(k.calls).toEqual([{ op: "archiveSpace", args: ["s-photo"] }]);
  });
});

describe("a Space's own metadata is Knowledge", () => {
  it("'What is Acme Automation?' — no documents, no vector matches: the description answers", async () => {
    const k = fakeKnowledge();
    const o = out(
      await k.call("knowledge.search", {
        query: "What is Acme Automation?",
        space: "Acme Automation",
      }),
    );
    expect(o.enoughEvidence).toBe(false);
    expect(o.scopeMetadata).toEqual([
      expect.objectContaining({
        sourceKind: "knowledge_space_metadata",
        path: "Acme Automation",
        description: expect.stringMatching(/reduce repetitive administrative work/),
      }),
    ]);
    expect(o.instructions).toMatch(/description/i);
    expect(o.instructions).not.toMatch(/does not contain enough evidence/);
  });

  it("a Section brings its parent Space's description; unrelated Spaces stay out", async () => {
    const k = fakeKnowledge();
    const o = out(
      await k.call("knowledge.search", { query: "What is this subject?", space: "Calculus II" }),
    );
    expect(o.scopeMetadata).toEqual([
      expect.objectContaining({
        sourceKind: "knowledge_section_metadata",
        context: expect.stringMatching(/integrals/),
        parentSpace: expect.objectContaining({ description: "My university studies." }),
      }),
    ]);
    expect(JSON.stringify(o)).not.toMatch(/Photography|Acme/);
  });

  it("an empty Space is still answerable from its description", async () => {
    const k = fakeKnowledge();
    const o = out(
      await k.call("knowledge.search", {
        query: "What is my Photography space about?",
        space: "Photography",
      }),
    );
    expect((o.scopeMetadata as { description: string }[])[0]!.description).toBe(
      "Street photography notes.",
    );
  });
});
