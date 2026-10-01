import { describe, expect, it } from "vitest";

import type { AIProvider, AIStreamEvent, AITurnRequest } from "@/core/agents/ai-provider";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import type { ContextProfile, ContextStore } from "@/core/contexts/model";
import type { KnowledgeHit, KnowledgeReader } from "@/core/knowledge/model";
import { generateQuestion, quizChoice } from "@/core/study/ai";
import {
  applyAssessment,
  namesUnit,
  pickNextConcept,
  summarizeSession,
  unitNumbers,
  type Attempt,
  type StudyConcept,
  type StudySession,
  type StudyStore,
} from "@/core/study/model";
import { applyOps, emptyWorkspace, type WorkspaceOp } from "@/core/workspace/model";
import type { ActivityStep, WorkspacePort } from "@/core/workspace/port";
import { toolForAction, type SurfacePayloads } from "@/core/workspace/registry";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const NOW = new Date("2026-10-01T15:00:00Z");
const CONV = "88888888-8888-4888-8888-888888888888";
const SPACE = "33333333-3333-4333-8333-333333333333";
const U3 = "a0000000-0000-4000-8000-000000000003";
const U4 = "a0000000-0000-4000-8000-000000000004";
const U1 = "a0000000-0000-4000-8000-000000000001";

let seq = 0;
const uid = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`;

// ── Model ────────────────────────────────────────────────────────────────────

const concept = (label: string, over: Partial<StudyConcept> = {}): StudyConcept => ({
  id: uid(),
  label,
  summary: null,
  refs: [],
  status: "not_reviewed",
  score: 0,
  attempts: 0,
  lastAssessment: null,
  lastReviewedAt: null,
  ...over,
});

describe("study mastery", () => {
  it("moves concepts through understandable states, never percentages", () => {
    const at = NOW.toISOString();
    let c = concept("Weber");
    c = { ...c, ...applyAssessment(c, "strong", 0, at) };
    expect(c).toMatchObject({ status: "learning", score: 2, attempts: 1 });
    c = { ...c, ...applyAssessment(c, "strong", 0, at) };
    expect(c.status).toBe("understood");
    c = { ...c, ...applyAssessment(c, "needs_review", 0, at) };
    expect(c.status).toBe("needs_review");
    // Two hints turn a strong answer into a partial one.
    expect(applyAssessment(concept("x"), "strong", 2, at).lastAssessment).toBe("partial");
  });

  it("asks weak concepts again later, from another angle, never twice in a row", () => {
    const weak = concept("Taylor", { status: "needs_review", attempts: 1 });
    const fresh = concept("Fayol");
    const solid = concept("Weber", { status: "understood", attempts: 3 });
    expect(pickNextConcept([weak, fresh, solid], [])?.label).toBe("Taylor");
    // Just asked: not immediately again.
    expect(pickNextConcept([weak, fresh, solid], [weak.id])?.label).toBe("Fayol");
    // A weak concept comes back before an understood one is repeated.
    expect(pickNextConcept([weak, fresh, solid], [weak.id, fresh.id])?.label).toBe("Taylor");
    expect(pickNextConcept([weak, solid], [weak.id])?.label).toBe("Weber");
    expect(pickNextConcept([], [])).toBeNull();
  });

  it("reads units as said and finds them in titles and sections", () => {
    expect(unitNumbers("tomame las unidades 3 y 4")).toEqual(["3", "4"]);
    expect(unitNumbers("Unit 2")).toEqual(["2"]);
    expect(unitNumbers("solo Weber")).toEqual([]);
    expect(namesUnit("Unidad 3 — Burocracia", "3")).toBe(true);
    expect(namesUnit("U03 Weber", "3")).toBe(true);
    expect(namesUnit("Unidad 13", "3")).toBe(false);
  });

  it("summarizes a session from its attempts", () => {
    const a = (
      label: string,
      assessment: Attempt["assessment"],
      incorrect: string[] = [],
    ): Attempt => ({
      id: uid(),
      conceptId: null,
      conceptLabel: label,
      question: "q",
      answer: "a",
      assessment,
      feedback: { correct: [], missing: [], incorrect, explanation: "", refs: [] },
      hintsUsed: 0,
      createdAt: NOW.toISOString(),
    });
    const s = summarizeSession(
      [
        a("Weber", "strong"),
        a("Taylor", "partial"),
        a("Mayo", "needs_review", ["Mayo was an engineer"]),
      ],
      NOW.toISOString(),
    );
    expect(s).toMatchObject({
      questions: 3,
      strong: ["Weber"],
      review: ["Mayo", "Taylor"],
      mistakes: ["Mayo was an engineer"],
      nextReview: ["Mayo", "Taylor"],
    });
  });

  it("parses quiz choices and still asks a grounded question without AI", async () => {
    expect(quizChoice("la b", ["x", "y", "z", "w"])).toBe(1);
    expect(quizChoice("z", ["x", "y", "z", "w"])).toBe(2);
    expect(quizChoice("no sé", ["x", "y"])).toBeNull();
    const q = await generateQuestion(null, {
      subject: "Administración",
      concept: {
        label: "Burocracia de Weber",
        summary: "Organización basada en reglas impersonales",
      },
      angle: "explain",
      mode: "oral_exam",
      difficulty: "normal",
      evidence: [],
      previous: [],
      locale: "es",
    });
    expect(q.question).toContain("Burocracia de Weber");
    expect(q.hints).toHaveLength(3);
  });
});

// ── Sessions through the executor ───────────────────────────────────────────

class FakeWorkspace implements WorkspacePort {
  value = emptyWorkspace();
  state() {
    return this.value;
  }
  apply(ops: WorkspaceOp[]) {
    this.value = applyOps(this.value, ops);
  }
  activity(step: ActivityStep) {
    void step;
  }
}

class FakeStudyStore implements StudyStore {
  conceptsList: (StudyConcept & { contextId: string })[] = [];
  sessions = new Map<string, StudySession>();
  attemptsList: (Attempt & { sessionId: string })[] = [];
  async concepts(contextId: string) {
    return this.conceptsList.filter((c) => c.contextId === contextId);
  }
  async saveConcepts(
    contextId: string,
    drafts: { label: string; summary: string | null; refs: StudyConcept["refs"] }[],
  ) {
    for (const d of drafts)
      if (
        !this.conceptsList.some(
          (c) => c.contextId === contextId && c.label.toLowerCase() === d.label.toLowerCase(),
        )
      )
        this.conceptsList.push({
          ...concept(d.label, { summary: d.summary, refs: d.refs }),
          contextId,
        });
    return this.concepts(contextId);
  }
  async updateConcept(id: string, patch: Partial<StudyConcept>) {
    Object.assign(
      this.conceptsList.find((c) => c.id === id)!,
      patch,
    );
  }
  async activeSession() {
    return [...this.sessions.values()].find((s) => s.status === "active") ?? null;
  }
  async session(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async lastSession() {
    return [...this.sessions.values()].at(-1) ?? null;
  }
  async createSession(input: Parameters<StudyStore["createSession"]>[0]) {
    const s: StudySession = {
      id: uid(),
      contextId: input.contextId,
      mode: input.mode,
      status: "active",
      scope: input.scope,
      preferences: input.preferences,
      current: null,
      questionCount: 0,
      startedAt: NOW.toISOString(),
      lastActivityAt: NOW.toISOString(),
      endedAt: null,
      summary: null,
    };
    this.sessions.set(s.id, s);
    return s;
  }
  async saveSession(id: string, patch: Partial<StudySession>) {
    this.sessions.set(id, { ...this.sessions.get(id)!, ...patch });
  }
  async addAttempt(sessionId: string, a: Omit<Attempt, "id" | "createdAt">) {
    this.attemptsList.push({ ...a, id: uid(), createdAt: NOW.toISOString(), sessionId });
  }
  async attempts(sessionId: string) {
    return this.attemptsList.filter((a) => a.sessionId === sessionId);
  }
  async recentAttempts() {
    return this.attemptsList;
  }
}

/** Answers each Study prompt by what it asks for; records every request. */
class RouterAI implements AIProvider {
  readonly id = "router";
  requests: AITurnRequest[] = [];
  assessment: "strong" | "partial" | "needs_review" = "partial";
  quiz = false;
  async *streamTurn(req: AITurnRequest): AsyncIterable<AIStreamEvent> {
    this.requests.push(req);
    let json: unknown;
    if (req.instructions.includes("key concepts"))
      json = {
        concepts: [
          { label: "Burocracia de Weber", summary: "Reglas impersonales y jerarquía.", refs: [1] },
          {
            label: "Experimento Hawthorne",
            summary: "Factores humanos y productividad.",
            refs: [2],
          },
        ],
      };
    else if (req.instructions.includes("You are an examiner"))
      json = {
        question: `¿Qué problema intentaba resolver ${req.input[0]!.type === "message" && req.input[0]!.content.includes("Hawthorne") ? "Mayo" : "Weber"}?`,
        keyPoints: ["SECRET-KEYPOINT eficiencia con reglas impersonales"],
        hints: ["SECRET-HINT-1", "SECRET-HINT-2", "SECRET-HINT-3"],
        ...(this.quiz ? { options: ["a1", "a2", "a3", "a4"], correctOption: 1 } : {}),
      };
    else if (req.instructions.includes("You assess"))
      json = {
        assessment: this.assessment,
        correct: ["habló de reglas"],
        missing: ["la jerarquía"],
        incorrect: [],
        explanation: "Weber buscaba eficiencia con reglas impersonales.",
        refs: [1],
      };
    yield { type: "text_delta", delta: JSON.stringify(json) };
    yield { type: "completed", model: "router", usage: null };
  }
}

const hit = (itemId: string, title: string, section: string, content: string): KnowledgeHit => ({
  chunkId: uid(),
  itemId,
  versionId: "v",
  versionNumber: 1,
  title,
  itemType: "file",
  sourceType: "upload",
  sourceUrl: null,
  spaceId: SPACE,
  spaceName: "Administración",
  headingPath: [section],
  page: 3,
  content,
  similarity: 0.7,
  keywordMatched: true,
  score: 0.05,
});

const HITS = [
  hit(
    U3,
    "Unidad 3 — Burocracia",
    "Weber",
    "Weber propuso la burocracia: reglas impersonales y jerarquía.",
  ),
  hit(U4, "Unidad 4 — Relaciones humanas", "Hawthorne", "Mayo y el experimento Hawthorne."),
  hit(U1, "Unidad 1 — Introducción", "Intro", "Qué es la administración."),
];

function reader(): KnowledgeReader {
  return {
    spaces: async () => [
      { id: SPACE, name: "Administración", parentId: null, path: "Administración" },
    ],
    search: async (q: { itemIds: string[] | null }) => ({
      hits: HITS.filter((h) => !q.itemIds || q.itemIds.includes(h.itemId)),
      semantic: true,
    }),
    getItem: async () => null,
    listSources: async () => [],
    recentChanges: async () => [],
    versionText: async () => null,
    overview: async () => ({
      total: 3,
      items: HITS.map((h) => ({ itemId: h.itemId, title: h.title, preview: "" })),
    }),
  } as unknown as KnowledgeReader;
}

const ADMIN: ContextProfile = {
  id: "c0000000-0000-4000-8000-000000000001",
  kind: "study",
  name: "Administración",
  description: null,
  aliases: [],
  icon: null,
  accent: null,
  status: "active",
  instructions: null,
  study: { targetDate: null, objective: null, level: null },
  links: [
    {
      id: uid(),
      type: "knowledge_space",
      resourceId: SPACE,
      value: null,
      label: "Administración",
      confirmed: true,
    },
  ],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function setup(opts: { noMaterial?: boolean; noAI?: boolean } = {}) {
  const store = new FakeStudyStore();
  const ai = new RouterAI();
  const associations: string[] = [];
  const profile = opts.noMaterial ? { ...ADMIN, links: [] } : ADMIN;
  const contexts = {
    list: async () => [profile],
    entities: async () => [],
    associate: async (_id: string, _t: unknown, source: string) => void associations.push(source),
  } as unknown as ContextStore;
  const { ports } = makePorts();
  const byCapability: Record<string, unknown> = {
    study: { store, ai: opts.noAI ? null : ai },
    contexts,
    knowledge: reader(),
  };
  ports.providers = { get: ((c: string) => byCapability[c]) as ProviderFactory["get"] };
  const ws = new FakeWorkspace();
  const ctx = makeCtx({ workspace: ws, now: NOW, conversationId: CONV });
  const call = (name: string, args: unknown = {}) => executeToolCall(ports, ctx, { name, args });
  const question = () =>
    ws.value.surfaces.find((s) => s.type === "study_question")?.payload as
      SurfacePayloads["study_question"] | undefined;
  return { store, ai, ws, call, question, associations };
}

describe("study sessions", () => {
  it("starts grounded in the requested units and never leaks the answer", async () => {
    const { call, ws, question, store, ai, associations } = setup();
    const out = await call("study.start", {
      context: "Administración",
      mode: "oral_exam",
      scope: { units: ["3", "4"] },
    });
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    const o = out.output as { started: boolean; scope: string; question: { question: string } };
    expect(o).toMatchObject({ started: true, scope: "Unidades 3, 4" });
    // Concepts come only from units 3 and 4, with references back to the chunks.
    expect(store.conceptsList.map((c) => c.label).sort()).toEqual([
      "Burocracia de Weber",
      "Experimento Hawthorne",
    ]);
    expect(store.conceptsList.every((c) => c.refs[0] && [U3, U4].includes(c.refs[0].itemId))).toBe(
      true,
    );
    // The examiner saw the material; the model, the Surface and the voice see only the question.
    expect(ai.requests.some((r) => JSON.stringify(r.input).includes("reglas impersonales"))).toBe(
      true,
    );
    const visible = JSON.stringify({ output: out.output, surfaces: ws.value.surfaces });
    expect(visible).not.toContain("SECRET-KEYPOINT");
    expect(visible).not.toContain("SECRET-HINT");
    expect(question()).toMatchObject({ number: 1, state: "asking", hints: [], sources: [] });
    expect(ws.value.context?.name).toBe("Administración");
    expect(ws.value.intent?.kind).toBe("study");
    expect(associations).toEqual(["study"]);
  });

  it("says when the material doesn't cover the request instead of widening it", async () => {
    const none = await setup({ noMaterial: true }).call("study.start", { mode: "review" });
    expect(none.status === "succeeded" && none.output).toMatchObject({
      started: false,
      reason: "no_material",
    });
    const missing = await setup().call("study.start", { mode: "review", scope: { units: ["9"] } });
    expect(missing.status === "succeeded" && missing.output).toMatchObject({
      started: false,
      reason: "scope_not_found",
      notFound: ["Unidad 9"],
    });
  });

  it("gives hints progressively, never all at once", async () => {
    const { call, question } = setup();
    await call("study.start", { mode: "oral_exam" });
    const h1 = await call("study.hint");
    expect(h1.status === "succeeded" && h1.output).toMatchObject({
      level: 1,
      hint: "SECRET-HINT-1",
    });
    expect(question()?.hints).toEqual(["SECRET-HINT-1"]);
    await call("study.hint");
    await call("study.hint");
    const none = await call("study.hint");
    expect(none.status === "succeeded" && (none.output as { hint: unknown }).hint).toBeNull();
    expect(question()?.hints).toHaveLength(3);
  });

  it("evaluates against the evidence, records progress and asks the next question", async () => {
    const { call, question, store } = setup();
    await call("study.start", { mode: "oral_exam" });
    const first = question()!;
    const out = await call("study.answer", { answer: "Quería organizar con reglas." });
    expect(out.status).toBe("succeeded");
    if (out.status !== "succeeded") return;
    const o = out.output as {
      assessment: string;
      feedback: { missing: string[]; basedOn: string[] };
      next: { number: number; concept: string };
    };
    expect(o.assessment).toBe("partial");
    expect(o.feedback.missing).toEqual(["la jerarquía"]);
    expect(o.feedback.basedOn[0]).toContain("Unidad");
    expect(o.next.number).toBe(2);
    expect(o.next.concept).not.toBe(first.conceptLabel);
    expect(store.attemptsList).toHaveLength(1);
    expect(store.attemptsList[0]).toMatchObject({ assessment: "partial", hintsUsed: 0 });
    expect(store.conceptsList.find((c) => c.label === first.conceptLabel)?.status).toBe("learning");
    // The feedback (with its sources) sits next to the new question, whose sources stay hidden.
    const q = question()!;
    expect(q.number).toBe(2);
    expect(q.previous).toMatchObject({
      assessment: "partial",
      answer: "Quería organizar con reglas.",
    });
    expect(q.previous?.sources.length).toBeGreaterThan(0);
    expect(q.sources).toEqual([]);
  });

  it("showing the source counts as help; quiz answers are checked deterministically", async () => {
    const s = setup();
    s.ai.assessment = "strong";
    await s.call("study.start", { mode: "review" });
    await s.call("study.reveal");
    expect(s.question()?.sources.length).toBeGreaterThan(0);
    await s.call("study.answer", { answer: "reglas y jerarquía" });
    expect(s.store.attemptsList[0]).toMatchObject({ hintsUsed: 3 });
    expect(s.store.conceptsList.find((c) => c.attempts === 1)?.lastAssessment).toBe("partial");

    const quiz = setup();
    quiz.ai.quiz = true;
    quiz.ai.assessment = "needs_review"; // the evaluator only explains; the choice decides
    await quiz.call("study.start", { mode: "quiz" });
    expect(quiz.question()?.options).toEqual(["a1", "a2", "a3", "a4"]);
    const out = await quiz.call("study.answer", { answer: "b" });
    expect(out.status === "succeeded" && out.output).toMatchObject({ assessment: "strong" });
  });

  it("with feedback at the end, answers are recorded without being judged aloud", async () => {
    const { call, question } = setup();
    await call("study.start", { mode: "oral_exam", preferences: { feedback: "end" } });
    const out = await call("study.answer", { answer: "algo" });
    expect(out.status === "succeeded" && out.output).toMatchObject({ recorded: true });
    expect(
      out.status === "succeeded" && (out.output as { assessment?: string }).assessment,
    ).toBeUndefined();
    expect(question()?.previous).toMatchObject({ assessment: null, feedback: null, sources: [] });
  });

  it("ends with a summary, keeps progress, and stops asking", async () => {
    const { call, ws, store } = setup();
    await call("study.start", { mode: "oral_exam" });
    await call("study.answer", { answer: "reglas" });
    const end = await call("study.end");
    expect(end.status).toBe("succeeded");
    expect(ws.value.surfaces.some((s) => s.type === "study_question")).toBe(false);
    const summary = ws.value.surfaces.find((s) => s.type === "study_summary")!;
    expect((summary.payload as SurfacePayloads["study_summary"]).questions).toBe(1);
    expect([...store.sessions.values()][0]).toMatchObject({ status: "completed", current: null });
    const again = await call("study.answer", { answer: "x" });
    expect(again).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    const progress = await call("study.progress", { context: "Administración" });
    expect(progress.status === "succeeded" && progress.output).toMatchObject({
      subject: "Administración",
      lastSession: { questions: 1, toReview: ["Burocracia de Weber"] },
    });
  });

  it("can't evaluate without AI, and Surface actions call the study tools", async () => {
    const s = setup({ noAI: true });
    await s.call("study.start", { mode: "review" });
    const out = await s.call("study.answer", { answer: "x" });
    expect(out).toMatchObject({ status: "failed", error: { code: "AI_NOT_CONFIGURED" } });
    const surface = s.ws.value.surfaces.find((x) => x.type === "study_question")!;
    const sessionId = (surface.payload as SurfacePayloads["study_question"]).sessionId;
    expect(toolForAction(surface, "hint", null)).toEqual({
      name: "study.hint",
      args: { session: sessionId },
    });
    expect(toolForAction(surface, "end_session", null)?.name).toBe("study.end");
  });
});
