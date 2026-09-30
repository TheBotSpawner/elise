import "server-only";

import { noteKnowledgePlan, type Note } from "@/core/capabilities/notes";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import { enqueueIngestion } from "./knowledge-background";

/**
 * Keeps a note's Knowledge representation in step with the note (docs/architecture/10 §31,
 * 16 §56). The note stays the only editable copy; Knowledge holds an indexed item that points
 * back to it (external_id = note id, source "ELISE Note"):
 * - note in a Space → item in that Space's "ELISE Notes" source, new version, re-index;
 *   unchanged text is detected by hash and not re-embedded;
 * - note moved to another Space → re-created there;
 * - note without Space, or archived → removed from Knowledge (the note itself stays).
 */
export async function syncNoteToKnowledge(workspaceId: string, note: Note, archived: boolean) {
  const db = createAdminClient();
  const { data: existing } = await db
    .from("knowledge_items")
    .select("id, space_id, knowledge_sources!inner(source_type)")
    .eq("workspace_id", workspaceId)
    .eq("external_id", note.id)
    .eq("knowledge_sources.source_type", "note")
    .maybeSingle();

  const plan = noteKnowledgePlan(existing?.space_id ?? null, note, archived);
  if (plan === "none") return;
  if ((plan === "remove" || plan === "move") && existing) {
    await db.from("knowledge_items").delete().eq("id", existing.id).eq("workspace_id", workspaceId);
  }
  if (plan === "remove" || !note.spaceId) return;

  const sourceId = await notesSource(workspaceId, note.spaceId);
  let itemId = existing && existing.space_id === note.spaceId ? existing.id : null;
  if (itemId) {
    await db
      .from("knowledge_items")
      .update({ title: note.title })
      .eq("id", itemId)
      .eq("workspace_id", workspaceId);
  } else {
    const { data, error } = await db
      .from("knowledge_items")
      .insert({
        workspace_id: workspaceId,
        space_id: note.spaceId,
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
  await enqueueIngestion(workspaceId, version.id).catch((e) =>
    // The note is saved either way; it becomes searchable once background work runs.
    logger.warn("knowledge.note_index_not_started", {
      note_id: note.id,
      code: e?.code ?? "UNKNOWN",
    }),
  );
  logger.info("knowledge.note_reindex", { note_id: note.id, version_id: version.id });
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
