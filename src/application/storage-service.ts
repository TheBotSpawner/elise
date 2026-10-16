import "server-only";

import { AppError } from "@/core/errors";
import { categoryOf, type StorageCategory, type StoredFile } from "@/core/storage/accounting";

import type { AuthContext } from "./auth-context";
import { deleteItem } from "./knowledge-service";

/**
 * Storage (ADR-068): the files ELISE keeps for this person — Knowledge uploads (every stored
 * version) and chat attachments. Read from the metadata rows written at upload time, through
 * the user's session (RLS), so another workspace's files can never appear. Drive, Notion and
 * Sheets content has no stored original (storage_path is null) and is never counted.
 */
const PAGE = 1000;
const MAX = 20_000;

async function paged<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new AppError("INTERNAL_ERROR", "Could not read storage", { cause: error });
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
  }
  return out;
}

/** Rows by id, in chunks small enough for a URL. */
async function byIds<T extends { id: string }>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null }>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await query(ids.slice(i, i + 200));
    for (const r of data ?? []) out.set(r.id, r);
  }
  return out;
}

export async function listStoredFiles(auth: AuthContext): Promise<StoredFile[]> {
  const ws = auth.workspaceId;
  const [versions, attachments] = await Promise.all([
    paged((from, to) =>
      auth.db
        .from("knowledge_versions")
        .select("id, knowledge_item_id, size_bytes, mime_type, created_at, version_number")
        .eq("workspace_id", ws)
        .not("storage_path", "is", null)
        .not("size_bytes", "is", null)
        .order("id")
        .range(from, to),
    ),
    paged((from, to) =>
      auth.db
        .from("chat_attachments")
        .select("id, name, mime_type, size_bytes, created_at, conversation_id")
        .eq("workspace_id", ws)
        .in("status", ["ready", "sent"])
        .order("id")
        .range(from, to),
    ),
  ]);
  const items = await byIds([...new Set(versions.map((v) => v.knowledge_item_id))], (chunk) =>
    auth.db
      .from("knowledge_items")
      .select("id, title, mime_type, space_id")
      .eq("workspace_id", ws)
      .in("id", chunk),
  );
  const [spaces, conversations] = await Promise.all([
    byIds([...new Set([...items.values()].map((i) => i.space_id))], (chunk) =>
      auth.db.from("knowledge_spaces").select("id, name").eq("workspace_id", ws).in("id", chunk),
    ),
    byIds(
      [...new Set(attachments.flatMap((a) => (a.conversation_id ? [a.conversation_id] : [])))],
      (chunk) => auth.db.from("conversations").select("id, title").in("id", chunk),
    ),
  ]);
  const knowledge = versions.flatMap((v): StoredFile[] => {
    const item = items.get(v.knowledge_item_id);
    if (!item) return [];
    return [
      {
        id: v.id,
        origin: "knowledge",
        name: v.version_number > 1 ? `${item.title} · v${v.version_number}` : item.title,
        mimeType: v.mime_type ?? item.mime_type,
        bytes: Number(v.size_bytes ?? 0),
        createdAt: v.created_at,
        where: { kind: "space", id: item.space_id, label: spaces.get(item.space_id)?.name ?? "" },
        deletable: true,
        sourceId: item.id,
      },
    ];
  });
  const chat = attachments.map((a): StoredFile => ({
    id: a.id,
    origin: "chat",
    name: a.name,
    mimeType: a.mime_type,
    bytes: Number(a.size_bytes),
    createdAt: a.created_at,
    where: {
      kind: "conversation",
      id: a.conversation_id ?? "",
      label: (a.conversation_id && conversations.get(a.conversation_id)?.title) || "",
    },
    // A sent attachment belongs to its conversation: deleting that conversation removes it.
    deletable: false,
    sourceId: null,
  }));
  return [...knowledge, ...chat];
}

export async function storedFilesIn(auth: AuthContext, category: StorageCategory) {
  return (await listStoredFiles(auth)).filter((f) => categoryOf(f) === category);
}

/**
 * Removes a Knowledge upload (the document, every stored version and what ELISE learned from
 * it) — the same removal as in Knowledge. Only ELISE's own uploads: a Drive or Notion item has
 * no stored original and is refused.
 */
export async function deleteStoredFile(auth: AuthContext, itemId: string) {
  const { data } = await auth.db
    .from("knowledge_versions")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("knowledge_item_id", itemId)
    .not("storage_path", "is", null)
    .limit(1);
  if (!data?.length)
    throw new AppError("PERMISSION_DENIED", "Only files uploaded to ELISE can be removed here");
  await deleteItem(auth, itemId);
}
