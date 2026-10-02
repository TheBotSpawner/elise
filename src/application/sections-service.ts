import "server-only";

import { nameKey, type ContextKind, type ContextProfile } from "@/core/contexts/model";
import { AppError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";
import { createContextProfile, listContextProfiles } from "./contexts-service";
import { createSpace, uploadSource } from "./knowledge-service";

/**
 * Knowledge Sections (ADR-018): a first-level child of a Knowledge Space. The Section is the
 * Knowledge hierarchy (a child Space with its own sources); its Context Profile is its
 * intelligence (links, people, study progress). Untyped: what the user asks decides whether
 * Study or Work Intelligence runs (ADR-020). Users create one thing — a Section — and both
 * exist, 1:1, with the Space as the source of truth for name and place.
 */

async function rootSpace(auth: AuthContext, id: string) {
  const { data } = await auth.db
    .from("knowledge_spaces")
    .select("id, name, parent_space_id")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Space not found", { recovery: "review" });
  // One visible level: Space › Section, never a filesystem.
  if (data.parent_space_id)
    throw new AppError("VALIDATION_ERROR", "A Section can't have Sections of its own", {
      recovery: "review",
    });
  return data;
}

async function audit(auth: AuthContext, event: string, id: string, metadata = {}) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: event,
    resource_type: "knowledge_space",
    resource_id: id,
    origin: "user_ui",
    result: "success",
    metadata,
  });
}

export interface NewSection {
  parentId: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  /**
   * Internal hint only (an older context ELISE adopted had one). Sections are untyped for the
   * user; intent decides Study or Work Intelligence (ADR-020).
   */
  kind?: ContextKind;
}

/**
 * Creates the Section and its context. A standalone context with the same name (from before
 * Sections existed) is adopted instead of duplicated, so its links, people and study progress
 * carry over.
 */
export async function createSection(auth: AuthContext, input: NewSection) {
  await rootSpace(auth, input.parentId);
  const spaceId = await createSpace(auth, {
    name: input.name,
    description: input.description ?? null,
    parentId: input.parentId,
    icon: input.icon ?? null,
    color: input.color ?? null,
  });
  const kind = input.kind ?? "custom";
  try {
    const adoptable = (await listContextProfiles(auth)).find(
      (p) => !p.section && nameKey(p.name) === nameKey(input.name),
    );
    if (adoptable) {
      const { error } = await auth.db
        .from("context_profiles")
        // An adopted context keeps whatever it already knew (its kind included).
        .update({ knowledge_space_id: spaceId })
        .eq("id", adoptable.id)
        .eq("workspace_id", auth.workspaceId);
      if (error) throw error;
    } else {
      await createContextProfile(
        auth,
        {
          kind,
          name: input.name,
          description: input.description ?? null,
          icon: input.icon ?? null,
          accent: input.color ?? null,
          links: [],
          sectionSpaceId: spaceId,
        },
        "user_ui",
      );
    }
    await audit(auth, "knowledge.section_created", spaceId, { adopted: Boolean(adoptable) });
    logger.info("knowledge.section_created", { adopted: !!adoptable });
    trackEvent(auth, "section_created", { adopted: Boolean(adoptable) });
    return { id: spaceId, adopted: Boolean(adoptable) };
  } catch (error) {
    // Never a Section without its context: the new (empty) Space goes away again.
    await auth.db
      .from("knowledge_spaces")
      .delete()
      .eq("id", spaceId)
      .eq("workspace_id", auth.workspaceId);
    throw error instanceof AppError
      ? error
      : new AppError("INTERNAL_ERROR", "Could not create the Section", { cause: error });
  }
}

/** Moving a Space keeps the hierarchy one level deep (Space › Section). */
export async function assertSectionPlacement(
  auth: AuthContext,
  spaceId: string,
  parentId: string | null,
) {
  if (!parentId) return;
  await rootSpace(auth, parentId);
  const { count } = await auth.db
    .from("knowledge_spaces")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", auth.workspaceId)
    .eq("parent_space_id", spaceId)
    .eq("status", "active");
  if (count)
    throw new AppError("VALIDATION_ERROR", "A Space with Sections can't become a Section", {
      recovery: "review",
    });
}

/** The Section's context profile (null for a Space, or a Section from before ADR-018). */
export async function sectionProfile(
  auth: AuthContext,
  spaceId: string,
): Promise<ContextProfile | null> {
  return (
    (await listContextProfiles(auth, true)).find((p) => p.section?.spaceId === spaceId) ?? null
  );
}

/** A Space that just became a Section gets its (general) context, unless it has one. */
export async function ensureSectionProfile(auth: AuthContext, spaceId: string) {
  await createSectionProfile(auth, spaceId);
}

/** Purpose of a Section: a Section that predates ADR-018 gets its context on first change. */
async function createSectionProfile(auth: AuthContext, spaceId: string) {
  const { data: space } = await auth.db
    .from("knowledge_spaces")
    .select("id, name, description, icon, color, parent_space_id")
    .eq("id", spaceId)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (!space?.parent_space_id)
    throw new AppError("NOT_FOUND", "Section not found", { recovery: "review" });
  if (await sectionProfile(auth, spaceId)) return;
  {
    await createContextProfile(
      auth,
      {
        kind: "custom",
        name: space.name,
        description: space.description,
        icon: space.icon,
        accent: space.color,
        links: [],
        sectionSpaceId: spaceId,
      },
      "user_ui",
    );
  }
}

/**
 * Moves an uploaded document between a Space and one of its Sections (either way). Nothing is
 * copied: the item and its passages change place. Synced items (Drive, Notion) belong to their
 * source and move with it, never alone.
 */
export async function moveItem(auth: AuthContext, itemId: string, targetSpaceId: string) {
  const { data: item } = await auth.db
    .from("knowledge_items")
    .select("id, space_id, source_id")
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .maybeSingle();
  if (!item) throw new AppError("NOT_FOUND", "Document not found", { recovery: "review" });
  const { data: source } = await auth.db
    .from("knowledge_sources")
    .select("source_type")
    .eq("id", item.source_id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (source?.source_type !== "upload")
    throw new AppError(
      "VALIDATION_ERROR",
      "Only uploaded documents can be moved; synced ones follow their source",
      { recovery: "review" },
    );
  const { data: spaces } = await auth.db
    .from("knowledge_spaces")
    .select("id, parent_space_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active")
    .in("id", [item.space_id, targetSpaceId]);
  const from = spaces?.find((s) => s.id === item.space_id);
  const to = spaces?.find((s) => s.id === targetSpaceId);
  const family =
    from &&
    to &&
    from.id !== to.id &&
    (to.parent_space_id === from.id ||
      from.parent_space_id === to.id ||
      (from.parent_space_id !== null && from.parent_space_id === to.parent_space_id));
  if (!family)
    throw new AppError("VALIDATION_ERROR", "A document moves within its Space and its Sections", {
      recovery: "review",
    });
  const sourceId = await uploadSource(auth, targetSpaceId);
  // Ownership was checked above through the user's session; passages are server-managed rows.
  const admin = createAdminClient();
  const { error } = await admin
    .from("knowledge_items")
    .update({ space_id: targetSpaceId, source_id: sourceId })
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not move the document", { cause: error });
  await admin
    .from("knowledge_chunks")
    .update({ space_id: targetSpaceId, source_id: sourceId })
    .eq("knowledge_item_id", itemId)
    .eq("workspace_id", auth.workspaceId);
  await audit(auth, "knowledge.item_moved", targetSpaceId, { item_id: itemId });
}
