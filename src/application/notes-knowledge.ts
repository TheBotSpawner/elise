import "server-only";

import { noteIndexPlan, type Note } from "@/core/capabilities/notes";
import { logger } from "@/infrastructure/observability/logger";
import { notMigrated } from "@/infrastructure/providers/elise-native/common";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import { enqueueIngestion } from "./knowledge-background";

/**
 * Keeps a note's Knowledge representation in step with the note (docs/architecture/10 §31,
 * 16 §56, ADR-056). The note stays the only editable copy; Knowledge holds ONE indexed item
 * that points back to it (external_id = note id, source "ELISE Note"), whatever the number of
 * Spaces it belongs to:
 * - the item lives in its home Space (the first one), with one set of chunks;
 * - `knowledge_item_spaces` lists every Space that may retrieve it — retrieval scopes through
 *   it, so a note in three Spaces is found, embedded and cited once;
 * - a new version is indexed only when the text changed (or it's new to Knowledge); changing
 *   Spaces only updates membership, and moving home updates rows without re-embedding;
 * - no Space, or archived → the item is removed (the note itself stays).
 */
export async function syncNoteToKnowledge(
  workspaceId: string,
  note: Note,
  archived: boolean,
  textChanged = true,
) {
  const db = createAdminClient();
  const { data: existing } = await db
    .from("knowledge_items")
    .select("id, space_id, knowledge_sources!inner(source_type)")
    .eq("workspace_id", workspaceId)
    .eq("external_id", note.id)
    .eq("knowledge_sources.source_type", "note")
    .maybeSingle();

  const spaceIds = note.spaces.map((s) => s.id);
  const plan = noteIndexPlan(existing?.space_id ?? null, spaceIds, archived, textChanged);
  if (plan.action === "none") return;
  if (plan.action === "remove") {
    // Chunks, versions and memberships go with the item (on delete cascade).
    await db
      .from("knowledge_items")
      .delete()
      .eq("id", existing!.id)
      .eq("workspace_id", workspaceId);
    return;
  }

  const sourceId = await notesSource(workspaceId, plan.home);
  let itemId: string;
  if (existing) {
    itemId = existing.id;
    await db
      .from("knowledge_items")
      .update({
        title: note.title,
        ...(plan.rehome ? { space_id: plan.home, source_id: sourceId } : {}),
      })
      .eq("id", itemId)
      .eq("workspace_id", workspaceId);
    // Its home Space was removed: the same chunks move with it (no copy, no new embeddings).
    if (plan.rehome)
      await db
        .from("knowledge_chunks")
        .update({ space_id: plan.home, source_id: sourceId })
        .eq("knowledge_item_id", itemId)
        .eq("workspace_id", workspaceId);
  } else {
    const { data, error } = await db
      .from("knowledge_items")
      .insert({
        workspace_id: workspaceId,
        space_id: plan.home,
        source_id: sourceId,
        item_type: "note",
        external_id: note.id,
        title: note.title,
        source_url: `/my-elise/notes?note=${note.id}`,
        mime_type: "text/markdown",
        metadata: { native: { type: "note", id: note.id } },
      })
      .select("id")
      .single();
    if (error) throw error;
    itemId = data.id;
  }
  await setItemSpaces(workspaceId, itemId, spaceIds);

  if (!plan.reindex) {
    logger.info("knowledge.note_scope", { note_id: note.id, spaces: spaceIds.length });
    return;
  }
  const { data: last } = await db
    .from("knowledge_versions")
    .select("version_number")
    .eq("knowledge_item_id", itemId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: version, error } = await db
    .from("knowledge_versions")
    .insert({
      workspace_id: workspaceId,
      knowledge_item_id: itemId,
      version_number: (last?.version_number ?? 0) + 1,
      source_revision: note.updatedAt,
      mime_type: "text/markdown",
    })
    .select("id")
    .single();
  if (error) throw error;
  // The previous version stays current (and searchable) until this one is ready.
  await enqueueIngestion(workspaceId, version.id).catch((e) =>
    // The note is saved either way; it becomes searchable once background work runs.
    logger.warn("knowledge.note_index_not_started", {
      note_id: note.id,
      code: e?.code ?? "UNKNOWN",
    }),
  );
  logger.info("knowledge.note_reindex", { note_id: note.id, version_id: version.id });
}

/** Exactly these Spaces may retrieve the item (before migration 043: its home Space only). */
async function setItemSpaces(workspaceId: string, itemId: string, spaceIds: string[]) {
  const db = createAdminClient();
  const { error } = await db
    .from("knowledge_item_spaces")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("knowledge_item_id", itemId)
    .not("space_id", "in", `(${spaceIds.join(",")})`);
  if (error && notMigrated(error.code)) return;
  if (error) throw error;
  const { error: failed } = await db.from("knowledge_item_spaces").upsert(
    spaceIds.map((space_id) => ({
      workspace_id: workspaceId,
      knowledge_item_id: itemId,
      space_id,
    })),
    { onConflict: "knowledge_item_id,space_id", ignoreDuplicates: true },
  );
  if (failed) throw failed;
}

async function notesSource(workspaceId: string, spaceId: string): Promise<string> {
  const db = createAdminClient();
  const { data } = await db
    .from("knowledge_sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("space_id", spaceId)
    .eq("source_type", "note")
    .is("archived_at", null)
    .maybeSingle();
  if (data) return data.id;
  const { data: created, error } = await db
    .from("knowledge_sources")
    .insert({
      workspace_id: workspaceId,
      space_id: spaceId,
      provider_key: "elise_native",
      source_type: "note",
      display_name: "ELISE Notes",
      status: "ready",
    })
    .select("id")
    .single();
  if (error) throw error;
  return created.id;
}
