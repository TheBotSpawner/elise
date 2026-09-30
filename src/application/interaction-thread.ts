import "server-only";

import { MAX_HISTORY_MESSAGES, type HistoryMessage } from "@/core/agents/context";
import { AppError } from "@/core/errors";
import type { ThreadRef, TurnModality, VoiceTurnMeta } from "@/core/interaction";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import type { AssistantMessageMetadata } from "./chat-protocol";
import { withApprovalState, type StoredChatMessage } from "./conversations-service";
import { listSpaces } from "./knowledge-service";

/**
 * Where a turn is stored (ADR-014): a typed conversation (a History thread, messages table,
 * the user's own session under RLS) or a voice session (interaction_turns, written by the
 * server after the same ownership checks). The runtime, tools, workspace and Recall don't
 * care which — that is the point.
 */
export interface Thread {
  ref: ThreadRef;
  isNew: boolean;
  history(): Promise<HistoryMessage[]>;
  addUserTurn(text: string, modality: TurnModality, voice?: VoiceTurnMeta): Promise<void>;
  /** Returns the stored turn's id. */
  addAssistantTurn(
    text: string,
    modality: TurnModality,
    metadata: AssistantMessageMetadata,
  ): Promise<string | null>;
  touch(): Promise<void>;
  activeSpace(): Promise<{ id: string; path: string } | null>;
}

type Meta = AssistantMessageMetadata & { modality?: TurnModality; voice?: VoiceTurnMeta };
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Json;
const notes = (m: Json | null) => ((m as Meta | null)?.toolNotes ?? []).slice(0, 10);

export async function openThread(
  auth: AuthContext,
  input: {
    conversationId?: string;
    sessionId?: string;
    modality: TurnModality;
    firstMessage: string;
    spaceId?: string;
  },
): Promise<Thread> {
  if (input.conversationId) return conversationThread(auth, input.conversationId, false);
  if (input.sessionId) return sessionThread(auth, await ownSession(auth, input.sessionId), false);
  // A new interaction: spoken first → a voice session (no History thread); typed → a conversation.
  if (input.modality === "voice")
    return sessionThread(auth, await createVoiceSession(auth, input.firstMessage), true);
  return conversationThread(
    auth,
    await createConversation(auth, input.firstMessage, input.spaceId),
    true,
  );
}

// ── Conversations ────────────────────────────────────────────────────────────

async function createConversation(auth: AuthContext, firstMessage: string, spaceId?: string) {
  const { data, error } = await auth.db
    .from("conversations")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      title: firstMessage.replace(/\s+/g, " ").trim().slice(0, 80),
      // The Space is re-validated on every turn (activeSpace); this is only a reference.
      active_context: spaceId ? { knowledgeSpaceId: spaceId } : {},
    })
    .select("id")
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the conversation", { cause: error });
  return data.id;
}

function conversationThread(auth: AuthContext, id: string, isNew: boolean): Thread {
  return {
    ref: { kind: "conversation", id },
    isNew,
    async history() {
      if (isNew) return [];
      const { data, error } = await auth.db
        .from("messages")
        .select("role, content, metadata")
        .eq("conversation_id", id)
        .eq("workspace_id", auth.workspaceId)
        .in("role", ["user", "assistant"])
        .order("created_at", { ascending: false })
        .limit(MAX_HISTORY_MESSAGES);
      if (error) throw new AppError("NOT_FOUND", "Conversation not found", { cause: error });
      return data.reverse().map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        toolNotes: notes(m.metadata),
      }));
    },
    async addUserTurn(text, modality, voice) {
      const { error } = await auth.db.from("messages").insert({
        conversation_id: id,
        workspace_id: auth.workspaceId,
        role: "user",
        content: text,
        ...(modality === "voice" ? { metadata: json({ modality, voice }) } : {}),
      });
      if (error) throw new AppError("NOT_FOUND", "Conversation not found", { cause: error });
    },
    async addAssistantTurn(text, modality, metadata) {
      const { data } = await auth.db
        .from("messages")
        .insert({
          conversation_id: id,
          workspace_id: auth.workspaceId,
          role: "assistant",
          content: text,
          metadata: json({ ...metadata, ...(modality === "voice" ? { modality } : {}) }),
        })
        .select("id")
        .single();
      return data?.id ?? null;
    },
    async touch() {
      await auth.db
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", id);
    },
    async activeSpace() {
      const { data } = await auth.db
        .from("conversations")
        .select("active_context")
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId)
        .maybeSingle();
      const spaceId = (data?.active_context as { knowledgeSpaceId?: string } | null)
        ?.knowledgeSpaceId;
      if (!spaceId) return null;
      const space = (await listSpaces(auth).catch(() => [])).find((s) => s.id === spaceId);
      return space ? { id: space.id, path: space.path } : null;
    },
  };
}

// ── Voice sessions ───────────────────────────────────────────────────────────

/** The author's own active voice session (read through RLS), or NOT_FOUND. */
export async function ownSession(auth: AuthContext, sessionId: string): Promise<string> {
  const { data } = await auth.db
    .from("interaction_sessions")
    .select("id, conversation_id, status")
    .eq("id", sessionId)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data || data.status !== "active" || data.conversation_id)
    throw new AppError("NOT_FOUND", "Voice session not found");
  return data.id;
}

async function createVoiceSession(auth: AuthContext, firstMessage: string): Promise<string> {
  const { data, error } = await createAdminClient()
    .from("interaction_sessions")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      modality: "voice",
      title: firstMessage.replace(/\s+/g, " ").trim().slice(0, 80),
    })
    .select("id")
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the voice session", { cause: error });
  return data.id;
}

function sessionThread(auth: AuthContext, id: string, isNew: boolean): Thread {
  // Writes use the service role (interaction_turns isn't writable by clients); every row is
  // scoped to this workspace, and a database trigger ties the session to its user.
  const admin = createAdminClient();
  return {
    ref: { kind: "session", id },
    isNew,
    async history() {
      if (isNew) return [];
      const { data } = await auth.db
        .from("interaction_turns")
        .select("role, content, metadata")
        .eq("session_id", id)
        .in("role", ["user", "assistant"])
        .order("occurred_at", { ascending: false })
        .limit(MAX_HISTORY_MESSAGES);
      return (data ?? []).reverse().map((t) => ({
        role: t.role as "user" | "assistant",
        content: t.content,
        toolNotes: notes(t.metadata),
      }));
    },
    async addUserTurn(text, modality, voice) {
      const { error } = await admin.from("interaction_turns").insert({
        workspace_id: auth.workspaceId,
        session_id: id,
        role: "user",
        modality,
        content: text,
        metadata: json(voice ? { voice } : {}),
      });
      if (error) throw new AppError("INTERNAL_ERROR", "Could not save the turn", { cause: error });
    },
    async addAssistantTurn(text, modality, metadata) {
      const { data } = await admin
        .from("interaction_turns")
        .insert({
          workspace_id: auth.workspaceId,
          session_id: id,
          role: "assistant",
          modality,
          content: text || " ",
          metadata: json(metadata),
        })
        .select("id")
        .single();
      return data?.id ?? null;
    },
    async touch() {
      await admin
        .from("interaction_sessions")
        .update({ last_activity_at: new Date().toISOString() })
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId);
    },
    async activeSpace() {
      return null;
    },
  };
}

/** A voice session as the chat shows it (restored on Home with `?session=`). */
export async function loadVoiceSession(
  auth: AuthContext,
  sessionId: string,
): Promise<StoredChatMessage[] | null> {
  try {
    await ownSession(auth, sessionId);
  } catch {
    return null;
  }
  const { data } = await auth.db
    .from("interaction_turns")
    .select("id, role, modality, content, metadata, occurred_at")
    .eq("session_id", sessionId)
    .in("role", ["user", "assistant"])
    .order("occurred_at")
    .limit(200);
  const messages = (data ?? []).map((t) => {
    const meta = (t.metadata ?? {}) as Meta;
    return {
      id: t.id,
      role: t.role as "user" | "assistant",
      ...(t.modality === "voice" ? { modality: "voice" as const } : {}),
      content: t.content.trim(),
      tools: meta.tools ?? [],
      error: meta.error,
      createdAt: t.occurred_at,
    };
  });
  return withApprovalState(auth, messages);
}

/** Voice sessions for History's secondary list (review and delete; no thread of their own). */
export async function listVoiceSessions(auth: AuthContext, limit = 20) {
  const { data } = await auth.db
    .from("interaction_sessions")
    .select("id, title, summary, last_activity_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .is("conversation_id", null)
    .eq("status", "active")
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    at: s.last_activity_at,
  }));
}

/** Deleting a voice session forgets its transcripts, Recall excerpts and workspace (trigger). */
export async function archiveVoiceSession(auth: AuthContext, sessionId: string) {
  await ownSession(auth, sessionId);
  const { error } = await createAdminClient()
    .from("interaction_sessions")
    .update({ status: "archived" })
    .eq("id", sessionId)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId);
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not delete the voice session", { cause: error });
}
