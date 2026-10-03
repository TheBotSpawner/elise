import type {
  HistoryLinksPort,
  KnowledgeNode,
  LinkSource,
  LinkState,
  ThreadLink,
} from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

/**
 * History ↔ Knowledge links (ADR-020) with the user's own session: RLS keeps them private to
 * their author, and a trigger refuses threads or Spaces of another workspace.
 */
export class SupabaseHistoryLinks implements HistoryLinksPort {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
  ) {}

  async nodes(): Promise<KnowledgeNode[]> {
    const { data } = await this.db
      .from("knowledge_spaces")
      .select("id, name, parent_space_id, status, description")
      .eq("workspace_id", this.workspaceId);
    const rows = data ?? [];
    // A one-line context is an alias too ("Análisis Matemático II · 2026"); read apart so a
    // database without the context column still works.
    const { data: contexts } = await this.db
      .from("knowledge_spaces")
      .select("id, context")
      .eq("workspace_id", this.workspaceId);
    const contextOf = new Map((contexts ?? []).map((r) => [r.id, r.context]));
    const names = new Map(rows.map((r) => [r.id, r.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_space_id,
      parentName: r.parent_space_id ? (names.get(r.parent_space_id) ?? null) : null,
      archived: r.status !== "active",
      aliases: [r.description, contextOf.get(r.id)?.split(/\r?\n/)[0]].filter((x): x is string =>
        Boolean(x?.trim()),
      ),
    }));
  }

  async linksOf(threads: ThreadRef[]): Promise<ThreadLink[]> {
    const conversations = threads.filter((t) => t.kind === "conversation").map((t) => t.id);
    const sessions = threads.filter((t) => t.kind === "session").map((t) => t.id);
    if (!conversations.length && !sessions.length) return [];
    const or = [
      conversations.length ? `conversation_id.in.(${conversations.join(",")})` : null,
      sessions.length ? `session_id.in.(${sessions.join(",")})` : null,
    ]
      .filter(Boolean)
      .join(",");
    const { data } = await this.db
      .from("interaction_knowledge_links")
      .select("conversation_id, session_id, space_id, source, state, confidence, updated_at")
      .eq("workspace_id", this.workspaceId)
      .eq("user_id", this.userId)
      .or(or);
    return (data ?? []).map((r) => ({
      thread: r.conversation_id
        ? { kind: "conversation" as const, id: r.conversation_id }
        : { kind: "session" as const, id: r.session_id! },
      spaceId: r.space_id,
      source: r.source,
      state: r.state,
      confidence: r.confidence,
      updatedAt: r.updated_at,
    }));
  }

  async set(
    thread: ThreadRef,
    spaceId: string,
    state: LinkState,
    source: LinkSource,
    extra: { evidence?: string[]; confidence?: number } = {},
  ): Promise<void> {
    const column = thread.kind === "conversation" ? "conversation_id" : "session_id";
    const { data: existing } = await this.db
      .from("interaction_knowledge_links")
      .select("id")
      .eq(column, thread.id)
      .eq("space_id", spaceId)
      .maybeSingle();
    const fields = {
      state,
      source,
      ...(extra.evidence ? { evidence: extra.evidence } : {}),
      ...(extra.confidence !== undefined ? { confidence: extra.confidence } : {}),
    };
    const { error } = existing
      ? await this.db.from("interaction_knowledge_links").update(fields).eq("id", existing.id)
      : await this.db.from("interaction_knowledge_links").insert({
          workspace_id: this.workspaceId,
          user_id: this.userId,
          [column]: thread.id,
          space_id: spaceId,
          ...fields,
        });
    // A concurrent insert of the same link is the same link (unique index): fine.
    if (error && error.code !== "23505") throw error;
  }

  async threadsFor(spaceIds: string[], limit: number) {
    if (!spaceIds.length) return [];
    const { data } = await this.db
      .from("interaction_knowledge_links")
      .select("conversation_id, session_id, space_id, updated_at")
      .eq("workspace_id", this.workspaceId)
      .eq("user_id", this.userId)
      .eq("state", "linked")
      .in("space_id", spaceIds)
      .order("updated_at", { ascending: false })
      .limit(limit);
    const rows = data ?? [];
    const convIds = rows.flatMap((r) => (r.conversation_id ? [r.conversation_id] : []));
    const sessIds = rows.flatMap((r) => (r.session_id ? [r.session_id] : []));
    // Deleted (archived) threads leave History, so they leave these lists too.
    const [{ data: convs }, { data: sess }] = await Promise.all([
      convIds.length
        ? this.db
            .from("conversations")
            .select("id, title, last_message_at")
            .in("id", convIds)
            .is("archived_at", null)
        : Promise.resolve({
            data: [] as { id: string; title: string | null; last_message_at: string }[],
          }),
      sessIds.length
        ? this.db
            .from("interaction_sessions")
            .select("id, title, last_activity_at")
            .in("id", sessIds)
            .eq("status", "active")
        : Promise.resolve({
            data: [] as { id: string; title: string | null; last_activity_at: string }[],
          }),
    ]);
    const conv = new Map((convs ?? []).map((c) => [c.id, c]));
    const ses = new Map((sess ?? []).map((s) => [s.id, s]));
    type Row = { thread: ThreadRef; spaceId: string; title: string | null; at: string };
    return rows
      .flatMap((r): Row[] => {
        if (r.conversation_id) {
          const c = conv.get(r.conversation_id);
          return c
            ? [
                {
                  thread: { kind: "conversation" as const, id: c.id },
                  spaceId: r.space_id,
                  title: c.title,
                  at: c.last_message_at,
                },
              ]
            : [];
        }
        const s = ses.get(r.session_id!);
        return s
          ? [
              {
                thread: { kind: "session" as const, id: s.id },
                spaceId: r.space_id,
                title: s.title,
                at: s.last_activity_at,
              },
            ]
          : [];
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }
}
