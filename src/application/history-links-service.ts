import "server-only";

import { AppError } from "@/core/errors";
import {
  chipsFor,
  primaryLink,
  emptyEvidence,
  linksToAdd,
  mentionedNodes,
  scoreEvidence,
  threadKey,
  type Chip,
  type KnowledgeNode,
  type ThreadEvidence,
  type ThreadLink,
} from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import { logger } from "@/infrastructure/observability/logger";
import { SupabaseHistoryLinks } from "@/infrastructure/supabase/repositories/history-links";

import type { AuthContext } from "./auth-context";

/**
 * History organized by Knowledge (ADR-020). ELISE links a thread to Spaces/Sections from
 * evidence after a turn; the user adds, removes and changes links. Canonical side: the History
 * thread (conversation or voice session). A link organizes what the user can already read and
 * never widens access.
 */
export const historyLinks = (auth: AuthContext) =>
  new SupabaseHistoryLinks(auth.db, auth.workspaceId, auth.userId);

const bump = (m: Map<string, number>, id: string, by = 1) => m.set(id, (m.get(id) ?? 0) + by);

/** Knowledge passages one stored turn used: spaceId → passages. */
function knowledgeOf(metadata: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const tools = (metadata as { tools?: { outcome?: { display?: unknown } }[] } | null)?.tools;
  for (const t of tools ?? []) {
    const d = t.outcome?.display as
      { kind?: string; evidence?: { spaceId?: string }[] } | undefined;
    if (d?.kind !== "knowledge_evidence") continue;
    for (const e of d.evidence ?? []) if (e.spaceId) bump(out, e.spaceId);
  }
  return out;
}

/** Reads what a thread showed so far: activations, Knowledge used, names mentioned. */
async function gatherEvidence(
  auth: AuthContext,
  thread: ThreadRef,
  nodes: KnowledgeNode[],
): Promise<ThreadEvidence> {
  const e = emptyEvidence();
  const column = thread.kind === "conversation" ? "conversation_id" : "session_id";
  const [{ data: interactions }, turns] = await Promise.all([
    auth.db
      .from("context_interactions")
      .select("context_profile_id")
      .eq("workspace_id", auth.workspaceId)
      .eq(column, thread.id),
    thread.kind === "conversation"
      ? auth.db
          .from("messages")
          .select("role, content, metadata")
          .eq("conversation_id", thread.id)
          .in("role", ["user", "assistant"])
          .order("created_at", { ascending: false })
          .limit(60)
      : auth.db
          .from("interaction_turns")
          .select("role, content, metadata")
          .eq("session_id", thread.id)
          .in("role", ["user", "assistant"])
          .order("occurred_at", { ascending: false })
          .limit(60),
  ]);
  const profileIds = (interactions ?? []).map((i) => i.context_profile_id);
  if (profileIds.length) {
    const { data: profiles } = await auth.db
      .from("context_profiles")
      .select("knowledge_space_id")
      .eq("workspace_id", auth.workspaceId)
      .in("id", profileIds);
    for (const p of profiles ?? []) if (p.knowledge_space_id) e.activated.add(p.knowledge_space_id);
  }
  for (const turn of turns.data ?? []) {
    if (turn.role === "user")
      for (const id of mentionedNodes(turn.content, nodes)) bump(e.mentionTurns, id);
    else
      for (const [id, n] of knowledgeOf(turn.metadata)) {
        bump(e.knowledgeTurns, id);
        bump(e.knowledgePassages, id, n);
      }
  }
  return e;
}

/**
 * After a turn: adds the links the evidence supports (conservative; at most a few), never
 * re-adding one the user removed unless they explicitly went into it again afterwards.
 * Idempotent: running it twice adds nothing new. Never throws into the chat.
 */
export async function autoLinkThread(
  auth: AuthContext,
  thread: ThreadRef,
  turn: {
    /** Section(s) active in this turn's context. */
    activeSpaceIds?: string[];
    /** The Space/Section the conversation was started from. */
    scopedSpaceIds?: string[];
    /** The Section this turn's request was resolved to, from the user's words. */
    resolvedSpaceIds?: string[];
    /** Entered explicitly in this turn (switched to, started there): may undo a removal. */
    strongSpaceIds?: string[];
    at?: string;
  } = {},
): Promise<string[]> {
  try {
    const port = historyLinks(auth);
    const nodes = await port.nodes();
    if (!nodes.length) return [];
    const evidence = await gatherEvidence(auth, thread, nodes);
    for (const id of turn.activeSpaceIds ?? []) evidence.activated.add(id);
    for (const id of turn.scopedSpaceIds ?? []) evidence.scoped.add(id);
    evidence.resolved = new Set(turn.resolvedSpaceIds ?? []);
    const at = turn.at ?? new Date().toISOString();
    const strongNow = new Map((turn.strongSpaceIds ?? []).map((id) => [id, at]));
    const add = linksToAdd(scoreEvidence(evidence, nodes), await port.linksOf([thread]), strongNow);
    for (const s of add)
      await port.set(thread, s.spaceId, "linked", "automatic", {
        evidence: s.evidence,
        confidence: s.confidence,
      });
    if (add.length) logger.info("history.auto_linked", { thread: thread.kind, count: add.length });
    return add.map((s) => s.spaceId);
  } catch (error) {
    logger.warn("history.auto_link_failed", { code: (error as { code?: string }).code });
    return [];
  }
}

async function ownThread(auth: AuthContext, thread: ThreadRef) {
  const { data } =
    thread.kind === "conversation"
      ? await auth.db
          .from("conversations")
          .select("id")
          .eq("id", thread.id)
          .eq("workspace_id", auth.workspaceId)
          .eq("user_id", auth.userId)
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

/** The user links a thread to a Space/Section (it stays, whatever ELISE infers). */
export async function linkThread(auth: AuthContext, thread: ThreadRef, spaceId: string) {
  await ownThread(auth, thread);
  const nodes = await historyLinks(auth).nodes();
  if (!nodes.some((n) => n.id === spaceId))
    throw new AppError("NOT_FOUND", "Space not found", { recovery: "review" });
  await historyLinks(auth).set(thread, spaceId, "linked", "manual");
}

/** The user removes a link; it is remembered so ELISE doesn't put it back on its own. */
export async function unlinkThread(auth: AuthContext, thread: ThreadRef, spaceId: string) {
  await ownThread(auth, thread);
  await historyLinks(auth).set(thread, spaceId, "removed", "manual");
}

export interface ThreadTags {
  /** Linked node ids (Spaces or Sections). */
  spaceIds: string[];
  chips: Chip[];
  /** Where it is filed in the folder view (one place). */
  primary: string | null;
}

/** Tags of many threads at once, for History rows. */
export async function tagsFor(
  auth: AuthContext,
  threads: ThreadRef[],
  nodes?: KnowledgeNode[],
): Promise<{ tags: Map<string, ThreadTags>; nodes: KnowledgeNode[] }> {
  const port = historyLinks(auth);
  const [all, links] = await Promise.all([
    nodes ? Promise.resolve(nodes) : port.nodes(),
    port.linksOf(threads),
  ]);
  const byId = new Map(all.map((n) => [n.id, n]));
  const grouped = new Map<string, ThreadLink[]>();
  for (const l of links) {
    if (l.state !== "linked" || !byId.has(l.spaceId)) continue;
    const k = threadKey(l.thread);
    grouped.set(k, [...(grouped.get(k) ?? []), l]);
  }
  const tags = new Map<string, ThreadTags>();
  for (const t of threads) {
    const own = grouped.get(threadKey(t)) ?? [];
    const ids = own.map((l) => l.spaceId);
    tags.set(threadKey(t), {
      spaceIds: ids,
      chips: chipsFor(ids, byId),
      primary: primaryLink(own, byId),
    });
  }
  return { tags, nodes: all };
}
