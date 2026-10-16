import "server-only";

import { AppError } from "@/core/errors";
import { threadKey } from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import { historyLinks } from "./history-links-service";

/**
 * Organizing History (ADR-070): move a conversation to a Space (or out of every Space), rename,
 * pin and archive it. Moving changes only its links — the same `interaction_knowledge_links`
 * History and Knowledge already read — so nothing is copied, re-indexed or re-embedded, and its
 * messages and timestamps never change. Every write checks the thread is this person's and the
 * Space is in their workspace; the UI and any future ELISE tool use these same functions.
 */

async function ownThread(auth: AuthContext, thread: ThreadRef) {
  const { data } =
    thread.kind === "conversation"
      ? await auth.db
          .from("conversations")
          .select("id")
          .eq("id", thread.id)
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId)
          .is("archived_at", null)
          .maybeSingle()
      : await auth.db
          .from("interaction_sessions")
          .select("id")
          .eq("id", thread.id)
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId)
          .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Conversation not found", { recovery: "review" });
}

async function audit(
  auth: AuthContext,
  thread: ThreadRef,
  eventType: string,
  metadata: Record<string, string | boolean | null>,
) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: thread.kind === "conversation" ? "conversation" : "interaction_session",
    resource_id: thread.id,
    origin: "user_ui",
    result: "success",
    metadata,
  });
}

/**
 * Files a thread in exactly one Space or Section (null: "Sin Espacio"). The new link is the
 * person's (manual); the others become manual removals, so ELISE's automatic tagging doesn't
 * put them back. General is a Space like any other; "Sin Espacio" is no link at all.
 */
export async function moveThread(auth: AuthContext, thread: ThreadRef, spaceId: string | null) {
  await ownThread(auth, thread);
  const port = historyLinks(auth);
  const [nodes, links] = await Promise.all([port.nodes(), port.linksOf([thread])]);
  // Only this workspace's Spaces can be a destination (the port reads through RLS and the
  // workspace); an id from anywhere else is unknown here.
  if (spaceId && !nodes.some((n) => n.id === spaceId && !n.archived))
    throw new AppError("NOT_FOUND", "Space not found", { recovery: "review" });
  const linked = links.filter((l) => l.state === "linked").map((l) => l.spaceId);
  for (const id of linked) if (id !== spaceId) await port.set(thread, id, "removed", "manual");
  if (spaceId) await port.set(thread, spaceId, "linked", "manual");
  await audit(auth, thread, "conversation.space_changed", {
    from: linked.join(",") || null,
    to: spaceId,
  });
}

/**
 * Renames a thread. The History title is the conversation's summary title, so both change, and
 * the summary keeps the person's title from then on (`titleLocked`). Messages never change.
 */
export async function renameThread(auth: AuthContext, thread: ThreadRef, title: string) {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean)
    throw new AppError("VALIDATION_ERROR", "A conversation needs a name", { recovery: "review" });
  await ownThread(auth, thread);
  if (thread.kind === "conversation") {
    const { error } = await auth.db
      .from("conversations")
      .update({ title: clean })
      .eq("id", thread.id)
      .eq("workspace_id", auth.workspaceId);
    if (error) throw new AppError("INTERNAL_ERROR", "Could not rename", { cause: error });
  }
  const session =
    thread.kind === "session"
      ? auth.db.from("interaction_sessions").select("id, metadata").eq("id", thread.id)
      : auth.db
          .from("interaction_sessions")
          .select("id, metadata")
          .eq("conversation_id", thread.id);
  const { data: s } = await session.eq("workspace_id", auth.workspaceId).maybeSingle();
  if (s)
    await auth.db
      .from("interaction_sessions")
      .update({
        title: clean,
        metadata: {
          ...((s.metadata as Record<string, unknown> | null) ?? {}),
          titleLocked: true,
        } as Json,
      })
      .eq("id", s.id)
      .eq("workspace_id", auth.workspaceId);
  await audit(auth, thread, "conversation.renamed", {});
}

// ── Pins (per person, in their preferences) ─────────────────────────────────

const PINS = "history.pinned";
const MAX_PINS = 50;

export async function pinnedThreads(auth: AuthContext): Promise<Set<string>> {
  const { data } = await auth.db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("key", PINS)
    .maybeSingle();
  const v = data?.value_json;
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
}

export async function pinThread(auth: AuthContext, thread: ThreadRef, pinned: boolean) {
  await ownThread(auth, thread);
  const key = threadKey(thread);
  const current = [...(await pinnedThreads(auth))].filter((k) => k !== key);
  const next = pinned ? [key, ...current].slice(0, MAX_PINS) : current;
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: PINS,
      value_json: next,
      source: "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not pin", { cause: error });
}

/**
 * Archive (typed conversations): out of the normal views, never deleted — its messages, links
 * and Recall stay, and it comes back from "Archivadas". Deleting is the separate, existing flow
 * (`archived_at`), which also makes Recall forget it.
 */
export async function setConversationArchived(auth: AuthContext, id: string, archived: boolean) {
  const thread: ThreadRef = { kind: "conversation", id };
  await ownThread(auth, thread);
  const { error } = await auth.db
    .from("conversations")
    .update({ status: archived ? "archived" : "active" })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not archive", { cause: error });
  await audit(auth, thread, archived ? "conversation.archived" : "conversation.unarchived", {});
}
