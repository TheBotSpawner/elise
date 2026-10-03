import "server-only";

import type { SentAttachment } from "@/core/attachments/model";
import { AppError } from "@/core/errors";

import type { AuthContext } from "./auth-context";
import type { AssistantMessageMetadata, ClientToolTrace } from "./chat-protocol";

export interface ConversationSummary {
  id: string;
  title: string | null;
  lastMessageAt: string;
}

export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Spoken turns keep their modality (the transcript is the content). */
  modality?: "text" | "voice";
  content: string;
  /** Files sent with this user turn (ADR-031). */
  attachments?: SentAttachment[];
  tools: ClientToolTrace[];
  error?: AssistantMessageMetadata["error"];
  createdAt: string;
}

export async function listConversations(
  auth: AuthContext,
  limit = 50,
): Promise<ConversationSummary[]> {
  const { data, error } = await auth.db
    .from("conversations")
    .select("id, title, last_message_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .is("archived_at", null)
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load conversations", { cause: error });
  return data.map((c) => ({ id: c.id, title: c.title, lastMessageAt: c.last_message_at }));
}

/** Loads a conversation's messages; approval cards reflect their current (not historical) state. */
export async function loadConversation(
  auth: AuthContext,
  conversationId: string,
): Promise<StoredChatMessage[] | null> {
  const { data: conversation } = await auth.db
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", auth.userId)
    .is("archived_at", null)
    .maybeSingle();
  if (!conversation) return null;

  const { data, error } = await auth.db
    .from("messages")
    .select("id, role, content, metadata, created_at")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at")
    .limit(200);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load messages", { cause: error });

  const messages = data.map((m) => {
    const meta = (m.metadata ?? {}) as AssistantMessageMetadata & {
      modality?: "text" | "voice";
      attachments?: SentAttachment[];
    };
    return {
      id: m.id,
      role: m.role as "user" | "assistant",
      ...(meta.modality === "voice" ? { modality: "voice" as const } : {}),
      content: m.content,
      ...(meta.attachments?.length ? { attachments: meta.attachments } : {}),
      tools: meta.tools ?? [],
      error: meta.error,
      createdAt: m.created_at,
    };
  });

  return withApprovalState(auth, messages);
}

/**
 * Deleting a conversation from History archives it: it leaves every list, and a database
 * trigger removes it from Recall in the same transaction (no orphan excerpts or embeddings).
 */
export async function archiveConversation(auth: AuthContext, id: string): Promise<void> {
  const { data, error } = await auth.db
    .from("conversations")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not delete the conversation", { cause: error });
  if (!data) throw new AppError("NOT_FOUND", "Conversation not found");
}

/** Approval cards reflect their current (not historical) state. */
export async function withApprovalState(
  auth: AuthContext,
  messages: StoredChatMessage[],
): Promise<StoredChatMessage[]> {
  const approvalIds = messages.flatMap((m) =>
    m.tools.flatMap((t) =>
      t.outcome?.status === "approval_required" ? [t.outcome.approvalId] : [],
    ),
  );
  if (approvalIds.length > 0) {
    const { data: approvals } = await auth.db
      .from("approvals")
      .select("id, status")
      .in("id", approvalIds);
    const resolved = new Map(
      (approvals ?? []).filter((a) => a.status !== "pending").map((a) => [a.id, a.status]),
    );
    for (const m of messages) {
      m.tools = m.tools.map((t) =>
        t.outcome?.status === "approval_required" && resolved.has(t.outcome.approvalId)
          ? {
              ...t,
              resolution: {
                decision:
                  resolved.get(t.outcome.approvalId) === "approved"
                    ? ("approved" as const)
                    : ("rejected" as const),
              },
            }
          : t,
      );
    }
  }
  return messages;
}
