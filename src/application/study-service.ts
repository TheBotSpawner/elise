import "server-only";

import { nameKey } from "@/core/contexts/model";
import { AppError } from "@/core/errors";
import {
  DEFAULT_PREFERENCES,
  type Attempt,
  type CurrentQuestion,
  type Feedback,
  type SessionSummary,
  type SourceRef,
  type StudyConcept,
  type StudyPreferences,
  type StudyScope,
  type StudySession,
  type StudyStore,
} from "@/core/study/model";
import { logger } from "@/infrastructure/observability/logger";
import type {
  Json,
  StudyAttemptRow,
  StudyConceptRow,
  StudySessionRow,
} from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Study store (ADR-016 §14): sessions, concepts and attempts are the author's own learning
 * records (RLS: private to the user). The session row holds the pending question — key points,
 * hints and evidence — which only the server reads; Surfaces get what may be shown.
 */

const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Json;
/** A session nobody touched for this long is no longer "in progress". */
const ACTIVE_MS = 12 * 3_600_000;

const toConcept = (r: StudyConceptRow): StudyConcept => ({
  id: r.id,
  label: r.label,
  summary: r.summary,
  refs: Array.isArray(r.source_refs) ? (r.source_refs as unknown as SourceRef[]) : [],
  status: r.status,
  score: r.score,
  attempts: r.attempts,
  lastAssessment: r.last_assessment,
  lastReviewedAt: r.last_reviewed_at,
});

const EMPTY_SCOPE: StudyScope = {
  label: "",
  spaceIds: [],
  itemIds: [],
  topics: [],
  units: [],
  conceptIds: null,
};

const toSession = (r: StudySessionRow): StudySession => ({
  id: r.id,
  contextId: r.context_profile_id,
  mode: r.mode,
  status: r.status,
  scope: { ...EMPTY_SCOPE, ...(r.scope as object) } as StudyScope,
  preferences: { ...DEFAULT_PREFERENCES, ...(r.preferences as object) } as StudyPreferences,
  current: (r.current as unknown as CurrentQuestion | null) ?? null,
  questionCount: r.question_count,
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
  endedAt: r.ended_at,
  summary: (r.summary as unknown as SessionSummary | null) ?? null,
});

const toAttempt = (r: StudyAttemptRow): Attempt => ({
  id: r.id,
  conceptId: r.concept_id,
  conceptLabel: r.concept_label,
  question: r.question,
  answer: r.answer,
  assessment: r.assessment,
  feedback: {
    correct: [],
    missing: [],
    incorrect: [],
    explanation: "",
    refs: [],
    ...(r.feedback as object),
  } as Feedback,
  hintsUsed: r.hints_used,
  createdAt: r.created_at,
});

export function studyStore(auth: AuthContext): StudyStore {
  const db = auth.db;
  const scoped = <T extends { eq: (c: string, v: string) => T }>(q: T) =>
    q.eq("workspace_id", auth.workspaceId).eq("user_id", auth.userId);

  return {
    async concepts(contextId) {
      const { data } = await scoped(db.from("study_concepts").select("*"))
        .eq("context_profile_id", contextId)
        .order("created_at")
        .limit(200);
      return (data ?? []).map(toConcept);
    },
    async saveConcepts(contextId, drafts) {
      if (drafts.length) {
        // Known concepts keep their progress: only new labels are added.
        const { error } = await db.from("study_concepts").upsert(
          drafts.map((d) => ({
            workspace_id: auth.workspaceId,
            user_id: auth.userId,
            context_profile_id: contextId,
            label: d.label.slice(0, 120),
            label_key: nameKey(d.label).slice(0, 120),
            summary: d.summary?.slice(0, 600) ?? null,
            source_refs: json(d.refs.slice(0, 6)),
          })),
          { onConflict: "context_profile_id,user_id,label_key", ignoreDuplicates: true },
        );
        if (error)
          throw new AppError("INTERNAL_ERROR", "Could not save the concepts", { cause: error });
        logger.info("study.concepts_discovered", { count: drafts.length });
      }
      return this.concepts(contextId);
    },
    async updateConcept(id, patch) {
      await scoped(
        db.from("study_concepts").update({
          status: patch.status,
          score: patch.score,
          attempts: patch.attempts,
          last_assessment: patch.lastAssessment,
          last_reviewed_at: patch.lastReviewedAt,
        }),
      ).eq("id", id);
    },
    async activeSession(thread) {
      if (!thread) return null;
      const { data } = await scoped(db.from("study_sessions").select("*"))
        .eq(thread.kind === "conversation" ? "conversation_id" : "session_id", thread.id)
        .eq("status", "active")
        .gt("last_activity_at", new Date(Date.now() - ACTIVE_MS).toISOString())
        .order("last_activity_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? toSession(data) : null;
    },
    async session(id) {
      const { data } = await scoped(db.from("study_sessions").select("*"))
        .eq("id", id)
        .maybeSingle();
      return data ? toSession(data) : null;
    },
    async lastSession(contextId) {
      const { data } = await scoped(db.from("study_sessions").select("*"))
        .eq("context_profile_id", contextId)
        .gt("question_count", 0)
        .order("last_activity_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? toSession(data) : null;
    },
    async createSession(input) {
      const { data, error } = await db
        .from("study_sessions")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          context_profile_id: input.contextId,
          conversation_id: input.thread?.kind === "conversation" ? input.thread.id : null,
          session_id: input.thread?.kind === "session" ? input.thread.id : null,
          mode: input.mode,
          scope: json(input.scope),
          preferences: json(input.preferences),
        })
        .select("*")
        .single();
      if (error || !data)
        throw new AppError("INTERNAL_ERROR", "Could not start the study session", { cause: error });
      logger.info("study.session_started", { mode: input.mode });
      return toSession(data);
    },
    async saveSession(id, patch) {
      const { error } = await scoped(
        db.from("study_sessions").update({
          ...(patch.current !== undefined ? { current: json(patch.current) } : {}),
          ...(patch.questionCount !== undefined ? { question_count: patch.questionCount } : {}),
          ...(patch.preferences ? { preferences: json(patch.preferences) } : {}),
          ...(patch.scope ? { scope: json(patch.scope) } : {}),
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.summary !== undefined ? { summary: json(patch.summary) } : {}),
          ...(patch.endedAt !== undefined ? { ended_at: patch.endedAt } : {}),
          last_activity_at: new Date().toISOString(),
        }),
      ).eq("id", id);
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not save the study session", { cause: error });
      if (patch.status === "completed") logger.info("study.session_completed", {});
    },
    async addAttempt(sessionId, a) {
      const { error } = await db.from("study_attempts").insert({
        workspace_id: auth.workspaceId,
        user_id: auth.userId,
        study_session_id: sessionId,
        concept_id: a.conceptId,
        concept_label: a.conceptLabel.slice(0, 120),
        question: a.question.slice(0, 1000),
        answer: a.answer.slice(0, 4000),
        assessment: a.assessment,
        feedback: json(a.feedback),
        hints_used: Math.min(3, a.hintsUsed),
      });
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not save the answer", { cause: error });
      // Counts only: answers are the user's own words and stay out of logs.
      logger.info("study.question_answered", { assessment: a.assessment, hints: a.hintsUsed });
    },
    async attempts(sessionId) {
      const { data } = await scoped(db.from("study_attempts").select("*"))
        .eq("study_session_id", sessionId)
        .order("created_at")
        .limit(200);
      return (data ?? []).map(toAttempt);
    },
    async recentAttempts(contextId, limit) {
      const { data: sessions } = await scoped(db.from("study_sessions").select("id"))
        .eq("context_profile_id", contextId)
        .order("last_activity_at", { ascending: false })
        .limit(10);
      const ids = (sessions ?? []).map((s) => s.id);
      if (!ids.length) return [];
      const { data } = await scoped(db.from("study_attempts").select("*"))
        .in("study_session_id", ids)
        .order("created_at", { ascending: false })
        .limit(limit);
      return (data ?? []).map((r) => ({ ...toAttempt(r), sessionId: r.study_session_id }));
    },
  };
}

/** Study progress for the Morning Brief: subjects with an exam soon or concepts to review. */
export async function studyFocus(auth: AuthContext, contextIds: string[]) {
  if (!contextIds.length) return new Map<string, { needsReview: string[] }>();
  const { data } = await auth.db
    .from("study_concepts")
    .select("context_profile_id, label, status, score")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .in("context_profile_id", contextIds)
    .eq("status", "needs_review")
    .order("score")
    .limit(60);
  const out = new Map<string, { needsReview: string[] }>();
  for (const r of data ?? []) {
    const entry = out.get(r.context_profile_id) ?? { needsReview: [] };
    if (entry.needsReview.length < 3) entry.needsReview.push(r.label);
    out.set(r.context_profile_id, entry);
  }
  return out;
}
