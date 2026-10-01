import type { AIProvider } from "../agents/ai-provider";
import { nameKey } from "../contexts/model";

/**
 * Study Mode (ADR-016): sessions over the user's own material. Questions are grounded in
 * Knowledge passages; the answer key and hints stay server-side until the user answers;
 * progress is a small deterministic model (no percentages, no claimed precision).
 */

export const STUDY_MODES = ["review", "oral_exam", "quiz"] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

export const ASSESSMENTS = ["strong", "partial", "needs_review"] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

export const CONCEPT_STATUSES = ["not_reviewed", "learning", "understood", "needs_review"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export interface SourceRef {
  itemId: string;
  chunkId: string;
  title: string;
  section: string | null;
  page: number | null;
}

/** A passage of the material, quoted to the evaluator (bounded). */
export interface Evidence extends SourceRef {
  ref: number;
  text: string;
}

export interface StudyConcept {
  id: string;
  label: string;
  summary: string | null;
  refs: SourceRef[];
  status: ConceptStatus;
  score: number;
  attempts: number;
  lastAssessment: Assessment | null;
  lastReviewedAt: string | null;
}

export interface StudyScope {
  /** What the user asked for, as they'd say it ("Unidades 3 y 4", "Weber"). */
  label: string;
  spaceIds: string[];
  itemIds: string[];
  topics: string[];
  /** Unit numbers ("3", "4"): concepts whose source title or section names them. */
  units: string[];
  /** Concepts this session draws from (null: all of the context). */
  conceptIds: string[] | null;
}

export interface StudyPreferences {
  /** "each": feedback after every answer; "end": only in the summary. */
  feedback: "each" | "end";
  strict: boolean;
  difficulty: "easier" | "normal" | "harder";
}

export const DEFAULT_PREFERENCES: StudyPreferences = {
  feedback: "each",
  strict: false,
  difficulty: "normal",
};

/** The question being asked. Key points, hints and evidence never leave the server unasked. */
export interface CurrentQuestion {
  number: number;
  conceptId: string;
  conceptLabel: string;
  question: string;
  angle: Angle;
  keyPoints: string[];
  hints: string[];
  hintsShown: number;
  revealed: boolean;
  evidence: Evidence[];
  /** Quiz only: the options, and which is correct. */
  options?: string[];
  correctOption?: number;
  askedAt: string;
}

export interface Feedback {
  correct: string[];
  missing: string[];
  incorrect: string[];
  explanation: string;
  /** Evidence refs the correction rests on. */
  refs: number[];
}

export interface Attempt {
  id: string;
  conceptId: string | null;
  conceptLabel: string;
  question: string;
  answer: string;
  assessment: Assessment;
  feedback: Feedback;
  hintsUsed: number;
  createdAt: string;
}

export interface SessionSummary {
  questions: number;
  covered: string[];
  strong: string[];
  review: string[];
  mistakes: string[];
  nextReview: string[];
  at: string;
}

export interface StudySession {
  id: string;
  contextId: string;
  mode: StudyMode;
  status: "active" | "completed" | "abandoned";
  scope: StudyScope;
  preferences: StudyPreferences;
  current: CurrentQuestion | null;
  questionCount: number;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  summary: SessionSummary | null;
}

export type StudyThread = { kind: "conversation" | "session"; id: string };

/** Persistence port, implemented by the application (the author's own rows, RLS). */
export interface StudyStore {
  concepts(contextId: string): Promise<StudyConcept[]>;
  /** Upserts by label; returns every concept of the context. */
  saveConcepts(
    contextId: string,
    drafts: { label: string; summary: string | null; refs: SourceRef[] }[],
  ): Promise<StudyConcept[]>;
  updateConcept(
    id: string,
    patch: Pick<
      StudyConcept,
      "status" | "score" | "attempts" | "lastAssessment" | "lastReviewedAt"
    >,
  ): Promise<void>;
  activeSession(thread: StudyThread | null): Promise<StudySession | null>;
  session(id: string): Promise<StudySession | null>;
  lastSession(contextId: string): Promise<StudySession | null>;
  createSession(input: {
    contextId: string;
    thread: StudyThread | null;
    mode: StudyMode;
    scope: StudyScope;
    preferences: StudyPreferences;
  }): Promise<StudySession>;
  saveSession(
    id: string,
    patch: Partial<
      Pick<
        StudySession,
        "current" | "questionCount" | "preferences" | "status" | "summary" | "endedAt" | "scope"
      >
    >,
  ): Promise<void>;
  addAttempt(sessionId: string, attempt: Omit<Attempt, "id" | "createdAt">): Promise<void>;
  attempts(sessionId: string): Promise<Attempt[]>;
  recentAttempts(contextId: string, limit: number): Promise<(Attempt & { sessionId: string })[]>;
}

/** What study tools get from the provider factory: the store, and AI for the material. */
export interface StudyPort {
  store: StudyStore;
  ai: AIProvider | null;
}

export const STUDY_LIMITS = {
  conceptsPerDiscovery: 12,
  conceptsPerContext: 80,
  evidencePerQuestion: 3,
  evidenceChars: 600,
  passagesForDiscovery: 16,
  hints: 3,
  answerChars: 4000,
} as const;

// ── Mastery (deterministic) ──────────────────────────────────────────────────

/** Ways to ask about the same concept, so a weak one comes back from another angle. */
export const ANGLES = ["explain", "why", "example", "compare", "apply"] as const;
export type Angle = (typeof ANGLES)[number];

export const angleFor = (c: Pick<StudyConcept, "attempts">): Angle =>
  ANGLES[c.attempts % ANGLES.length]!;

/**
 * One answer → the concept's new score and status. Two or more hints turn a strong answer
 * into a partial one. Scores stay small (-3…5): a signal for what to ask next, not a grade.
 */
export function applyAssessment(
  c: Pick<StudyConcept, "score" | "attempts">,
  assessment: Assessment,
  hintsUsed: number,
  at: string,
): Pick<StudyConcept, "status" | "score" | "attempts" | "lastAssessment" | "lastReviewedAt"> {
  const effective: Assessment = assessment === "strong" && hintsUsed >= 2 ? "partial" : assessment;
  const delta = effective === "strong" ? 2 : effective === "partial" ? (c.score < 1 ? 1 : 0) : -2;
  const score = Math.max(-3, Math.min(5, c.score + delta));
  const status: ConceptStatus =
    effective === "needs_review" || score <= -1
      ? "needs_review"
      : score >= 3 && effective === "strong"
        ? "understood"
        : "learning";
  return { status, score, attempts: c.attempts + 1, lastAssessment: effective, lastReviewedAt: at };
}

/**
 * The next concept: weak ones first — but not right after they were asked ("later, from
 * another angle") — then unseen, then learning, then understood (least recently reviewed).
 * Never the same concept twice in a row when there is another.
 */
export function pickNextConcept(
  concepts: StudyConcept[],
  askedInSession: string[],
  only: string[] | null = null,
): StudyConcept | null {
  const pool = only ? concepts.filter((c) => only.includes(c.id)) : concepts;
  if (!pool.length) return null;
  const last = askedInSession.at(-1);
  const recent = new Set(askedInSession.slice(-2));
  const candidates = pool.length > 1 ? pool.filter((c) => c.id !== last) : pool;
  const rank = (c: StudyConcept) =>
    c.status === "needs_review"
      ? recent.has(c.id)
        ? 3
        : 0
      : c.status === "not_reviewed"
        ? 1
        : c.status === "learning"
          ? 2
          : 4;
  return (
    [...candidates].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        askedInSession.filter((x) => x === a.id).length -
          askedInSession.filter((x) => x === b.id).length ||
        (a.lastReviewedAt ?? "").localeCompare(b.lastReviewedAt ?? "") ||
        a.label.localeCompare(b.label),
    )[0] ?? null
  );
}

// ── Scope: "unidades 3 y 4", "solo Weber", "estos dos PDFs" ──────────────────

const UNIT_WORDS =
  "unidad|unidades|unit|units|cap[ií]tulo|chapter|tema|m[oó]dulo|module|clase|parte|part|bolilla|eje";

/** "Unidades 3 y 4" → ["3", "4"]; "unit 2" → ["2"]; "Weber" → []. */
export function unitNumbers(text: string): string[] {
  const t = nameKey(text);
  const out = new Set<string>();
  const re = new RegExp(
    `\\b(?:${UNIT_WORDS})\\s+((?:\\d{1,2}(?:\\s*(?:,|y|e|and|&|-|al|a)\\s*)?)+)`,
    "g",
  );
  for (const m of t.matchAll(re))
    for (const n of m[1]!.match(/\d{1,2}/g) ?? []) out.add(String(Number(n)));
  return [...out];
}

/** Does a title or heading name this unit ("Unidad 3 — Burocracia", "U3", "03. Weber")? */
export function namesUnit(text: string, unit: string): boolean {
  const t = nameKey(text);
  const n = `0?${Number(unit)}`;
  return (
    new RegExp(`\\b(?:${UNIT_WORDS})\\s*${n}\\b`).test(t) ||
    new RegExp(`\\bu${n}\\b`).test(t) ||
    new RegExp(`^${n}[.)\\s-]`).test(t)
  );
}

/** Topic words of a request ("solo Weber", "about Taylor and Fayol"), for concept matching. */
export function topicMatches(
  concept: Pick<StudyConcept, "label" | "summary">,
  topic: string,
): boolean {
  const key = nameKey(topic);
  if (key.length < 3) return false;
  const text = nameKey(`${concept.label} ${concept.summary ?? ""}`);
  return key
    .split(" ")
    .filter((w) => w.length >= 3)
    .every((w) => text.includes(w));
}

// ── Summary (deterministic, from the session's attempts) ─────────────────────

export function summarizeSession(attempts: Attempt[], at: string): SessionSummary {
  const byConcept = new Map<string, Attempt[]>();
  for (const a of attempts)
    byConcept.set(a.conceptLabel, [...(byConcept.get(a.conceptLabel) ?? []), a]);
  const strong: string[] = [];
  const review: string[] = [];
  for (const [label, list] of byConcept) {
    const last = list.at(-1)!;
    if (last.assessment === "strong" && last.hintsUsed < 2) strong.push(label);
    else review.push(label);
  }
  // Weakest first: concepts that ended "needs review" before the partial ones.
  const lastOf = (label: string) => byConcept.get(label)!.at(-1)!.assessment;
  review.sort(
    (a, b) => Number(lastOf(b) === "needs_review") - Number(lastOf(a) === "needs_review"),
  );
  const mistakes = [
    ...new Set(attempts.flatMap((a) => a.feedback.incorrect).filter(Boolean)),
  ].slice(0, 5);
  return {
    questions: attempts.length,
    covered: [...byConcept.keys()],
    strong,
    review,
    mistakes,
    nextReview: review.slice(0, 5),
    at,
  };
}

/** Counts per status, for the progress Surface (no percentages). */
export function progressCounts(concepts: StudyConcept[]): Record<ConceptStatus, number> {
  const out: Record<ConceptStatus, number> = {
    not_reviewed: 0,
    learning: 0,
    understood: 0,
    needs_review: 0,
  };
  for (const c of concepts) out[c.status]++;
  return out;
}
