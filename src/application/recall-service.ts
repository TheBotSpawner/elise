import "server-only";

import { toAppError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import { indexSession, summarizeWithAI, type IndexPorts } from "@/core/recall/indexer";
import {
  groupRecall,
  RECALL,
  recallDue,
  type RecallResult,
  type RecallTurn,
} from "@/core/recall/model";
import { getAIProvider, getEmbeddingProvider } from "@/infrastructure/ai";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseRecallReader } from "@/infrastructure/supabase/repositories/recall";

import type { AuthContext } from "./auth-context";

/**
 * Universal Recall indexing (ADR-012). Runs with the service role, every statement scoped to
 * the session's workspace and user. Existing conversations and messages stay where they are;
 * the index only adds excerpts that point back to them. Chat never waits for it.
 */

type Admin = ReturnType<typeof createAdminClient>;
const toVector = (v: number[]) => `[${v.join(",")}]`;

function ports(
  db: Admin,
  workspaceId: string,
  userId: string,
  opts: { summarize?: boolean } = {},
): IndexPorts {
  let embeddingModel: string | null = null;
  const embed = (() => {
    try {
      const provider = getEmbeddingProvider();
      embeddingModel = provider.model;
      return (texts: string[]) => provider.embed(texts);
    } catch {
      return null;
    }
  })();
  const summarize = (() => {
    if (opts.summarize === false) return null;
    try {
      const ai = getAIProvider();
      return (turns: RecallTurn[]) => summarizeWithAI(ai, turns);
    } catch {
      return null;
    }
  })();
  return {
    async turns(sessionId) {
      const { data: s } = await db
        .from("interaction_sessions")
        .select("conversation_id")
        .eq("id", sessionId)
        .eq("workspace_id", workspaceId)
        .single();
      const rows = s?.conversation_id
        ? (
            await db
              .from("messages")
              .select("id, role, content, at:created_at")
              .eq("conversation_id", s.conversation_id)
              .eq("workspace_id", workspaceId)
              .in("role", ["user", "assistant"])
              .order("created_at")
              .limit(3000)
          ).data
        : (
            await db
              .from("interaction_turns")
              .select("id, role, content, at:occurred_at")
              .eq("session_id", sessionId)
              .eq("workspace_id", workspaceId)
              .in("role", ["user", "assistant"])
              .order("occurred_at")
              .limit(3000)
          ).data;
      return (rows ?? []) as unknown as RecallTurn[];
    },
    async existing(sessionId) {
      const { data } = await db
        .from("recall_chunks")
        .select("chunk_index, content_hash")
        .eq("session_id", sessionId)
        .eq("workspace_id", workspaceId);
      return (data ?? []).map((c) => ({ index: c.chunk_index, hash: c.content_hash }));
    },
    async upsert(sessionId, chunks) {
      const { error } = await db.from("recall_chunks").upsert(
        chunks.map((c) => ({
          workspace_id: workspaceId,
          user_id: userId,
          session_id: sessionId,
          chunk_index: c.index,
          source_ids: c.sourceIds,
          started_at: c.startedAt,
          ended_at: c.endedAt,
          content: c.content,
          content_hash: c.hash,
          embedding: c.embedding ? toVector(c.embedding) : null,
          embedding_model: c.embedding ? embeddingModel : null,
        })),
        { onConflict: "session_id,chunk_index" },
      );
      if (error) throw error;
    },
    async deleteFrom(sessionId, index) {
      await db
        .from("recall_chunks")
        .delete()
        .eq("session_id", sessionId)
        .eq("workspace_id", workspaceId)
        .gte("chunk_index", index);
    },
    embed,
    summarize,
    async session(sessionId) {
      const { data } = await db
        .from("interaction_sessions")
        .select("summarized_turns, title")
        .eq("id", sessionId)
        .eq("workspace_id", workspaceId)
        .single();
      return { summarizedTurns: data?.summarized_turns ?? 0, title: data?.title ?? null };
    },
    async saveSession(sessionId, patch) {
      await db
        .from("interaction_sessions")
        .update({
          indexed_through: patch.indexedThrough,
          ...(patch.lastActivityAt ? { last_activity_at: patch.lastActivityAt } : {}),
          ...(patch.summary
            ? {
                title: patch.summary.title,
                summary: patch.summary.summary,
                topics: patch.summary.topics,
                summarized_turns: patch.summary.turns,
              }
            : {}),
        })
        .eq("id", sessionId)
        .eq("workspace_id", workspaceId);
    },
  };
}

/** Indexes (or re-indexes) one conversation. Archived conversations are never indexed. */
export async function indexConversation(
  workspaceId: string,
  conversationId: string,
  opts: { summarize?: boolean } = {},
) {
  const db = createAdminClient();
  const { data: c } = await db
    .from("conversations")
    .select("id, user_id, title, archived_at, created_at, last_message_at")
    .eq("id", conversationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!c || c.archived_at) return null;
  let { data: session } = await db
    .from("interaction_sessions")
    .select("id")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (!session) {
    const { data, error } = await db
      .from("interaction_sessions")
      .insert({
        workspace_id: workspaceId,
        user_id: c.user_id,
        modality: "text",
        conversation_id: conversationId,
        title: c.title,
        started_at: c.created_at,
        last_activity_at: c.last_message_at,
      })
      .select("id")
      .single();
    if (error) {
      // A concurrent index created it first.
      ({ data: session } = await db
        .from("interaction_sessions")
        .select("id")
        .eq("conversation_id", conversationId)
        .maybeSingle());
      if (!session) throw error;
    } else session = data;
  }
  const counts = await indexSession(ports(db, workspaceId, c.user_id, opts), session!.id);
  // The conversation's own clock can run past its last message (touches, tool turns): the index
  // covers everything up to it, or the conversation would look "behind" forever.
  if (c.last_message_at)
    await db
      .from("interaction_sessions")
      .update({ indexed_through: c.last_message_at })
      .eq("id", session!.id)
      .eq("workspace_id", workspaceId)
      .or(`indexed_through.is.null,indexed_through.lt."${c.last_message_at}"`);
  logger.info("recall.indexed", { conversation_id: conversationId, ...counts });
  return counts;
}

/**
 * A voice session (no History thread): its turns are already in interaction_turns, so it is
 * indexed directly. Archived sessions are never indexed.
 */
export async function indexVoiceSession(
  workspaceId: string,
  sessionId: string,
  opts: { summarize?: boolean } = {},
) {
  const db = createAdminClient();
  const { data: s } = await db
    .from("interaction_sessions")
    .select("id, user_id, status, conversation_id")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!s || s.status !== "active" || s.conversation_id) return null;
  const counts = await indexSession(ports(db, workspaceId, s.user_id, opts), s.id);
  logger.info("recall.indexed", { session_id: sessionId, modality: "voice", ...counts });
  return counts;
}

/**
 * After a turn: index in the background. Without Trigger.dev it runs detached in this
 * process; the periodic sweep catches anything that didn't finish.
 */
export function queueRecallIndex(workspaceId: string, thread: ThreadRef) {
  const run = async () => {
    if (isBackgroundConfigured()) {
      await new TriggerDevBackgroundRuntime().enqueue({
        type: "recall.index",
        payload:
          thread.kind === "conversation"
            ? { workspaceId, conversationId: thread.id }
            : { workspaceId, sessionId: thread.id },
        // One job per thread per minute is plenty; the sweep covers the rest.
        idempotencyKey: `recall:${thread.id}:${Math.floor(Date.now() / 60_000)}`,
      });
    } else if (thread.kind === "conversation") {
      await indexConversation(workspaceId, thread.id);
    } else {
      await indexVoiceSession(workspaceId, thread.id);
    }
  };
  void run().catch((error) =>
    logger.warn("recall.queue_failed", { kind: thread.kind, code: toAppError(error).code }),
  );
}

/**
 * Finds conversations whose index is missing or behind and indexes up to `limit` of them.
 * Resumable by construction: progress is the index itself, so re-running continues where
 * the last run stopped and never duplicates excerpts.
 */
export async function sweepRecall(opts: { workspaceId?: string | null; limit: number }) {
  const db = createAdminClient();
  let q = db
    .from("conversations")
    .select("id, workspace_id, last_message_at")
    .is("archived_at", null)
    .order("last_message_at", { ascending: false })
    .limit(2000);
  if (opts.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { data: conversations } = await q;
  const ids = (conversations ?? []).map((c) => c.id);
  const indexed = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("interaction_sessions")
      .select("conversation_id, indexed_through")
      .in("conversation_id", ids.slice(i, i + 200));
    for (const s of data ?? []) indexed.set(s.conversation_id!, s.indexed_through);
  }
  const due = (conversations ?? []).filter((c) => {
    const through = indexed.get(c.id);
    return !through || Date.parse(through) < Date.parse(c.last_message_at) - 1000;
  });
  let processed = 0;
  let failed = 0;
  for (const c of due.slice(0, opts.limit)) {
    try {
      await indexConversation(c.workspace_id, c.id);
      processed++;
    } catch (error) {
      failed++;
      logger.warn("recall.index_failed", { conversation_id: c.id, code: toAppError(error).code });
    }
  }
  // Voice sessions behind their last activity.
  let v = db
    .from("interaction_sessions")
    .select("id, workspace_id, indexed_through, last_activity_at")
    .is("conversation_id", null)
    .eq("status", "active")
    .order("last_activity_at", { ascending: false })
    .limit(500);
  if (opts.workspaceId) v = v.eq("workspace_id", opts.workspaceId);
  const { data: voice } = await v;
  const voiceDue = (voice ?? []).filter(
    (s) =>
      !s.indexed_through || Date.parse(s.indexed_through) < Date.parse(s.last_activity_at) - 1000,
  );
  for (const s of voiceDue.slice(0, Math.max(0, opts.limit - processed - failed))) {
    try {
      await indexVoiceSession(s.workspace_id, s.id);
      processed++;
    } catch (error) {
      failed++;
      logger.warn("recall.index_failed", { session_id: s.id, code: toAppError(error).code });
    }
  }
  const result = {
    processed,
    failed,
    remaining: Math.max(0, due.length + voiceDue.length - processed - failed),
  };
  logger.info("recall.sweep", { workspace_id: opts.workspaceId ?? "all", ...result });
  return result;
}

const RECALL_CATCH_UP = { scan: 60, sessions: 8, budgetMs: 5_000 };
const catchingUp = new Map<string, Promise<number>>();

/**
 * Before searching: index this user's recent interactions (typed and spoken) whose index is
 * missing or behind. Recall must not depend on a background worker being deployed: what
 * History shows, Recall can find. Bounded (newest first, a few sessions, a time budget),
 * idempotent (the index is the progress), shared by concurrent searches of the same user.
 * Summaries are left to the background sweep; excerpts are what search needs.
 */
export function catchUpRecall(
  workspaceId: string,
  userId: string,
  /** The thread being talked in: it's excluded from search, so not worth indexing now. */
  skip: readonly string[] = [],
): Promise<number> {
  const key = `${workspaceId}:${userId}`;
  const running = catchingUp.get(key);
  if (running) return running;
  const run = (async () => {
    const db = createAdminClient();
    const [{ data: conversations }, { data: sessions }] = await Promise.all([
      db
        .from("conversations")
        .select("id, last_message_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .is("archived_at", null)
        .order("last_message_at", { ascending: false })
        .limit(RECALL_CATCH_UP.scan),
      db
        .from("interaction_sessions")
        .select("id, conversation_id, indexed_through, last_activity_at")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .eq("status", "active")
        .order("last_activity_at", { ascending: false })
        .limit(RECALL_CATCH_UP.scan * 2),
    ]);
    const due = recallDue(conversations ?? [], sessions ?? [], {
      skip,
      limit: RECALL_CATCH_UP.sessions,
    });
    const started = Date.now();
    let indexed = 0;
    for (const d of due) {
      if (Date.now() - started > RECALL_CATCH_UP.budgetMs) break;
      try {
        if (d.conversationId)
          await indexConversation(workspaceId, d.conversationId, { summarize: false });
        else await indexVoiceSession(workspaceId, d.sessionId!, { summarize: false });
        indexed++;
      } catch (error) {
        logger.warn("recall.catch_up_failed", { code: toAppError(error).code });
      }
    }
    if (due.length)
      logger.info("recall.catch_up", {
        workspace_id: workspaceId,
        due: due.length,
        indexed,
        latency_ms: Date.now() - started,
      });
    return indexed;
  })().finally(() => catchingUp.delete(key));
  catchingUp.set(key, run);
  return run;
}

/** Recall search for the UI (History) and the chat prefetch, as the user (RLS). */
export async function searchRecall(
  auth: AuthContext,
  query: string,
  exclude: ThreadRef | null = null,
  limit: number = RECALL.maxResults,
): Promise<RecallResult[]> {
  const reader = new SupabaseRecallReader(
    auth.db,
    auth.workspaceId,
    auth.userId,
    getEmbeddingProvider,
    (skip) => catchUpRecall(auth.workspaceId, auth.userId, skip),
  );
  const { hits } = await reader.search({
    text: query,
    excludeConversationId: exclude?.kind === "conversation" ? exclude.id : null,
    excludeSessionId: exclude?.kind === "session" ? exclude.id : null,
    limit: RECALL.candidates,
  });
  const sessions = await reader.sessions([...new Set(hits.map((h) => h.sessionId))]);
  return groupRecall(hits, sessions).slice(0, limit);
}

/** Summaries for History's list (title/summary per conversation, when indexed). */
export async function sessionSummaries(auth: AuthContext, conversationIds: string[]) {
  if (!conversationIds.length)
    return new Map<string, { title: string | null; summary: string | null }>();
  const { data } = await auth.db
    .from("interaction_sessions")
    .select("conversation_id, title, summary")
    .in("conversation_id", conversationIds);
  return new Map(
    (data ?? []).map((s) => [s.conversation_id!, { title: s.title, summary: s.summary }]),
  );
}
