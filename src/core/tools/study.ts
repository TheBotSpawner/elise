import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { nameKey, type ContextProfile, type ContextStore } from "../contexts/model";
import { AppError } from "../errors";
import { activateContext, findProfile, threadOf } from "./contexts";
import { clip, present } from "./orchestration";
import { withDescendants, type KnowledgeHit, type KnowledgeReader } from "../knowledge/model";
import { evaluateAnswer, extractConcepts, generateQuestion, quizChoice } from "../study/ai";
import {
  DEFAULT_PREFERENCES,
  STUDY_LIMITS,
  STUDY_MODES,
  angleFor,
  applyAssessment,
  namesUnit,
  pickNextConcept,
  progressCounts,
  summarizeSession,
  topicMatches,
  unitNumbers,
  type CurrentQuestion,
  type Evidence,
  type SourceRef,
  type StudyConcept,
  type StudyPort,
  type StudyScope,
  type StudySession,
} from "../study/model";
import { surfacesFromOutcome } from "../workspace/from-results";
import type { SurfacePayloads } from "../workspace/registry";

/**
 * Study Mode (ADR-016 §10-14): a thin orchestration over Knowledge, the Live Workspace and
 * Voice. Questions come from the user's own material; the answer key, hints and evidence stay
 * in the session until the user answers, asks for a hint or asks for the source. Progress is
 * deterministic. No separate study agent: the same ELISE asks, listens and explains.
 */

const study = (env: ToolRunEnv): StudyPort => env.providers.get("study", env.binding);
const contexts = (env: ToolRunEnv): ContextStore => env.providers.get("contexts", env.binding);
const knowledge = (env: ToolRunEnv): KnowledgeReader => env.providers.get("knowledge", env.binding);

const sessionRef = z.uuid().optional().describe("Omit for this conversation's session.");

async function sessionFor(env: ToolRunEnv, id: string | undefined): Promise<StudySession> {
  const store = study(env).store;
  const s = id ? await store.session(id) : await store.activeSession(threadOf(env));
  if (!s || s.status !== "active")
    throw new AppError(
      "NOT_FOUND",
      "No study session is in progress here. Start one with study.start.",
      { recovery: "review" },
    );
  return s;
}

// ── Material and scope ───────────────────────────────────────────────────────

interface Material {
  spaceIds: string[] | null;
  itemIds: string[] | null;
  documents: { itemId: string; title: string }[];
}

/** The subject's linked Knowledge (Spaces with their sub-Spaces, and documents). */
async function material(env: ToolRunEnv, profile: ContextProfile): Promise<Material | null> {
  const links = profile.links.filter((l) => l.confirmed && l.resourceId);
  const spaceLinks = links.filter((l) => l.type === "knowledge_space").map((l) => l.resourceId!);
  const itemLinks = links.filter((l) => l.type === "knowledge_item").map((l) => l.resourceId!);
  if (!spaceLinks.length && !itemLinks.length) return null;
  const reader = knowledge(env);
  const spaces = spaceLinks.length ? withDescendants(await reader.spaces(), spaceLinks) : null;
  const overview = spaces ? (await reader.overview(spaces, 50)).items : [];
  const items = await Promise.all(itemLinks.slice(0, 10).map((id) => reader.getItem(id)));
  return {
    spaceIds: spaces,
    itemIds: itemLinks.length ? itemLinks : null,
    documents: [
      ...overview.map((i) => ({ itemId: i.itemId, title: i.title })),
      ...items.filter((i) => i !== null).map((i) => ({ itemId: i!.id, title: i!.title })),
    ],
  };
}

const scopeInput = z
  .object({
    units: z
      .array(z.string().trim().min(1).max(60))
      .max(8)
      .optional()
      .describe('Units/chapters as said: ["3", "4"] for "unidades 3 y 4".'),
    topics: z
      .array(z.string().trim().min(2).max(80))
      .max(6)
      .optional()
      .describe('Topics: ["Weber"] for "solo Weber".'),
    documents: z
      .array(z.string().trim().min(2).max(200))
      .max(6)
      .optional()
      .describe("Document names the user mentions."),
  })
  .strict();

type ScopeRequest = z.infer<typeof scopeInput>;

const search = (env: ToolRunEnv, text: string, m: Material, itemIds: string[] | null) =>
  knowledge(env).search({
    text,
    spaceIds: itemIds ? null : m.spaceIds,
    itemIds: itemIds ?? (m.spaceIds ? null : m.itemIds),
    limit: 24,
  });

/**
 * Resolves "unidades 3 y 4" / "solo Weber" / "estos dos PDFs" against the material, before
 * the session starts. What can't be found is reported, never silently widened.
 */
async function resolveScope(
  env: ToolRunEnv,
  profile: ContextProfile,
  m: Material,
  req: ScopeRequest,
): Promise<{ scope: StudyScope; missing: string[] }> {
  const units = [
    ...new Set([
      ...unitNumbers((req.units ?? []).join(" , ")),
      ...(req.units ?? []).flatMap((u) => u.match(/\d{1,2}/g) ?? []).map((n) => String(Number(n))),
    ]),
  ];
  const missing: string[] = [];
  const itemIds = new Set<string>();
  for (const n of units) {
    const docs = m.documents.filter((d) => namesUnit(d.title, n));
    if (docs.length) {
      for (const d of docs) itemIds.add(d.itemId);
      continue;
    }
    // A unit inside a document: its section headings name it.
    const { hits } = await search(env, `unidad ${n} unit ${n}`, m, null);
    const inside = hits.filter((h) => namesUnit(h.headingPath.join(" "), n));
    if (inside.length) for (const h of inside) itemIds.add(h.itemId);
    else missing.push(`${env.ctx.locale === "es" ? "Unidad" : "Unit"} ${n}`);
  }
  for (const name of req.documents ?? []) {
    const key = nameKey(name);
    const docs = m.documents.filter((d) => nameKey(d.title).includes(key));
    if (docs.length) for (const d of docs) itemIds.add(d.itemId);
    else missing.push(name);
  }
  const label =
    [
      units.length
        ? `${env.ctx.locale === "es" ? (units.length > 1 ? "Unidades" : "Unidad") : units.length > 1 ? "Units" : "Unit"} ${units.join(", ")}`
        : null,
      ...(req.topics ?? []),
      ...(req.documents ?? []),
    ]
      .filter(Boolean)
      .join(" · ") || profile.name;
  return {
    scope: {
      label: clip(label, 200),
      spaceIds: m.spaceIds ?? [],
      itemIds: [...itemIds],
      topics: req.topics ?? [],
      units: units.filter((u) => !missing.some((x) => x.endsWith(` ${u}`))),
      conceptIds: null,
    },
    missing,
  };
}

const refNames = (r: SourceRef) => `${r.title} ${r.section ?? ""}`;

function inScope(c: StudyConcept, s: StudyScope): boolean {
  if (s.conceptIds) return s.conceptIds.includes(c.id);
  if (s.itemIds.length && !c.refs.some((r) => s.itemIds.includes(r.itemId))) return false;
  if (s.units.length && !c.refs.some((r) => s.units.some((u) => namesUnit(refNames(r), u))))
    return false;
  if (s.topics.length && !s.topics.some((t) => topicMatches(c, t))) return false;
  return true;
}

const toEvidence = (hits: KnowledgeHit[]): Evidence[] =>
  hits.map((h, i) => ({
    ref: i + 1,
    itemId: h.itemId,
    chunkId: h.chunkId,
    title: h.title,
    section: h.headingPath.length ? h.headingPath.join(" › ") : null,
    page: h.page,
    text: clip(h.content, STUDY_LIMITS.evidenceChars),
  }));

/**
 * The scope's concepts: what's already known, else discovered from its passages (labels and
 * references back to the chunks; a dozen at a time, never thousands).
 */
async function conceptsFor(
  env: ToolRunEnv,
  profile: ContextProfile,
  m: Material,
  scope: StudyScope,
): Promise<StudyConcept[]> {
  const { store, ai } = study(env);
  const known = (await store.concepts(profile.id)).filter((c) => inScope(c, scope));
  if (known.length >= 3) return known;
  const query =
    [...scope.topics, ...scope.units.map((u) => `unidad ${u}`)].join(" ") ||
    `${profile.name} conceptos teoría definiciones`;
  const { hits } = await search(env, query, m, scope.itemIds.length ? scope.itemIds : null);
  const relevant = (
    scope.units.length
      ? hits.filter((h) =>
          scope.units.some((u) => namesUnit(`${h.title} ${h.headingPath.join(" ")}`, u)),
        )
      : hits
  ).slice(0, STUDY_LIMITS.passagesForDiscovery);
  if (!relevant.length) return known;
  const evidence = toEvidence(relevant);
  const drafts = ai
    ? await extractConcepts(ai, { subject: profile.name, evidence }).catch(() => [])
    : [];
  const fallback = drafts.length
    ? drafts
    : // Without AI: one concept per section heading of the material.
      [...new Map(evidence.filter((e) => e.section).map((e) => [e.section!, e])).values()]
        .slice(0, 8)
        .map((e) => ({
          label: clip(e.section!.split(" › ").at(-1)!, 120),
          summary: null,
          refs: [e.ref],
        }));
  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const saved = await store.saveConcepts(
    profile.id,
    fallback.map((d) => ({
      label: d.label,
      summary: d.summary,
      refs: (d.refs.length ? d.refs : [evidence[0]!.ref])
        .map((r) => byRef.get(r))
        .filter((e): e is Evidence => !!e)
        .map(({ itemId, chunkId, title, section, page }) => ({
          itemId,
          chunkId,
          title,
          section,
          page,
        })),
    })),
  );
  const discovered = new Set(fallback.map((d) => nameKey(d.label)));
  return saved.filter((c) => inScope(c, scope) || discovered.has(nameKey(c.label)));
}

/** The concept's own passages first, then the closest ones of the scope (bounded). */
async function evidenceFor(env: ToolRunEnv, c: StudyConcept, m: Material, s: StudyScope) {
  const items = [...new Set(c.refs.map((r) => r.itemId))];
  const { hits } = await search(
    env,
    clip(`${c.label} ${c.summary ?? ""}`, 400),
    m,
    items.length ? items : s.itemIds.length ? s.itemIds : null,
  );
  const own = new Set(c.refs.map((r) => r.chunkId));
  const ordered = [
    ...hits.filter((h) => own.has(h.chunkId)),
    ...hits.filter((h) => !own.has(h.chunkId)),
  ];
  return toEvidence(ordered.slice(0, STUDY_LIMITS.evidencePerQuestion));
}

// ── Asking ───────────────────────────────────────────────────────────────────

async function prepareQuestion(
  env: ToolRunEnv,
  profile: ContextProfile,
  session: StudySession,
  m: Material,
  pool: StudyConcept[],
  asked: string[],
  previous: string[],
): Promise<CurrentQuestion | null> {
  const concept = pickNextConcept(pool, asked);
  if (!concept) return null;
  const evidence = await evidenceFor(env, concept, m, session.scope);
  const q = await generateQuestion(study(env).ai, {
    subject: profile.name,
    concept,
    angle: angleFor(concept),
    mode: session.mode,
    difficulty: session.preferences.difficulty,
    evidence,
    previous,
    locale: env.ctx.locale,
  });
  return {
    number: session.questionCount + 1,
    conceptId: concept.id,
    conceptLabel: concept.label,
    question: q.question,
    angle: angleFor(concept),
    keyPoints: q.keyPoints,
    hints: q.hints,
    hintsShown: 0,
    revealed: false,
    evidence,
    ...(q.options ? { options: q.options, correctOption: q.correctOption } : {}),
    askedAt: new Date().toISOString(),
  };
}

const sourcesOf = (evidence: Evidence[], refs?: number[]) =>
  (refs?.length ? evidence.filter((e) => refs.includes(e.ref)) : evidence).slice(0, 3).map((e) => ({
    itemId: e.itemId,
    title: clip(e.title, 300),
    section: e.section ? clip(e.section, 300) : null,
    page: e.page,
    excerpt: clip(e.text, 600),
  }));

type QuestionPayload = SurfacePayloads["study_question"];

/** What the Surface may show: the question, the hints asked for, sources only when allowed. */
function questionPayload(
  profile: ContextProfile,
  session: StudySession,
  current: CurrentQuestion,
  previous: QuestionPayload["previous"] = null,
): QuestionPayload {
  return {
    sessionId: session.id,
    contextName: clip(profile.name, 120),
    mode: session.mode,
    number: current.number,
    question: clip(current.question, 600),
    conceptLabel: clip(current.conceptLabel, 120),
    options: current.options?.map((o) => clip(o, 200)) ?? null,
    hints: current.hints.slice(0, current.hintsShown),
    state: "asking",
    assessment: null,
    feedback: null,
    sources: current.revealed ? sourcesOf(current.evidence) : [],
    previous,
    feedbackMode: session.preferences.feedback,
    scope: clip(session.scope.label, 200),
  };
}

async function progressPayload(
  env: ToolRunEnv,
  profile: ContextProfile,
  sessionQuestions: number,
): Promise<SurfacePayloads["study_progress"]> {
  const concepts = await study(env).store.concepts(profile.id);
  const weak = concepts
    .filter(
      (c) =>
        c.status === "needs_review" || (c.status === "learning" && c.lastAssessment !== "strong"),
    )
    .sort((a, b) => a.score - b.score);
  return {
    contextId: profile.id,
    contextName: clip(profile.name, 120),
    counts: progressCounts(concepts),
    weak: weak.slice(0, 6).map((c) => clip(c.label, 120)),
    strong: concepts
      .filter((c) => c.status === "understood")
      .slice(0, 6)
      .map((c) => clip(c.label, 120)),
    sessionQuestions,
    targetDate: profile.study?.targetDate ?? null,
  };
}

function show(env: ToolRunEnv, tool: string, display: Parameters<typeof surfacesFromOutcome>[1]) {
  const intentId = env.ctx.workspace?.state().intent?.id ?? null;
  present(env, surfacesFromOutcome(tool, display, { key: tool, intentId }));
}

const forModel = (c: CurrentQuestion) => ({
  number: c.number,
  question: c.question,
  concept: c.conceptLabel,
  ...(c.options
    ? { options: c.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o}`) }
    : {}),
});

const ASK =
  "Ask exactly this question (spoken: say it naturally, one or two sentences). Don't answer it, don't hint and don't add facts — you don't have the answer key. When the user answers, call study.answer with their words; 'dame una pista' → study.hint; 'otra' / 'siguiente' → study.next; 'terminemos' → study.end.";

// ── study.start ──────────────────────────────────────────────────────────────

const startInput = z
  .object({
    context: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("The subject; omit for the active one."),
    mode: z
      .enum(STUDY_MODES)
      .default("review")
      .describe(
        '"tomame oral" → oral_exam; "quiz me" / "multiple choice" → quiz; "repasemos" → review.',
      ),
    scope: scopeInput.optional(),
    preferences: z
      .object({
        feedback: z
          .enum(["each", "end"])
          .optional()
          .describe('"no me corrijas hasta el final" → end'),
        strict: z.boolean().optional().describe('"sé estricta" → true'),
        difficulty: z.enum(["easier", "normal", "harder"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const startStudyTool: ToolDefinition = {
  name: "study.start",
  capability: "study",
  operation: "start",
  description:
    '"Tomame oral de Administración sobre las unidades 3 y 4", "quiz me on chapter 2", "repasemos Weber": starts a study session from the user\'s OWN material (the subject\'s linked Knowledge), one question at a time, in the Live Workspace. Resolves the scope first and says if the material doesn\'t cover it.',
  input: startInput,
  async describe() {
    return { summary: "Start study session" };
  },
  async run(raw, env) {
    const q = startInput.parse(raw);
    const store = contexts(env);
    const subjects = (await store.list()).filter(
      (p) => p.status === "active" && p.kind === "study",
    );
    const profile = q.context
      ? await findProfile(store, q.context, { kind: "study" })
      : env.ctx.context?.kind === "study"
        ? await findProfile(store, env.ctx.context.id)
        : subjects.length === 1
          ? subjects[0]!
          : null;
    if (!profile)
      return {
        output: {
          started: false,
          subjects: subjects.map((p) => p.name),
          instructions: subjects.length
            ? "Ask which subject (by name)."
            : "There's no study context yet. Offer to create one for this subject (contexts.propose with kind study), linking the Knowledge Space with its material.",
        },
      };
    const m = await material(env, profile);
    if (!m || !m.documents.length)
      return {
        output: {
          started: false,
          subject: profile.name,
          reason: "no_material",
          instructions:
            "This subject has no linked material yet. Say so; offer to link a Knowledge Space with the material (contexts.update addLinks), or to upload it. Don't quiz from general knowledge unless the user explicitly asks for that.",
        },
      };
    const { scope, missing } = await resolveScope(env, profile, m, q.scope ?? {});
    const asked = Boolean(q.scope?.units?.length || q.scope?.documents?.length);
    if (asked && !scope.itemIds.length && !scope.units.length)
      return {
        output: {
          started: false,
          subject: profile.name,
          reason: "scope_not_found",
          notFound: missing,
          available: m.documents.slice(0, 12).map((d) => d.title),
          instructions:
            "The material doesn't cover what the user asked for. Say which part wasn't found and offer what is available (by document name).",
        },
      };
    const pool = await conceptsFor(env, profile, m, scope);
    if (!pool.length)
      return {
        output: {
          started: false,
          subject: profile.name,
          reason: "no_concepts",
          available: m.documents.slice(0, 12).map((d) => d.title),
          instructions:
            "Not enough readable material for that scope. Say so and offer the available documents.",
        },
      };
    const { store: studyStore } = study(env);
    let session = await studyStore.createSession({
      contextId: profile.id,
      thread: threadOf(env),
      mode: q.mode,
      scope: { ...scope, conceptIds: pool.map((c) => c.id) },
      preferences: { ...DEFAULT_PREFERENCES, ...q.preferences },
    });
    const at = new Date().toISOString();
    env.ctx.workspace?.apply([
      {
        op: "intent",
        intent: {
          id: `intent:study:${session.id}`,
          kind: "study",
          description: clip(`${profile.name} · ${scope.label}`, 160),
          startedAt: at,
        },
        at,
      },
    ]);
    await activateContext(env, profile, "study");
    const current = await prepareQuestion(env, profile, session, m, pool, [], []);
    if (!current)
      throw new AppError("NOT_FOUND", "Nothing to ask in that scope", { recovery: "review" });
    await studyStore.saveSession(session.id, { current, questionCount: current.number });
    session = { ...session, current, questionCount: current.number };
    const question = questionPayload(profile, session, current);
    show(env, "study.start", {
      status: "succeeded",
      display: { kind: "study_question", question },
    });
    show(env, "study.progress", {
      status: "succeeded",
      display: { kind: "study_progress", progress: await progressPayload(env, profile, 0) },
    });
    return {
      output: {
        started: true,
        session: session.id,
        subject: profile.name,
        mode: q.mode,
        scope: scope.label,
        ...(missing.length ? { notFound: missing } : {}),
        concepts: pool.length,
        question: forModel(current),
        instructions: `${missing.length ? "First say briefly which requested part wasn't found in the material. " : ""}${ASK}`,
      },
      display: { kind: "study_question", question },
    };
  },
};

// ── study.answer ─────────────────────────────────────────────────────────────

const answerInput = z
  .object({
    answer: z
      .string()
      .trim()
      .min(1)
      .max(STUDY_LIMITS.answerChars)
      .describe("The user's answer, verbatim."),
    session: sessionRef,
  })
  .strict();

export const answerStudyTool: ToolDefinition = {
  name: "study.answer",
  capability: "study",
  operation: "answer",
  description:
    "The user's answer to the current study question: evaluated against their material, progress updated, and the next question prepared. Pass their words verbatim.",
  input: answerInput,
  async describe() {
    return { summary: "Check answer" };
  },
  async run(raw, env) {
    const q = answerInput.parse(raw);
    const { store, ai } = study(env);
    if (!ai)
      throw new AppError("AI_NOT_CONFIGURED", "Answers can't be evaluated without AI", {
        recovery: "configure",
      });
    const session = await sessionFor(env, q.session);
    const current = session.current;
    if (!current)
      throw new AppError("NOT_FOUND", "No question is waiting for an answer. Use study.next.", {
        recovery: "review",
      });
    const profile = await findProfile(contexts(env), session.contextId);
    const m = await material(env, profile);
    const attempts = await store.attempts(session.id);
    const concepts = await store.concepts(profile.id);
    const pool = concepts.filter((c) => inScope(c, session.scope));
    const asked = [...attempts.map((a) => a.conceptId ?? ""), current.conceptId];

    // Evaluate this answer and prepare the next question at the same time (the next concept
    // never is the current one, so its choice doesn't depend on this assessment).
    const choice = current.options ? quizChoice(q.answer, current.options) : null;
    const [evaluation, next] = await Promise.all([
      evaluateAnswer(ai, {
        question: current.question,
        keyPoints: current.keyPoints,
        ...(current.options
          ? { options: current.options, correctOption: current.correctOption }
          : {}),
        evidence: current.evidence,
        answer:
          choice !== null && current.options
            ? `${String.fromCharCode(97 + choice)}) ${current.options[choice]}`
            : q.answer,
        strict: session.preferences.strict,
        locale: env.ctx.locale,
      }),
      m
        ? prepareQuestion(
            env,
            profile,
            { ...session, questionCount: current.number },
            m,
            pool,
            asked,
            [...attempts.map((a) => a.question), current.question],
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    // A quiz choice is checked deterministically; the evaluator only explains.
    const assessment =
      choice !== null && current.correctOption !== undefined
        ? choice === current.correctOption
          ? "strong"
          : "needs_review"
        : evaluation.assessment;
    const hintsUsed = current.revealed ? 3 : current.hintsShown;
    const at = new Date().toISOString();
    await store.addAttempt(session.id, {
      conceptId: current.conceptId,
      conceptLabel: current.conceptLabel,
      question: current.question,
      answer: q.answer,
      assessment,
      feedback: evaluation,
      hintsUsed,
    });
    const concept = concepts.find((c) => c.id === current.conceptId);
    if (concept)
      await store.updateConcept(concept.id, applyAssessment(concept, assessment, hintsUsed, at));

    const each = session.preferences.feedback === "each";
    const previous: QuestionPayload["previous"] = {
      number: current.number,
      question: clip(current.question, 600),
      answer: clip(q.answer, 400),
      assessment: each ? assessment : null,
      feedback: each
        ? {
            correct: evaluation.correct,
            missing: evaluation.missing,
            incorrect: evaluation.incorrect,
            explanation: evaluation.explanation,
          }
        : null,
      sources: each ? sourcesOf(current.evidence, evaluation.refs) : [],
    };
    const updated: StudySession = {
      ...session,
      current: next,
      questionCount: next?.number ?? current.number,
    };
    await store.saveSession(session.id, { current: next, questionCount: updated.questionCount });
    const question: QuestionPayload = next
      ? questionPayload(profile, updated, next, previous)
      : {
          ...questionPayload(profile, updated, current, previous),
          state: "answered",
        };
    show(env, "study.answer", {
      status: "succeeded",
      display: { kind: "study_question", question },
    });
    show(env, "study.progress", {
      status: "succeeded",
      display: {
        kind: "study_progress",
        progress: await progressPayload(env, profile, attempts.length + 1),
      },
    });
    const cited = current.evidence.filter((e) => evaluation.refs.includes(e.ref));
    return {
      output: {
        ...(each
          ? {
              assessment,
              feedback: {
                correct: evaluation.correct,
                missing: evaluation.missing,
                incorrect: evaluation.incorrect,
                explanation: evaluation.explanation,
                basedOn: (cited.length ? cited : current.evidence.slice(0, 1)).map((e) =>
                  e.section ? `${e.title} · ${e.section}` : e.title,
                ),
              },
            }
          : { recorded: true }),
        ...(next ? { next: forModel(next) } : { next: null }),
        instructions: each
          ? `Give short, kind feedback in plain words (no scores) — at most two sentences, the details are on screen: what was right, what was missing, and the correction — naming the material it comes from ("según ${cited[0]?.title ?? "tu material"}"). Use only the feedback above. ${next ? `Then ask the next question exactly. ${ASK}` : "There are no more questions in this scope: offer to end the session (study.end) or widen it."}`
          : `Don't say whether it was right (the user asked for feedback at the end). Acknowledge briefly. ${next ? `Then ask the next question exactly. ${ASK}` : "Offer to end the session (study.end)."}`,
      },
      display: { kind: "study_question", question },
    };
  },
};

// ── hints, reveal, next, configure ───────────────────────────────────────────

const sessionInput = z.object({ session: sessionRef }).strict();

export const hintStudyTool: ToolDefinition = {
  name: "study.hint",
  capability: "study",
  operation: "hint",
  description:
    '"Dame una pista", "a hint please": the next progressive hint for the current question (category → relationship → partial structure). Never the full answer.',
  input: sessionInput,
  async describe() {
    return { summary: "Hint" };
  },
  async run(raw, env) {
    const session = await sessionFor(env, sessionInput.parse(raw).session);
    const current = session.current;
    if (!current) throw new AppError("NOT_FOUND", "No question is pending", { recovery: "review" });
    const profile = await findProfile(contexts(env), session.contextId);
    if (current.hintsShown >= current.hints.length)
      return {
        output: {
          hint: null,
          instructions:
            "All hints were given. Offer to show the source (study.reveal) or to move on (study.next).",
        },
      };
    const updated = { ...current, hintsShown: current.hintsShown + 1 };
    await study(env).store.saveSession(session.id, { current: updated });
    const question = questionPayload(profile, session, updated);
    show(env, "study.hint", { status: "succeeded", display: { kind: "study_question", question } });
    return {
      output: {
        level: updated.hintsShown,
        of: updated.hints.length,
        hint: updated.hints[updated.hintsShown - 1],
        instructions: "Say only this hint (it's on screen too), then wait for the answer.",
      },
      display: { kind: "study_question", question },
    };
  },
};

export const revealStudyTool: ToolDefinition = {
  name: "study.reveal",
  capability: "study",
  operation: "reveal",
  description:
    '"Mostrame la fuente", "where is this in my notes?": shows the material for the current question. The answer then counts as helped.',
  input: sessionInput,
  async describe() {
    return { summary: "Show source" };
  },
  async run(raw, env) {
    const session = await sessionFor(env, sessionInput.parse(raw).session);
    const current = session.current;
    if (!current) throw new AppError("NOT_FOUND", "No question is pending", { recovery: "review" });
    const profile = await findProfile(contexts(env), session.contextId);
    const updated = { ...current, revealed: true };
    await study(env).store.saveSession(session.id, { current: updated });
    const question = questionPayload(profile, session, updated);
    show(env, "study.reveal", {
      status: "succeeded",
      display: { kind: "study_question", question },
    });
    return {
      output: {
        sources: current.evidence.map((e) => ({
          document: e.section ? `${e.title} · ${e.section}` : e.title,
          untrustedExcerpt: e.text,
        })),
        instructions:
          "The source is on screen. Point to it in one sentence and let the user answer, or offer the next question.",
      },
      display: { kind: "study_question", question },
    };
  },
};

const nextInput = z
  .object({
    session: sessionRef,
    topic: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .optional()
      .describe('"Ahora preguntame Weber" → "Weber" (narrows the session to it).'),
    difficulty: z
      .enum(["easier", "normal", "harder"])
      .optional()
      .describe('"Más difícil" → harder'),
  })
  .strict();

export const nextStudyTool: ToolDefinition = {
  name: "study.next",
  capability: "study",
  operation: "next",
  description:
    '"Otra", "siguiente", "más difícil", "ahora preguntame Weber": skips to the next question, optionally narrowing to a topic or changing difficulty.',
  input: nextInput,
  async describe() {
    return { summary: "Next question" };
  },
  async run(raw, env) {
    const q = nextInput.parse(raw);
    const { store } = study(env);
    let session = await sessionFor(env, q.session);
    const profile = await findProfile(contexts(env), session.contextId);
    const m = await material(env, profile);
    if (!m)
      throw new AppError("NOT_FOUND", "The subject has no linked material", { recovery: "review" });
    if (q.topic) {
      const scope: StudyScope = { ...session.scope, topics: [q.topic], conceptIds: null };
      const pool = await conceptsFor(env, profile, m, scope);
      if (!pool.length)
        return {
          output: {
            found: false,
            topic: q.topic,
            instructions: `The material doesn't cover "${q.topic}". Say so and continue with the current scope if the user wants.`,
          },
        };
      session = {
        ...session,
        scope: { ...scope, label: clip(q.topic, 200), conceptIds: pool.map((c) => c.id) },
      };
    }
    if (q.difficulty)
      session = { ...session, preferences: { ...session.preferences, difficulty: q.difficulty } };
    const attempts = await store.attempts(session.id);
    const pool = (await store.concepts(profile.id)).filter((c) => inScope(c, session.scope));
    const asked = [
      ...attempts.map((a) => a.conceptId ?? ""),
      ...(session.current ? [session.current.conceptId] : []),
    ];
    const next = await prepareQuestion(env, profile, session, m, pool, asked, [
      ...attempts.map((a) => a.question),
      ...(session.current ? [session.current.question] : []),
    ]);
    if (!next)
      return {
        output: { next: null, instructions: "Nothing left to ask in this scope: offer study.end." },
      };
    await store.saveSession(session.id, {
      current: next,
      questionCount: next.number,
      scope: session.scope,
      preferences: session.preferences,
    });
    const question = questionPayload(profile, { ...session, questionCount: next.number }, next);
    show(env, "study.next", { status: "succeeded", display: { kind: "study_question", question } });
    return {
      output: { next: forModel(next), scope: session.scope.label, instructions: ASK },
      display: { kind: "study_question", question },
    };
  },
};

const configureInput = z
  .object({
    session: sessionRef,
    feedback: z.enum(["each", "end"]).optional(),
    strict: z.boolean().optional(),
    difficulty: z.enum(["easier", "normal", "harder"]).optional(),
  })
  .strict();

export const configureStudyTool: ToolDefinition = {
  name: "study.configure",
  capability: "study",
  operation: "configure",
  description:
    '"No me corrijas hasta el final", "sé estricta", "más fácil": changes how THIS session behaves. Never a permanent preference.',
  input: configureInput,
  async describe() {
    return { summary: "Study preferences" };
  },
  async run(raw, env) {
    const q = configureInput.parse(raw);
    const session = await sessionFor(env, q.session);
    const preferences = {
      ...session.preferences,
      ...(q.feedback ? { feedback: q.feedback } : {}),
      ...(q.strict !== undefined ? { strict: q.strict } : {}),
      ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    };
    await study(env).store.saveSession(session.id, { preferences });
    if (session.current) {
      const profile = await findProfile(contexts(env), session.contextId);
      show(env, "study.configure", {
        status: "succeeded",
        display: {
          kind: "study_question",
          question: questionPayload(profile, { ...session, preferences }, session.current),
        },
      });
    }
    return { output: { preferences, note: "For this session only." } };
  },
};

// ── study.end / study.progress ───────────────────────────────────────────────

export const endStudyTool: ToolDefinition = {
  name: "study.end",
  capability: "study",
  operation: "end",
  description:
    '"Terminemos por hoy", "seguimos después": ends the session with a summary (covered, strong, to review, mistakes, next review). Progress is kept for next time.',
  input: sessionInput,
  async describe() {
    return { summary: "End study session" };
  },
  async run(raw, env) {
    const session = await sessionFor(env, sessionInput.parse(raw).session);
    const { store } = study(env);
    const profile = await findProfile(contexts(env), session.contextId);
    const attempts = await store.attempts(session.id);
    const at = new Date().toISOString();
    const summary = summarizeSession(attempts, at);
    await store.saveSession(session.id, {
      status: "completed",
      summary,
      endedAt: at,
      current: null,
    });
    const payload: SurfacePayloads["study_summary"] = {
      contextName: clip(profile.name, 120),
      questions: summary.questions,
      covered: summary.covered.slice(0, 20).map((s) => clip(s, 120)),
      strong: summary.strong.slice(0, 20).map((s) => clip(s, 120)),
      review: summary.review.slice(0, 20).map((s) => clip(s, 120)),
      mistakes: summary.mistakes.map((s) => clip(s, 240)),
      nextReview: summary.nextReview.map((s) => clip(s, 120)),
      at,
    };
    // The question card has nothing more to ask.
    const w = env.ctx.workspace;
    w?.apply(
      w
        .state()
        .surfaces.filter((s) => s.type === "study_question" && s.ref?.id === session.id)
        .map((s) => ({ op: "dismiss" as const, id: s.id, at })),
    );
    show(env, "study.end", {
      status: "succeeded",
      display: { kind: "study_summary", summary: payload },
    });
    show(env, "study.progress", {
      status: "succeeded",
      display: {
        kind: "study_progress",
        progress: await progressPayload(env, profile, summary.questions),
      },
    });
    return {
      output: {
        ended: true,
        subject: profile.name,
        summary,
        instructions:
          "Using the summary above, tell the user what went well, which concepts to review and when to review them next — two or three natural sentences, without restating these instructions. Mention that the full summary is on screen and their progress is saved.",
      },
      display: { kind: "study_summary", summary: payload },
    };
  },
};

const progressInput = z.object({ context: z.string().trim().min(1).max(120).optional() }).strict();

export const progressStudyTool: ToolDefinition = {
  name: "study.progress",
  capability: "study",
  operation: "progress",
  description:
    '"¿Qué me costó la última vez en Administración?", "what am I weak at?", "¿cómo vengo con Legislación?": the subject\'s structured progress (concept status, weak areas, last session, recent mistakes). Prefer it over Recall for progress.',
  input: progressInput,
  async describe() {
    return { summary: "Study progress" };
  },
  async run(raw, env) {
    const q = progressInput.parse(raw);
    const store = contexts(env);
    const profile = q.context
      ? await findProfile(store, q.context, { kind: "study" })
      : env.ctx.context?.kind === "study"
        ? await findProfile(store, env.ctx.context.id)
        : await (async () => {
            const subjects = (await store.list()).filter(
              (p) => p.status === "active" && p.kind === "study",
            );
            if (subjects.length === 1) return subjects[0]!;
            throw new AppError(
              "VALIDATION_ERROR",
              subjects.length
                ? `Which subject? ${subjects.map((p) => p.name).join(", ")}`
                : "There are no study contexts yet",
              { recovery: "review" },
            );
          })();
    const { store: s } = study(env);
    const [progress, last, recent] = await Promise.all([
      progressPayload(env, profile, 0),
      s.lastSession(profile.id),
      s.recentAttempts(profile.id, 12),
    ]);
    show(env, "study.progress", {
      status: "succeeded",
      display: { kind: "study_progress", progress },
    });
    const struggled = [
      ...new Set(recent.filter((a) => a.assessment !== "strong").map((a) => a.conceptLabel)),
    ].slice(0, 6);
    return {
      output: {
        subject: profile.name,
        concepts: progress.counts,
        weak: progress.weak,
        understood: progress.strong,
        ...(profile.study?.targetDate ? { targetDate: profile.study.targetDate } : {}),
        lastSession: last
          ? {
              date: last.startedAt.slice(0, 10),
              mode: last.mode,
              scope: last.scope.label,
              questions: last.summary?.questions ?? last.questionCount,
              toReview: last.summary?.review ?? [],
              mistakes: last.summary?.mistakes ?? [],
            }
          : null,
        recentlyStruggledWith: struggled,
        instructions:
          "Answer from this structured progress — it's the reliable record. Say it plainly (no percentages). If the user asks what was said, history.search can add the conversation.",
      },
      display: { kind: "study_progress", progress },
    };
  },
};

export const STUDY_TOOLS = [
  startStudyTool,
  answerStudyTool,
  hintStudyTool,
  revealStudyTool,
  nextStudyTool,
  configureStudyTool,
  endStudyTool,
  progressStudyTool,
];
