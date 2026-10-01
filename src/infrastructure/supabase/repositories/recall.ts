import type { EmbeddingProvider } from "@/core/knowledge/model";
import {
  keywordQuery,
  type RecallReader,
  type RecallSession,
  type RecallTurn,
} from "@/core/recall/model";
import { logger } from "@/infrastructure/observability/logger";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

const toVector = (v: number[]) => `[${v.join(",")}]`;

type SessionRow = {
  id: string;
  conversation_id: string | null;
  modality: RecallSession["modality"];
  title: string | null;
  summary: string | null;
  topics: string[];
  started_at: string;
  last_activity_at: string;
};

const toSession = (r: SessionRow): RecallSession => ({
  id: r.id,
  conversationId: r.conversation_id,
  modality: r.modality,
  title: r.title,
  summary: r.summary,
  topics: r.topics ?? [],
  startedAt: r.started_at,
  lastActivityAt: r.last_activity_at,
});

const SESSION_COLUMNS =
  "id, conversation_id, modality, title, summary, topics, started_at, last_activity_at";

/**
 * Recall over the user's own interactions, through their session (RLS: private to the author).
 * Hybrid search in Postgres: pgvector similarity + full-text, fused by rank, filtered by date.
 * Works without embeddings too (full-text only), so Recall never depends on the AI provider.
 */
export class SupabaseRecallReader implements RecallReader {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly embeddings: () => EmbeddingProvider,
  ) {}

  private async sessionOf(conversationId: string | null | undefined): Promise<string | null> {
    if (!conversationId) return null;
    const { data } = await this.db
      .from("interaction_sessions")
      .select("id")
      .eq("conversation_id", conversationId)
      .maybeSingle();
    return data?.id ?? null;
  }

  async search(q: {
    text: string;
    from?: Date | null;
    to?: Date | null;
    excludeConversationId?: string | null;
    excludeSessionId?: string | null;
    contextId?: string | null;
    limit: number;
  }) {
    let embedding: string | null = null;
    let model = "none";
    try {
      const provider = this.embeddings();
      model = provider.model;
      embedding = toVector((await provider.embed([q.text]))[0]!);
    } catch (error) {
      // Full-text still answers; the reason is logged, never shown as missing memory.
      logger.warn("recall.embedding_unavailable", {
        code: (error as { code?: string }).code ?? "UNKNOWN",
      });
    }
    const { data, error } = await this.db.rpc("search_recall_chunks", {
      p_workspace_id: this.workspaceId,
      p_user_id: this.userId,
      p_keywords: keywordQuery(q.text),
      p_embedding: embedding,
      p_embedding_model: model,
      p_from: q.from?.toISOString() ?? null,
      p_to: q.to?.toISOString() ?? null,
      p_exclude_session: q.excludeSessionId ?? (await this.sessionOf(q.excludeConversationId)),
      p_limit: q.limit,
      p_context: q.contextId ?? undefined,
    });
    if (error) throw error;
    return {
      semantic: embedding !== null,
      hits: (data ?? []).map((r) => ({
        chunkId: r.chunk_id,
        sessionId: r.session_id,
        content: r.content,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        similarity: r.similarity,
        keywordMatched: r.keyword_rank !== null,
        score: r.score,
      })),
    };
  }

  async sessions(ids: string[]) {
    if (!ids.length) return [];
    const { data } = await this.db
      .from("interaction_sessions")
      .select(SESSION_COLUMNS)
      .eq("workspace_id", this.workspaceId)
      .eq("user_id", this.userId)
      .eq("status", "active")
      .in("id", ids);
    return ((data ?? []) as SessionRow[]).map(toSession);
  }

  async recent(q: {
    from?: Date | null;
    to?: Date | null;
    limit: number;
    excludeConversationId?: string | null;
    excludeSessionId?: string | null;
  }) {
    let query = this.db
      .from("interaction_sessions")
      .select(SESSION_COLUMNS)
      .eq("workspace_id", this.workspaceId)
      .eq("user_id", this.userId)
      .eq("status", "active");
    if (q.from) query = query.gte("last_activity_at", q.from.toISOString());
    if (q.to) query = query.lt("started_at", q.to.toISOString());
    if (q.excludeConversationId)
      query = query.or(`conversation_id.is.null,conversation_id.neq.${q.excludeConversationId}`);
    if (q.excludeSessionId) query = query.neq("id", q.excludeSessionId);
    const { data } = await query.order("last_activity_at", { ascending: false }).limit(q.limit);
    return ((data ?? []) as SessionRow[]).map(toSession);
  }

  async turns(
    sessionId: string,
    q: { around?: string | null; limit: number },
  ): Promise<RecallTurn[]> {
    const [session] = await this.sessions([sessionId]);
    if (!session) return [];
    const half = Math.ceil(q.limit / 2);
    const fetch = async (after: boolean, anchor: string | null, n: number) => {
      const base = session.conversationId
        ? this.db
            .from("messages")
            .select("id, role, content, at:created_at")
            .eq("conversation_id", session.conversationId)
            .in("role", ["user", "assistant"])
        : this.db
            .from("interaction_turns")
            .select("id, role, content, at:occurred_at")
            .eq("session_id", sessionId)
            .in("role", ["user", "assistant"]);
      const col = session.conversationId ? "created_at" : "occurred_at";
      const scoped = anchor ? (after ? base.gte(col, anchor) : base.lt(col, anchor)) : base;
      const { data } = await scoped.order(col, { ascending: after }).limit(n);
      const rows = ((data ?? []) as unknown as RecallTurn[]).map((r) => ({
        ...r,
        role: r.role as RecallTurn["role"],
      }));
      return after ? rows : rows.reverse();
    };
    if (q.around) {
      const before = await fetch(false, q.around, half);
      const after = await fetch(true, q.around, q.limit - before.length);
      return [...before, ...after];
    }
    // No anchor: the latest turns of that interaction.
    return fetch(false, null, q.limit);
  }
}
