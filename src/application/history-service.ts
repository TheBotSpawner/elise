import "server-only";

import { nameKey } from "@/core/contexts/model";
import {
  conciseTitle,
  matchesFilter,
  nodesMatching,
  threadKey,
  type Chip,
  type HistoryFilter,
  type KnowledgeNode,
} from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";

import type { AuthContext } from "./auth-context";
import { listConversations } from "./conversations-service";
import { historyLinks, tagsFor } from "./history-links-service";
import { listVoiceSessions } from "./interaction-thread";
import { searchRecall, sessionSummaries } from "./recall-service";

/**
 * History (ADR-020): typed conversations and voice sessions in one list, each with its Space /
 * Section tags; filtered, searched and grouped by the same Spaces and Sections as Knowledge.
 */
export interface HistoryRow {
  thread: ThreadRef;
  key: string;
  title: string;
  summary: string | null;
  at: string;
  voice: boolean;
  spaceIds: string[];
  chips: Chip[];
}

export interface HistoryQuery {
  q?: string;
  filter: HistoryFilter;
  sort: "newest" | "oldest";
}

/** Titles read as what the conversation was about: the summary's title, else a cleaned one. */
const titleOf = (summaryTitle: string | null | undefined, raw: string | null) =>
  summaryTitle?.trim() || (raw ? conciseTitle(raw) : "");

export async function historyRows(
  auth: AuthContext,
  query: HistoryQuery,
): Promise<{ rows: HistoryRow[]; nodes: KnowledgeNode[]; untaggedRecent: ThreadRef[] }> {
  const [conversations, voice, nodes] = await Promise.all([
    listConversations(auth, 100),
    listVoiceSessions(auth, 50).catch(() => []),
    historyLinks(auth)
      .nodes()
      .catch(() => [] as KnowledgeNode[]),
  ]);
  const summaries = await sessionSummaries(
    auth,
    conversations.map((c) => c.id),
  ).catch(() => new Map<string, { title: string | null; summary: string | null }>());

  const base: Omit<HistoryRow, "spaceIds" | "chips">[] = [
    ...conversations.map((c) => {
      const thread = { kind: "conversation" as const, id: c.id };
      return {
        thread,
        key: threadKey(thread),
        title: titleOf(summaries.get(c.id)?.title, c.title),
        summary: summaries.get(c.id)?.summary ?? null,
        at: c.lastMessageAt,
        voice: false,
      };
    }),
    ...voice.map((v) => {
      const thread = { kind: "session" as const, id: v.id };
      return {
        thread,
        key: threadKey(thread),
        title: v.title ? titleOf(null, v.title) : "",
        summary: v.summary,
        at: v.at,
        voice: true,
      };
    }),
  ];
  const { tags } = await tagsFor(
    auth,
    base.map((r) => r.thread),
    nodes,
  ).catch(() => ({ tags: new Map() }));
  let rows: HistoryRow[] = base.map((r) => ({
    ...r,
    spaceIds: tags.get(r.key)?.spaceIds ?? [],
    chips: tags.get(r.key)?.chips ?? [],
  }));

  // Recent threads without tags get evaluated after the page is sent (same deterministic
  // rules as after a turn), so conversations from before tagging existed catch up.
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const untaggedRecent = nodes.length
    ? rows
        .filter((r) => !r.spaceIds.length && r.at >= monthAgo)
        .slice(0, 10)
        .map((r) => r.thread)
    : [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  rows = rows.filter((r) => matchesFilter(r.spaceIds, query.filter, byId));

  const q = query.q?.trim() ?? "";
  if (q) {
    // Words in the conversation (Recall: meaning + exact words) ∪ title/summary ∪ tag names.
    const recalled = new Set(
      (await searchRecall(auth, q, null, 30).catch(() => [])).flatMap((r) => {
        if (!r.url) return [];
        const conv = /^\/chat\/([0-9a-f-]{36})$/.exec(r.url)?.[1];
        const sess = /session=([0-9a-f-]{36})/.exec(r.url)?.[1];
        return conv ? [`conversation:${conv}`] : sess ? [`session:${sess}`] : [];
      }),
    );
    const tagged = new Set(nodesMatching(q, nodes));
    const key = nameKey(q);
    rows = rows.filter(
      (r) =>
        recalled.has(r.key) ||
        r.spaceIds.some((id) => tagged.has(id)) ||
        nameKey(`${r.title} ${r.summary ?? ""}`).includes(key),
    );
  }

  rows.sort((a, b) =>
    query.sort === "oldest" ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at),
  );
  return { rows, nodes, untaggedRecent };
}

/**
 * Conversations of a Space (its Sections included) or of one Section, for the Knowledge page.
 * The same links as History; nothing is copied.
 */
export async function relatedConversations(
  auth: AuthContext,
  spaceId: string,
  limit = 5,
): Promise<
  { thread: ThreadRef; href: string; title: string; at: string; section: string | null }[]
> {
  const port = historyLinks(auth);
  const nodes = await port.nodes();
  const node = nodes.find((n) => n.id === spaceId);
  if (!node) return [];
  const ids = node.parentId
    ? [node.id]
    : [node.id, ...nodes.filter((n) => n.parentId === node.id).map((n) => n.id)];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  return (await port.threadsFor(ids, limit * 3))
    .filter((t) => !seen.has(threadKey(t.thread)) && seen.add(threadKey(t.thread)))
    .slice(0, limit)
    .map((t) => ({
      thread: t.thread,
      href: t.thread.kind === "conversation" ? `/chat/${t.thread.id}` : `/?session=${t.thread.id}`,
      title: t.title ? conciseTitle(t.title) : "",
      at: t.at,
      section: t.spaceId !== node.id ? (byId.get(t.spaceId)?.name ?? null) : null,
    }));
}
