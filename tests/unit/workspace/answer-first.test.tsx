// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall } from "@/core/agents/executor";
import { runElise } from "@/core/agents/runtime";
import type { KnowledgeEvidence } from "@/core/agents/tools";
import { WORKSPACE_TOOLS } from "@/core/tools/workspace";
import { knowledgeSurface } from "@/core/workspace/from-results";
import {
  applyOps,
  emptyWorkspace,
  primarySurface,
  type Surface,
  type WorkspaceOp,
  type WorkspaceState,
} from "@/core/workspace/model";
import type { WorkspacePort } from "@/core/workspace/port";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { ANSWER_HINT } from "@/core/workspace/representation";
import { evidenceSources } from "@/features/chat/message-thread";
import { AnswerBody } from "@/features/workspace/answer-view";
import { I18nProvider } from "@/lib/i18n/client";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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

const passage = (
  ref: number,
  itemId: string,
  title: string,
  snippet: string,
): KnowledgeEvidence => ({
  ref,
  itemId,
  chunkId: `c${ref}`,
  title,
  section: null,
  page: null,
  sourceType: "upload",
  url: null,
  versionNumber: 1,
  spaceName: "Firbot Marketing",
  snippet,
});

/** "¿Cuáles son los principales competidores de Firbot?" — the search result on screen. */
function afterCompetitorSearch() {
  const ws = new FakeWorkspace();
  const evidence = [
    passage(
      1,
      "doc-ci",
      "Firbot Competitive Intelligence Report",
      "CenteIA es el competidor más cercano…",
    ),
    passage(
      2,
      "doc-ci",
      "Firbot Competitive Intelligence Report",
      "Ivan AlsiGo: casos de automatización…",
    ),
    passage(3, "doc-res", "Resumen de Competidores", "Anders Jensen: claridad práctica, B2B…"),
  ];
  const draft = knowledgeSurface(evidence, true, { key: "call-1", query: "competidores Firbot" })!;
  ws.apply([{ op: "present", at: "2026-10-16T12:00:00Z", surface: draft }]);
  return ws;
}

const competitors = {
  intent: "entities",
  title: "Mapa competitivo · Firbot",
  items: [
    {
      title: "CenteIA",
      badge: "Directo",
      group: "Competidor más cercano",
      description: "Audiencia y dolor similares.",
      sources: ["[1]"],
    },
    {
      title: "Ivan AlsiGo",
      badge: "Referente",
      group: "Referentes",
      description: "Casos concretos de automatización de oficina.",
      sources: ["[2]"],
    },
    {
      title: "Anders Jensen",
      badge: "Referente",
      group: "Referentes",
      description: "Claridad práctica y B2B.",
      sources: ["[3]"],
    },
  ],
};

const answerOf = (ws: FakeWorkspace) =>
  ws.state().surfaces.find((s) => s.type === "answer") as Surface<SurfacePayloads["answer"]>;

describe("answer first (ADR-071)", () => {
  it("a competitor question shows the competitors, not the document; sources stay traceable", async () => {
    const ws = afterCompetitorSearch();
    expect(ws.state().surfaces[0]!.type).toBe("knowledge_result");
    const { ports } = makePorts([]);
    const out = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: competitors,
    });
    expect(out).toMatchObject({ status: "succeeded", output: { shown: "entities", items: 3 } });
    const answer = answerOf(ws);
    // The answer leads; the document card steps back behind "Fuentes".
    expect(primarySurface(ws.state())!.type).toBe("answer");
    expect(ws.state().surfaces.map((s) => s.type)).toEqual(["answer"]);
    // The source's own distinctions survive (direct vs reference), as words.
    expect(answer.payload.items.map((i) => [i.title, i.badge])).toEqual([
      ["CenteIA", "Directo"],
      ["Ivan AlsiGo", "Referente"],
      ["Anders Jensen", "Referente"],
    ]);
    // Each item points at the exact document it came from.
    expect(answer.payload.sources).toEqual([
      {
        title: "Firbot Competitive Intelligence Report",
        url: "/knowledge/items/doc-ci",
        kind: "knowledge",
        space: "Firbot Marketing",
      },
      {
        title: "Resumen de Competidores",
        url: "/knowledge/items/doc-res",
        kind: "knowledge",
        space: "Firbot Marketing",
      },
    ]);
    expect(answer.payload.items.map((i) => i.sources)).toEqual([[0], [0], [1]]);
  });

  it("asking for the document keeps the source card (no answer, or keepSources)", async () => {
    const ws = afterCompetitorSearch();
    // "Abrime el informe de competidores": the search alone — the document card IS the answer.
    expect(primarySurface(ws.state())!.type).toBe("knowledge_result");
    const { ports } = makePorts([]);
    await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: {
        intent: "summary",
        title: "Qué dice el informe",
        keepSources: true,
        items: [{ title: "CenteIA es el más cercano", sources: ["[1]"] }],
      },
    });
    expect(
      ws
        .state()
        .surfaces.map((s) => s.type)
        .sort(),
    ).toEqual(["answer", "knowledge_result"]);
  });

  it("a top 10 is a ranking with its figures and their web source", async () => {
    const ws = new FakeWorkspace();
    ws.apply([
      {
        op: "present",
        at: "2026-10-16T12:00:00Z",
        surface: {
          id: "w1",
          type: "web_results",
          title: "Tabla de posiciones",
          state: "ready",
          priority: 62,
          size: "medium",
          source: null,
          ref: null,
          payload: {
            query: "tabla liga",
            retrievedAt: "2026-10-16T12:00:00Z",
            results: [
              {
                title: "Tabla de posiciones",
                url: "https://example.com/tabla",
                domain: "example.com",
                snippet: "River 31, Boca 29",
                publishedAt: null,
                inspected: false,
                passages: [],
              },
            ],
          },
          actions: [],
          intentId: null,
        },
      } as never,
    ]);
    const { ports } = makePorts([]);
    const out = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: {
        intent: "ranking",
        title: "Tabla · Top 2",
        items: [
          { title: "River Plate", value: "31 pts", sources: ["https://example.com/tabla"] },
          { title: "Boca Juniors", value: "29 pts", sources: ["https://example.com/tabla"] },
        ],
      },
    });
    expect(out.status).toBe("succeeded");
    const answer = answerOf(ws);
    expect(answer.payload.items.map((i) => [i.rank, i.title, i.value])).toEqual([
      [1, "River Plate", "31 pts"],
      [2, "Boca Juniors", "29 pts"],
    ]);
    expect(answer.payload.sources[0]).toMatchObject({
      url: "https://example.com/tabla",
      kind: "web",
    });
    expect(ws.state().surfaces.some((s) => s.type === "web_results")).toBe(false);
  });

  it("a comparison needs criteria and a value per option", async () => {
    const ws = afterCompetitorSearch();
    const { ports } = makePorts([]);
    const bad = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: { intent: "comparison", title: "CenteIA vs Firbot", items: competitors.items },
    });
    expect(bad).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    const ok = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: {
        intent: "comparison",
        title: "CenteIA vs Firbot",
        columns: [
          { key: "aud", label: "Audiencia" },
          { key: "len", label: "Duración" },
        ],
        items: [
          { title: "CenteIA", cells: { aud: "Pymes", len: "Largo" }, sources: ["[1]"] },
          { title: "Firbot 10H", cells: { aud: "Pymes", len: "10 horas" }, sources: ["[1]"] },
        ],
      },
    });
    expect(ok.status).toBe("succeeded");
    expect(answerOf(ws)).toMatchObject({ size: "large", payload: { intent: "comparison" } });
  });

  it("never shows a figure or source the evidence doesn't hold", async () => {
    const ws = afterCompetitorSearch();
    const { ports } = makePorts([]);
    // [9] isn't among the results: the metric's figure has nowhere to come from.
    const invented = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: {
        intent: "metrics",
        title: "Gastos",
        metrics: [{ label: "Octubre", value: "$12.400", sources: ["[9]"] }],
      },
    });
    expect(invented).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    const noSource = await executeToolCall(ports, makeCtx({ workspace: ws }), {
      name: "ui.answer",
      args: { intent: "list", title: "X", items: [{ title: "Sin fuente", sources: [] }] },
    });
    expect(noSource.status).toBe("failed");
    // Nothing changed on screen.
    expect(ws.state().surfaces.map((s) => s.type)).toEqual(["knowledge_result"]);
  });

  it("is shown in the same response as the words: no extra model call", async () => {
    const ws = afterCompetitorSearch();
    const { ports } = makePorts([]);
    ports.registry.register(...WORKSPACE_TOOLS.filter((t) => !ports.registry.get(t.name)));
    const ai = new ScriptedAI([
      () => [
        { type: "text_delta", delta: "CenteIA es el más directo; los demás son referentes." },
        {
          type: "tool_call",
          callId: "a",
          name: "ui.answer",
          arguments: JSON.stringify(competitors),
        },
        { type: "completed", model: "m", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    for await (const _ of runElise({
      ai,
      ports,
      ctx: makeCtx({ workspace: ws, userMessage: "¿Cuáles son los competidores de Firbot?" }),
      instructions: "",
      input: [],
      tools: WORKSPACE_TOOLS,
    }))
      void _;
    expect(ai.requests).toHaveLength(1);
    expect(answerOf(ws)).toBeTruthy();
  });

  it("the model is told: answer first, source when asked, figures only as sourced", () => {
    const text = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "UTC" },
      now: new Date("2026-10-16T12:00:00Z"),
      availableCapabilities: ["knowledge", "workspace"],
      history: [],
      userMessage: "¿Cuáles son los competidores de Firbot?",
    }).instructions;
    expect(text).toContain("Answer first, source second");
    expect(text).toContain("The source IS the answer only when the user asks for it");
    expect(text).toContain("Never invent structure or numbers");
    expect(ANSWER_HINT).toContain("ui.answer");
  });
});

const wrap = (ui: React.ReactElement) => render(<I18nProvider locale="es">{ui}</I18nProvider>);

const payload = (n: number): SurfacePayloads["answer"] => ({
  intent: "entities",
  items: Array.from({ length: n }, (_, i) => ({
    title: `Item ${i + 1}`,
    badge: i === 0 ? "Directo" : "Referente",
    description: "Una línea.",
    sources: [i % 2],
  })),
  sources: [
    {
      title: "Firbot Competitive Intelligence Report",
      url: "/knowledge/items/doc-ci",
      kind: "knowledge",
      space: "Firbot Marketing",
    },
    { title: "Página", url: "https://example.com", kind: "web" },
  ],
});

describe("the answer Surface", () => {
  it("badges are words; sources are collapsed and open the exact documents", () => {
    wrap(<AnswerBody p={payload(3)} large={false} />);
    expect(screen.getByText("Directo")).toBeInTheDocument();
    const summary = screen.getByText("Fuentes · 2");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(
      screen.getByRole("link", { name: /Firbot Competitive Intelligence Report/ }),
    ).toHaveAttribute("href", "/knowledge/items/doc-ci");
    expect(screen.getByRole("link", { name: /Página/ })).toHaveAttribute("target", "_blank");
  });

  it("long answers show the first eight, then 'Ver todos'", () => {
    wrap(<AnswerBody p={payload(12)} large={false} />);
    expect(
      screen.getAllByRole("listitem").filter((li) => /Item \d+/.test(li.textContent ?? "")),
    ).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Ver todos (12)" }));
    expect(screen.getByText("Item 12")).toBeInTheDocument();
  });

  it("a comparison is cards on a narrow canvas (no sideways scrolling)", () => {
    wrap(
      <AnswerBody
        p={{
          intent: "comparison",
          columns: [{ key: "aud", label: "Audiencia" }],
          items: [{ title: "CenteIA", cells: { aud: "Pymes" }, sources: [0] }],
          sources: [{ title: "Doc", url: null, kind: "knowledge" }],
        }}
        large={false}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    const card = screen.getByText("CenteIA").closest("li")!;
    expect(within(card).getByText("Pymes")).toBeInTheDocument();
  });
});

describe("sources in the conversation", () => {
  it("two Knowledge searches are one 'Fuentes' list of named documents, not two generic chips", () => {
    const tool = (callId: string, evidence: KnowledgeEvidence[]) =>
      ({
        callId,
        name: "knowledge.search",
        surfaceIds: ["s"],
        outcome: {
          status: "succeeded",
          display: { kind: "knowledge_evidence", scope: [], enough: true, evidence },
        },
      }) as never;
    const { docs, other } = evidenceSources([
      tool("a", [passage(1, "doc-ci", "Firbot Competitive Intelligence Report", "x")]),
      tool("b", [
        passage(1, "doc-ci", "Firbot Competitive Intelligence Report", "y"),
        passage(2, "doc-res", "Resumen de Competidores", "z"),
      ]),
    ]);
    expect(docs.map(([, d]) => d.title)).toEqual([
      "Firbot Competitive Intelligence Report",
      "Resumen de Competidores",
    ]);
    expect(other).toEqual([]);
  });
});
