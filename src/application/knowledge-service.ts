import "server-only";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { nameKey } from "@/core/contexts/model";
import { AppError } from "@/core/errors";
import {
  SPACE_COLORS,
  SPACE_ICONS,
  spaceColor,
  spaceIcon,
  type SpaceColor,
  type SpaceIcon,
} from "@/core/knowledge/appearance";
import { spacePaths, withDescendants, type SpaceInfo } from "@/core/knowledge/model";
import { sourceState, type SourceState } from "@/core/knowledge/source-state";
import { isBackgroundConfigured } from "@/infrastructure/background/trigger/runtime";
import {
  SUPPORTED_UPLOADS,
  UPLOAD_LIMITS,
  uploadMimeType,
} from "@/infrastructure/knowledge/parsers";
import { logger } from "@/infrastructure/observability/logger";
import { GoogleDriveClient } from "@/infrastructure/providers/google/drive";
import { pageTitle } from "@/infrastructure/providers/notion/client";
import { isNotionConfigured } from "@/infrastructure/providers/notion/oauth";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type {
  Json,
  KnowledgeItemRow,
  KnowledgeSourceRow,
} from "@/infrastructure/supabase/database.types";
import {
  createUploadUrl,
  originalPath,
  removeOriginals,
  signedDownloadUrl,
  uploadedSize,
  uploadOriginal,
} from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";
import { googleHttpFor, notionClientFor } from "./elise";
import { enqueueIngestion, startSync } from "./knowledge-background";

/**
 * Knowledge for the UI (docs/architecture/09): Spaces, uploads, external sources, sync and
 * previews. Reads go through the user's session (RLS); writes the user may not make directly
 * (items, versions, source state) use the service role after an ownership check here.
 */

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;
const nameSchema = z.string().trim().min(1).max(120);
const appearanceSchema = z.object({
  icon: z.enum(SPACE_ICONS).nullable(),
  color: z.enum(SPACE_COLORS).nullable(),
});
const descriptionSchema = z
  .string()
  .trim()
  .max(1000)
  .nullable()
  .transform((v) => v || null);

async function audit(
  auth: AuthContext,
  eventType: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: resourceType,
    resource_id: resourceId,
    origin: "user_ui",
    result: "success",
    metadata: json(metadata),
  });
}

// ── Spaces ───────────────────────────────────────────────────────────────────

export interface SpaceSummary extends SpaceInfo {
  description: string | null;
  /** What the Space is about, in the user's words (ADR-020 §9). */
  context: string | null;
  icon: SpaceIcon;
  color: SpaceColor;
  counts: { ready: number; processing: number; attention: number };
  /** Distinct kinds of source connected to this Space (uploads, Drive, Notion, notes). */
  sourceTypes: KnowledgeSourceRow["source_type"][];
  /** Latest change to the Space or anything in it. */
  updatedAt: string;
}

export async function listSpaces(auth: AuthContext): Promise<SpaceSummary[]> {
  const [{ data: spaces, error }, { data: items }, { data: sources }, contexts] = await Promise.all(
    [
      auth.db
        .from("knowledge_spaces")
        .select("id, name, parent_space_id, description, icon, color, updated_at")
        .eq("workspace_id", auth.workspaceId)
        .eq("status", "active")
        .order("name"),
      auth.db
        .from("knowledge_items")
        .select("space_id, status, updated_at")
        .eq("workspace_id", auth.workspaceId)
        .is("archived_at", null)
        .neq("status", "removed"),
      auth.db
        .from("knowledge_sources")
        .select("space_id, source_type")
        .eq("workspace_id", auth.workspaceId)
        .is("archived_at", null),
      // Read apart: a database without migration 24 still shows Knowledge (just no context).
      auth.db
        .from("knowledge_spaces")
        .select("id, context")
        .eq("workspace_id", auth.workspaceId)
        .eq("status", "active"),
    ],
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load Knowledge", { cause: error });
  const contextOf = new Map((contexts.data ?? []).map((r) => [r.id, r.context]));
  return spacePaths(
    spaces.map((s) => ({ id: s.id, name: s.name, parentId: s.parent_space_id })),
  ).map((s) => {
    const row = spaces.find((r) => r.id === s.id);
    const own = (items ?? []).filter((i) => i.space_id === s.id);
    return {
      ...s,
      description: row?.description ?? null,
      context: contextOf.get(s.id) ?? null,
      icon: spaceIcon(row?.icon),
      color: spaceColor(row?.color),
      sourceTypes: [
        ...new Set((sources ?? []).filter((x) => x.space_id === s.id).map((x) => x.source_type)),
      ],
      updatedAt: own.reduce(
        (latest, i) => (i.updated_at > latest ? i.updated_at : latest),
        row?.updated_at ?? "",
      ),
      counts: {
        ready: own.filter((i) => i.status === "ready").length,
        processing: own.filter((i) => i.status === "queued" || i.status === "processing").length,
        attention: own.filter((i) => i.status === "failed" || i.status === "needs_attention")
          .length,
      },
    };
  });
}

async function ownSpace(auth: AuthContext, spaceId: string) {
  const { data } = await auth.db
    .from("knowledge_spaces")
    .select("*")
    .eq("id", spaceId)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Space not found");
  return data;
}

export async function createSpace(
  auth: AuthContext,
  input: {
    name: string;
    description?: string | null;
    parentId?: string | null;
    icon?: string | null;
    color?: string | null;
  },
) {
  const name = nameSchema.parse(input.name);
  const description = descriptionSchema.parse(input.description ?? null);
  const appearance = appearanceSchema.parse({
    icon: input.icon ?? null,
    color: input.color ?? null,
  });
  if (input.parentId) await ownSpace(auth, input.parentId);
  const { data, error } = await auth.db
    .from("knowledge_spaces")
    .insert({
      workspace_id: auth.workspaceId,
      name,
      description,
      ...appearance,
      parent_space_id: input.parentId ?? null,
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("VALIDATION_ERROR", "Could not create the Space", { cause: error });
  await audit(auth, "knowledge.space_created", "knowledge_space", data.id);
  return data.id;
}

export async function updateSpace(
  auth: AuthContext,
  spaceId: string,
  input: {
    name?: string;
    description?: string | null;
    parentId?: string | null;
    icon?: string | null;
    color?: string | null;
  },
) {
  await ownSpace(auth, spaceId);
  if (input.parentId) await ownSpace(auth, input.parentId);
  const { error } = await auth.db
    .from("knowledge_spaces")
    .update({
      ...(input.name !== undefined ? { name: nameSchema.parse(input.name) } : {}),
      ...(input.description !== undefined
        ? { description: descriptionSchema.parse(input.description) }
        : {}),
      ...(input.icon !== undefined ? { icon: appearanceSchema.shape.icon.parse(input.icon) } : {}),
      ...(input.color !== undefined
        ? { color: appearanceSchema.shape.color.parse(input.color) }
        : {}),
      ...(input.parentId !== undefined ? { parent_space_id: input.parentId } : {}),
    })
    .eq("id", spaceId)
    .eq("workspace_id", auth.workspaceId);
  // The database refuses cycles and cross-workspace parents.
  if (error)
    throw new AppError("VALIDATION_ERROR", "That move isn't possible", {
      cause: error,
      recovery: "review",
    });
  // A Section's context is the same thing seen from intelligence: it follows (ADR-018).
  const name = input.name !== undefined ? nameSchema.parse(input.name).slice(0, 80) : undefined;
  const synced = {
    ...(name ? { name, name_key: nameKey(name).slice(0, 80) } : {}),
    ...(input.description !== undefined
      ? { description: descriptionSchema.parse(input.description) }
      : {}),
    ...(input.icon !== undefined ? { icon: appearanceSchema.shape.icon.parse(input.icon) } : {}),
    ...(input.color !== undefined
      ? { accent: appearanceSchema.shape.color.parse(input.color) }
      : {}),
  };
  if (Object.keys(synced).length)
    await auth.db
      .from("context_profiles")
      .update(synced)
      .eq("knowledge_space_id", spaceId)
      .eq("workspace_id", auth.workspaceId);
}

/** Archive: the Space and its sub-Spaces leave Knowledge; sources stop syncing. */
const contextSchema = z
  .string()
  .trim()
  .max(4000)
  .transform((v) => v || null)
  .nullable();

/** The Space's (or Section's) context: background ELISE reads when working there. */
export async function updateSpaceContext(
  auth: AuthContext,
  spaceId: string,
  context: string | null,
) {
  await ownSpace(auth, spaceId);
  const { error } = await auth.db
    .from("knowledge_spaces")
    .update({ context: contextSchema.parse(context) })
    .eq("id", spaceId)
    .eq("workspace_id", auth.workspaceId);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the context", { cause: error });
  await audit(auth, "knowledge.space_context_updated", "knowledge_space", spaceId);
}

export async function archiveSpace(auth: AuthContext, spaceId: string) {
  await ownSpace(auth, spaceId);
  const tree = spacePaths(
    (
      (
        await auth.db
          .from("knowledge_spaces")
          .select("id, name, parent_space_id")
          .eq("workspace_id", auth.workspaceId)
      ).data ?? []
    ).map((s) => ({
      id: s.id,
      name: s.name,
      parentId: s.parent_space_id,
    })),
  );
  const ids = new Set(withDescendants(tree, [spaceId]));
  const now = new Date().toISOString();
  const admin = createAdminClient();
  await auth.db
    .from("knowledge_spaces")
    .update({ status: "archived", archived_at: now })
    .in("id", [...ids])
    .eq("workspace_id", auth.workspaceId);
  await admin
    .from("knowledge_sources")
    .update({ status: "archived", archived_at: now })
    .in("space_id", [...ids])
    .eq("workspace_id", auth.workspaceId);
  await admin
    .from("knowledge_items")
    .update({ status: "archived", archived_at: now })
    .in("space_id", [...ids])
    .eq("workspace_id", auth.workspaceId);
  // Archived Sections take their context with them (kept, restorable — never deleted).
  await auth.db
    .from("context_profiles")
    .update({ status: "archived", archived_at: now })
    .in("knowledge_space_id", [...ids])
    .eq("workspace_id", auth.workspaceId);
  await audit(auth, "knowledge.space_archived", "knowledge_space", spaceId, { spaces: ids.size });
}

// ── Space detail ─────────────────────────────────────────────────────────────

export interface SourceView {
  id: string;
  sourceType: KnowledgeSourceRow["source_type"];
  name: string;
  status: KnowledgeSourceRow["status"];
  /** What the user sees (core/knowledge/source-state.ts). */
  state: SourceState;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  lastErrorCode: string | null;
  counts: { ready: number; processing: number; attention: number };
}

export interface ItemView {
  id: string;
  title: string;
  itemType: KnowledgeItemRow["item_type"];
  status: KnowledgeItemRow["status"];
  statusDetail: string | null;
  errorCode: string | null;
  sourceType: KnowledgeSourceRow["source_type"];
  sourceUrl: string | null;
  updatedAt: string;
  versions: number;
}

export async function getSpace(auth: AuthContext, spaceId: string) {
  const space = await ownSpace(auth, spaceId);
  const spaces = await listSpaces(auth);
  const [{ data: sources }, { data: items }] = await Promise.all([
    auth.db
      .from("knowledge_sources")
      .select(
        "id, source_type, display_name, status, last_synced_at, next_sync_at, last_error_code",
      )
      .eq("workspace_id", auth.workspaceId)
      .eq("space_id", spaceId)
      .is("archived_at", null)
      .order("created_at"),
    auth.db
      .from("knowledge_items")
      .select(
        "id, source_id, title, item_type, status, status_detail, error_code, source_url, updated_at, knowledge_sources(source_type), knowledge_versions!knowledge_versions_knowledge_item_id_fkey(id)",
      )
      .eq("workspace_id", auth.workspaceId)
      .eq("space_id", spaceId)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(300),
  ]);
  return {
    space: spaces.find((s) => s.id === spaceId) ?? {
      ...space,
      parentId: space.parent_space_id,
      path: space.name,
      counts: { ready: 0, processing: 0, attention: 0 },
      icon: spaceIcon(space.icon),
      color: spaceColor(space.color),
      sourceTypes: [],
      updatedAt: space.updated_at,
    },
    children: spaces.filter((s) => s.parentId === spaceId),
    sources: (sources ?? []).map((s): SourceView => {
      const own = (items ?? []).filter((i) => i.source_id === s.id);
      const counts = {
        ready: own.filter((i) => i.status === "ready").length,
        processing: own.filter((i) => i.status === "queued" || i.status === "processing").length,
        attention: own.filter((i) => i.status === "needs_attention" || i.status === "failed")
          .length,
      };
      return {
        id: s.id,
        sourceType: s.source_type,
        name: s.display_name,
        status: s.status,
        state: sourceState({ status: s.status, lastSyncedAt: s.last_synced_at, counts }),
        lastSyncedAt: s.last_synced_at,
        nextSyncAt: s.next_sync_at,
        lastErrorCode: s.last_error_code,
        counts,
      };
    }),
    items: (items ?? []).map((i): ItemView => ({
      id: i.id,
      title: i.title,
      itemType: i.item_type,
      status: i.status,
      statusDetail: i.status_detail,
      errorCode: i.error_code,
      sourceType:
        (
          i.knowledge_sources as unknown as {
            source_type: KnowledgeSourceRow["source_type"];
          } | null
        )?.source_type ?? "upload",
      sourceUrl: i.source_url,
      updatedAt: i.updated_at,
      versions: ((i.knowledge_versions as unknown as unknown[]) ?? []).length,
    })),
  };
}

// ── Uploads ──────────────────────────────────────────────────────────────────

const fileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(UPLOAD_LIMITS.maxBytes),
});

export interface UploadTarget {
  itemId: string;
  versionId: string;
  path: string;
  token: string;
  contentType: string;
}

function validateFile(file: unknown) {
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Files must be up to ${UPLOAD_LIMITS.maxBytes / 1024 / 1024} MB`,
      { recovery: "review" },
    );
  }
  const mimeType = uploadMimeType(parsed.data.name);
  if (!mimeType) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Supported files: ${Object.keys(SUPPORTED_UPLOADS).join(", ")}`,
      { recovery: "review" },
    );
  }
  return { ...parsed.data, mimeType };
}

export async function uploadSource(auth: AuthContext, spaceId: string): Promise<string> {
  const { data: existing } = await auth.db
    .from("knowledge_sources")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("space_id", spaceId)
    .eq("source_type", "upload")
    .is("archived_at", null)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await auth.db
    .from("knowledge_sources")
    .insert({
      workspace_id: auth.workspaceId,
      space_id: spaceId,
      provider_key: "elise_native",
      source_type: "upload",
      display_name: "Uploads",
      status: "ready",
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not prepare uploads", { cause: error });
  return data.id;
}

/** Items + versions + one-time upload URLs; the browser uploads straight to private Storage. */
export async function prepareUploads(
  auth: AuthContext,
  spaceId: string,
  files: unknown[],
): Promise<UploadTarget[]> {
  // Generous for real use (20 files per batch); stops a runaway client from flooding ingestion.
  rateLimit(`knowledge.upload:${auth.userId}`, 15, 60_000);
  await ownSpace(auth, spaceId);
  if (!files.length || files.length > UPLOAD_LIMITS.maxFilesPerBatch) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Upload 1 to ${UPLOAD_LIMITS.maxFilesPerBatch} files at a time`,
      { recovery: "review" },
    );
  }
  const valid = files.map(validateFile);
  const sourceId = await uploadSource(auth, spaceId);
  const admin = createAdminClient();
  const targets: UploadTarget[] = [];
  for (const file of valid) {
    const { data: item, error } = await admin
      .from("knowledge_items")
      .insert({
        workspace_id: auth.workspaceId,
        space_id: spaceId,
        source_id: sourceId,
        item_type: "file",
        external_id: crypto.randomUUID(),
        title: file.name,
        mime_type: file.mimeType,
        status_detail: "uploading",
        created_by_user_id: auth.userId,
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
    targets.push(await newUploadVersion(auth, item.id, 1, file));
  }
  return targets;
}

async function newUploadVersion(
  auth: AuthContext,
  itemId: string,
  number: number,
  file: { name: string; size: number; mimeType: string },
): Promise<UploadTarget> {
  const versionId = crypto.randomUUID();
  const path = originalPath(auth.workspaceId, itemId, versionId, file.name);
  const { error } = await createAdminClient()
    .from("knowledge_versions")
    .insert({
      id: versionId,
      workspace_id: auth.workspaceId,
      knowledge_item_id: itemId,
      version_number: number,
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.mimeType,
      metadata: json({ filename: file.name, uploadedBy: auth.userId }),
    });
  if (error) throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
  const { token } = await createUploadUrl(auth.workspaceId, path);
  return { itemId, versionId, path, token, contentType: file.mimeType };
}

/** Replacing an uploaded document keeps the previous version (history, compare). */
export async function prepareNewVersion(
  auth: AuthContext,
  itemId: string,
  file: unknown,
): Promise<UploadTarget> {
  const valid = validateFile(file);
  const { data: item } = await auth.db
    .from("knowledge_items")
    .select("id, knowledge_sources(source_type)")
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  const sourceType = (item?.knowledge_sources as unknown as { source_type: string } | null)
    ?.source_type;
  if (!item || sourceType !== "upload") throw new AppError("NOT_FOUND", "Document not found");
  const { data: last } = await auth.db
    .from("knowledge_versions")
    .select("version_number")
    .eq("knowledge_item_id", itemId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return newUploadVersion(auth, itemId, (last?.version_number ?? 0) + 1, valid);
}

/** After the browser uploaded: verify each file really is in Storage, then understand it. */
export async function completeUploads(auth: AuthContext, versionIds: string[]) {
  const admin = createAdminClient();
  const { data: versions } = await auth.db
    .from("knowledge_versions")
    .select("id, knowledge_item_id, storage_path, status")
    .eq("workspace_id", auth.workspaceId)
    .in("id", versionIds);
  let started = 0;
  for (const v of versions ?? []) {
    if (!v.storage_path || v.status !== "pending") continue;
    const size = await uploadedSize(auth.workspaceId, v.storage_path);
    if (size === null) {
      await admin
        .from("knowledge_items")
        .update({
          status: "failed",
          error_code: "NOT_FOUND",
          status_detail: "The upload did not finish",
        })
        .eq("id", v.knowledge_item_id)
        .eq("workspace_id", auth.workspaceId);
      continue;
    }
    await admin
      .from("knowledge_items")
      .update({ status_detail: null })
      .eq("id", v.knowledge_item_id)
      .eq("workspace_id", auth.workspaceId);
    try {
      await enqueueIngestion(auth.workspaceId, v.id);
      started++;
    } catch (error) {
      await admin
        .from("knowledge_items")
        .update({
          status: "failed",
          error_code: "BACKGROUND_ERROR",
          status_detail: "Processing could not start",
        })
        .eq("id", v.knowledge_item_id)
        .eq("workspace_id", auth.workspaceId);
      logger.warn("knowledge.enqueue_failed", {
        version_id: v.id,
        code: error instanceof AppError ? error.code : "UNKNOWN",
      });
    }
  }
  await audit(auth, "knowledge.uploaded", "knowledge_version", versionIds[0] ?? "", {
    count: started,
  });
  return { started };
}

/** Try again for a document that failed (e.g. after reconnecting its account). */
export async function retryItem(auth: AuthContext, itemId: string) {
  const { data } = await auth.db
    .from("knowledge_versions")
    .select("id, status")
    .eq("workspace_id", auth.workspaceId)
    .eq("knowledge_item_id", itemId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Document not found");
  await createAdminClient()
    .from("knowledge_versions")
    .update({ status: "pending" })
    .eq("id", data.id)
    .eq("workspace_id", auth.workspaceId);
  await createAdminClient()
    .from("knowledge_items")
    .update({ status: "queued", status_detail: null, error_code: null })
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId)
    .is("current_version_id", null);
  await enqueueIngestion(auth.workspaceId, data.id, true);
}

/** Removing a document deletes its index and originals; ELISE no longer knows it. */
export async function deleteItem(auth: AuthContext, itemId: string) {
  const { data: versions } = await auth.db
    .from("knowledge_versions")
    .select("storage_path")
    .eq("workspace_id", auth.workspaceId)
    .eq("knowledge_item_id", itemId);
  const { data: item } = await auth.db
    .from("knowledge_items")
    .select("id")
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!item) throw new AppError("NOT_FOUND", "Document not found");
  await createAdminClient()
    .from("knowledge_items")
    .delete()
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId);
  await removeOriginals(
    auth.workspaceId,
    (versions ?? []).map((v) => v.storage_path).filter((p): p is string => Boolean(p)),
  );
  await audit(auth, "knowledge.item_deleted", "knowledge_item", itemId);
}

// ── Item preview ─────────────────────────────────────────────────────────────

export async function getItemPreview(auth: AuthContext, itemId: string, chunkId: string | null) {
  const { data: item } = await auth.db
    .from("knowledge_items")
    .select(
      "id, title, item_type, status, status_detail, error_code, source_url, space_id, updated_at, metadata, knowledge_sources(source_type, display_name)",
    )
    .eq("id", itemId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!item) throw new AppError("NOT_FOUND", "Document not found");
  const [{ data: versions }, { data: chunk }, spaces] = await Promise.all([
    auth.db
      .from("knowledge_versions")
      .select(
        "id, version_number, status, is_current, created_at, storage_path, size_bytes, metadata",
      )
      .eq("workspace_id", auth.workspaceId)
      .eq("knowledge_item_id", itemId)
      .order("version_number", { ascending: false }),
    chunkId
      ? auth.db
          .from("knowledge_chunks")
          .select("id, content, heading_path, page_number, version_id")
          .eq("workspace_id", auth.workspaceId)
          .eq("knowledge_item_id", itemId)
          .eq("id", chunkId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    listSpaces(auth),
  ]);
  const source = item.knowledge_sources as unknown as {
    source_type: KnowledgeSourceRow["source_type"];
    display_name: string;
  } | null;
  const current = (versions ?? []).find((v) => v.is_current) ?? versions?.[0];
  const download =
    source?.source_type === "upload" && current?.storage_path
      ? await signedDownloadUrl(auth.workspaceId, current.storage_path, item.title).catch(
          () => null,
        )
      : null;
  return {
    item: {
      id: item.id,
      title: item.title,
      status: item.status,
      statusDetail: item.status_detail,
      errorCode: item.error_code,
      sourceType: source?.source_type ?? "upload",
      sourceName: source?.display_name ?? "",
      url: item.source_url,
      downloadUrl: download,
      space: spaces.find((s) => s.id === item.space_id) ?? null,
      path: ((item.metadata as { path?: string[] } | null)?.path ?? []) as string[],
      updatedAt: item.updated_at,
    },
    versions: (versions ?? []).map((v) => ({
      id: v.id,
      number: v.version_number,
      status: v.status,
      isCurrent: v.is_current,
      createdAt: v.created_at,
    })),
    passage: chunk
      ? {
          content: chunk.content,
          section: chunk.heading_path.join(" › ") || null,
          page: chunk.page_number,
        }
      : null,
  };
}

// ── External sources ─────────────────────────────────────────────────────────

export interface KnowledgeAccount {
  connectionId: string;
  provider: "google" | "notion";
  name: string;
  account: string | null;
  /** Drive: granted and enabled. Notion connections always read. */
  ready: boolean;
}

export async function knowledgeAccounts(auth: AuthContext): Promise<KnowledgeAccount[]> {
  const [{ data: connections }, { data: caps }] = await Promise.all([
    auth.db
      .from("provider_connections")
      .select("id, provider_key, display_name, account_label, status")
      .eq("workspace_id", auth.workspaceId)
      .in("provider_key", ["google", "notion"])
      .eq("status", "connected"),
    auth.db
      .from("connection_capabilities")
      .select("connection_id, enabled, authorized_scopes")
      .eq("workspace_id", auth.workspaceId)
      .eq("capability_key", "knowledge"),
  ]);
  return (connections ?? []).map((c) => {
    const cap = (caps ?? []).find((k) => k.connection_id === c.id);
    return {
      connectionId: c.id,
      provider: c.provider_key as "google" | "notion",
      name: c.display_name,
      account: c.account_label,
      ready: Boolean(cap?.enabled && cap.authorized_scopes.length),
    };
  });
}

async function ownConnection(
  auth: AuthContext,
  connectionId: string,
  provider: "google" | "notion",
) {
  const account = (await knowledgeAccounts(auth)).find(
    (a) => a.connectionId === connectionId && a.provider === provider,
  );
  if (!account) throw new AppError("NOT_FOUND", "Account not found");
  if (!account.ready)
    throw new AppError("PERMISSION_DENIED", "ELISE isn't allowed to read this account yet", {
      recovery: "reconnect",
    });
  return account;
}

export async function browseDrive(auth: AuthContext, connectionId: string, folderId: string) {
  await ownConnection(auth, connectionId, "google");
  const drive = new GoogleDriveClient(googleHttpFor(auth, connectionId));
  const { folders, files } = await drive.browse(folderId);
  return {
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
  };
}

export async function searchNotion(auth: AuthContext, connectionId: string, query: string) {
  await ownConnection(auth, connectionId, "notion");
  const results = await notionClientFor(auth, connectionId).search(query.slice(0, 100));
  // Search returns one result per data source; Knowledge follows the database that holds it.
  const seen = new Set<string>();
  return results.flatMap((p) => {
    const database =
      p.object === "data_source"
        ? (p.parent?.database_id ?? null)
        : p.object === "database"
          ? p.id
          : null;
    const id = database ?? p.id;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: pageTitle(p), kind: database ? ("database" as const) : ("page" as const) }];
  });
}

const selectionSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      kind: z.enum(["folder", "file", "page", "database"]),
      name: z.string().trim().min(1).max(300),
    }),
  )
  .min(1)
  .max(50);

/** A Drive selection or Notion page tree becomes a source of a Space, then syncs at once. */
export async function addExternalSource(
  auth: AuthContext,
  input: {
    spaceId: string;
    connectionId: string;
    provider: "google" | "notion";
    selection: unknown;
  },
) {
  await ownSpace(auth, input.spaceId);
  const account = await ownConnection(auth, input.connectionId, input.provider);
  const selection = selectionSchema.parse(input.selection);
  const kinds = input.provider === "google" ? ["folder", "file"] : ["page", "database"];
  if (selection.some((s) => !kinds.includes(s.kind)))
    throw new AppError("VALIDATION_ERROR", "Invalid selection");
  const label =
    selection.length === 1 ? selection[0]!.name : `${selection[0]!.name} +${selection.length - 1}`;
  const { data, error } = await auth.db
    .from("knowledge_sources")
    .insert({
      workspace_id: auth.workspaceId,
      space_id: input.spaceId,
      provider_key: input.provider,
      connection_id: input.connectionId,
      source_type: input.provider === "google" ? "google_drive" : "notion",
      display_name: `${label} · ${account.name}`.slice(0, 200),
      configuration: json({ selection }),
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not add the source", { cause: error });
  await audit(auth, "knowledge.source_added", "knowledge_source", data.id, {
    provider: input.provider,
    roots: selection.length,
  });
  // The first sync starts now; if the runtime is unavailable, the scheduler retries it.
  await startSync(auth.workspaceId, data.id, "initial").catch((error: unknown) =>
    logger.warn("knowledge.initial_sync_deferred", { code: (error as { code?: string }).code }),
  );
  return data.id;
}

async function ownSource(auth: AuthContext, sourceId: string) {
  const { data } = await auth.db
    .from("knowledge_sources")
    .select("id, source_type, status, archived_at")
    .eq("id", sourceId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!data || data.archived_at) throw new AppError("NOT_FOUND", "Source not found");
  return data;
}

/** Sync Now: the same pipeline as the periodic sync. */
export async function syncNow(auth: AuthContext, sourceId: string) {
  const source = await ownSource(auth, sourceId);
  if (source.source_type === "upload") return null;
  const runId = await startSync(auth.workspaceId, sourceId, "manual");
  if (!runId)
    throw new AppError("CONFLICT", "This source is already syncing", { recovery: "review" });
  return runId;
}

/**
 * Removing a source (or disconnecting its account) stops sync at once and deletes what ELISE
 * indexed from it — documents, versions, passages and uploaded originals. The original data
 * in Drive or Notion is untouched.
 */
export async function removeSource(auth: AuthContext, sourceId: string) {
  await ownSource(auth, sourceId);
  await purgeSources(auth.workspaceId, [sourceId], "archived");
  await audit(auth, "knowledge.source_removed", "knowledge_source", sourceId);
}

export async function purgeSources(
  workspaceId: string,
  sourceIds: string[],
  status: "archived" | "disconnected",
) {
  if (!sourceIds.length) return;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  await admin
    .from("knowledge_sources")
    .update({ status, archived_at: now, next_sync_at: null })
    .in("id", sourceIds)
    .eq("workspace_id", workspaceId);
  const { data: items } = await admin
    .from("knowledge_items")
    .select("id")
    .in("source_id", sourceIds)
    .eq("workspace_id", workspaceId);
  const itemIds = (items ?? []).map((i) => i.id);
  if (itemIds.length) {
    const { data: versions } = await admin
      .from("knowledge_versions")
      .select("storage_path")
      .in("knowledge_item_id", itemIds)
      .eq("workspace_id", workspaceId);
    await admin.from("knowledge_items").delete().in("id", itemIds).eq("workspace_id", workspaceId);
    await removeOriginals(
      workspaceId,
      (versions ?? []).map((v) => v.storage_path).filter((p): p is string => Boolean(p)),
    );
  }
}

/** Disconnecting an account removes the Knowledge that came through it (see removeSource). */
export async function purgeConnectionKnowledge(workspaceId: string, connectionId: string) {
  const { data } = await createAdminClient()
    .from("knowledge_sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .is("archived_at", null);
  await purgeSources(
    workspaceId,
    (data ?? []).map((s) => s.id),
    "disconnected",
  );
}

export function knowledgeSetup() {
  return {
    // Development runs Knowledge work in-process without Trigger.dev (knowledge-background.ts).
    backgroundAvailable: isBackgroundConfigured() || serverEnv().ELISE_ENV !== "production",
    notionAvailable: isNotionConfigured(),
  };
}

/**
 * "Save this source to Knowledge" (ADR-015): only on the user's request. The page becomes a
 * Markdown document in the Space, with its URL and retrieval date, ingested like an upload.
 */
export async function saveWebPageToKnowledge(
  auth: AuthContext,
  spaceId: string,
  page: {
    url: string;
    title: string;
    domain: string;
    publishedAt: string | null;
    retrievedAt: string;
    text: string;
  },
): Promise<{ itemId: string }> {
  await ownSpace(auth, spaceId);
  const sourceId = await uploadSource(auth, spaceId);
  const admin = createAdminClient();
  const title = (page.title || page.domain).slice(0, 500);
  const markdown = [
    `# ${title}`,
    "",
    `Source: ${page.url}`,
    `Retrieved: ${page.retrievedAt.slice(0, 10)}${page.publishedAt ? ` · Published: ${page.publishedAt.slice(0, 10)}` : ""}`,
    "",
    page.text,
  ].join("\n");
  const bytes = new TextEncoder().encode(markdown);
  const { data: item, error } = await admin
    .from("knowledge_items")
    .insert({
      workspace_id: auth.workspaceId,
      space_id: spaceId,
      source_id: sourceId,
      item_type: "file",
      external_id: crypto.randomUUID(),
      title,
      source_url: page.url,
      mime_type: "text/markdown",
      metadata: json({
        web: {
          url: page.url,
          domain: page.domain,
          retrievedAt: page.retrievedAt,
          publishedAt: page.publishedAt,
        },
      }),
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the page", { cause: error });
  const target = await newUploadVersion(auth, item.id, 1, {
    name: `${page.domain}.md`,
    size: bytes.length,
    mimeType: "text/markdown",
  });
  await uploadOriginal(auth.workspaceId, target.path, bytes, "text/markdown");
  await completeUploads(auth, [target.versionId]);
  await audit(auth, "knowledge.web_saved", "knowledge_item", item.id, { domain: page.domain });
  return { itemId: item.id };
}
