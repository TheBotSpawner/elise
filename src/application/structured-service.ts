import "server-only";

import { z } from "zod";

import type {
  FieldMapping,
  SchemaProperty,
  StructuredRecord,
  StructuredSource,
} from "@/core/capabilities/structured";
import { AppError, toAppError } from "@/core/errors";
import { parseExternalRef } from "@/core/providers/refs";
import { confirmMapping, schemaFingerprint, suggestMappingWithAI } from "@/core/structured/mapping";
import { getAIProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import {
  dataSourceTitle,
  readRecord,
  toSchema,
} from "@/infrastructure/providers/notion/structured";
import {
  applySchema,
  NotionStructuredProvider,
} from "@/infrastructure/providers/notion/structured-provider";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json, StructuredSourceRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import { ownerContext, workspaceContext } from "./background";
import { notionStructuredApiFor } from "./elise";
import { startStructuredBulk, type BulkInput } from "./structured-bulk";
import { markResourceSurfaces } from "./workspace-service";

/**
 * Structured Notion setup and upkeep (ADR-011): discover the databases the user shared with
 * ELISE, inspect a schema, propose a mapping (rules + AI), preview real rows, save only what
 * the user confirmed. Records are never copied: ELISE keeps the mapping and reads Notion live.
 */

async function notionConnection(auth: AuthContext, connectionId: string) {
  const { data } = await auth.db
    .from("provider_connections")
    .select("id, display_name, status")
    .eq("id", connectionId)
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "notion")
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Notion connection not found");
  if (data.status !== "connected")
    throw new AppError("AUTH_EXPIRED", "Reconnect this Notion workspace first", {
      recovery: "reconnect",
    });
  return data;
}

export async function notionWorkspaces(auth: AuthContext) {
  const { data } = await auth.db
    .from("provider_connections")
    .select("id, display_name, account_label, status")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "notion")
    .neq("status", "disconnected")
    .order("created_at");
  return (data ?? []).map((c) => ({ connectionId: c.id, name: c.display_name, status: c.status }));
}

/** Databases (their data sources) this Notion connection can see — only what was shared. */
export async function discoverDatabases(auth: AuthContext, connectionId: string, query: string) {
  await notionConnection(auth, connectionId);
  const found = await notionStructuredApiFor(auth, connectionId).searchDataSources(
    query.slice(0, 100),
  );
  const { data: mapped } = await auth.db
    .from("structured_sources")
    .select("data_source_id, name")
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", connectionId)
    .is("archived_at", null);
  return found.map((ds) => ({
    dataSourceId: ds.id,
    databaseId: ds.parent?.database_id ?? ds.id,
    name: dataSourceTitle(ds),
    fields: Object.keys(ds.properties ?? {}).length,
    mappedAs: (mapped ?? []).find((m) => m.data_source_id === ds.id)?.name ?? null,
  }));
}

export interface Inspection {
  dataSourceId: string;
  databaseId: string;
  name: string;
  url: string | null;
  properties: SchemaProperty[];
  fields: FieldMapping[];
  fromAI: string[];
  sample: { title: string; values: StructuredRecord["values"] }[];
}

/** Schema + proposed mapping + a few real rows, for the user to review. Nothing is saved. */
export async function inspectDatabase(
  auth: AuthContext,
  connectionId: string,
  dataSourceId: string,
): Promise<Inspection> {
  await notionConnection(auth, connectionId);
  const api = notionStructuredApiFor(auth, connectionId);
  const ds = await api.dataSource(dataSourceId);
  const properties = toSchema(ds);
  const ai = (() => {
    try {
      return getAIProvider();
    } catch {
      return null;
    }
  })();
  const { fields, fromAI } = await suggestMappingWithAI(ai, properties);
  const rows = await api.query(dataSourceId, { page_size: 5 });
  logger.info("structured.inspected", {
    connection_id: connectionId,
    properties: properties.length,
    ai_fields: fromAI.length,
  });
  return {
    dataSourceId: ds.id,
    databaseId: ds.parent?.database_id ?? ds.id,
    name: dataSourceTitle(ds),
    url: ds.url ?? null,
    properties,
    fields,
    fromAI,
    sample: rows.results.filter((p) => !p.in_trash).map((p) => readRecord(p, fields)),
  };
}

export const mappingInput = z
  .object({
    connectionId: z.uuid(),
    dataSourceId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    context: z.string().trim().max(200).nullable().default(null),
    fields: z
      .array(
        z.object({
          propertyId: z.string().min(1).max(200),
          key: z.string().max(40),
          label: z.string().max(80),
          include: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
    permissions: z.object({ create: z.boolean(), update: z.boolean(), archive: z.boolean() }),
  })
  .strict();

/** Saves (or replaces) the mapping the user confirmed, checked against the live schema. */
export async function saveMapping(auth: AuthContext, raw: unknown, sourceId?: string) {
  const input = mappingInput.parse(raw);
  await notionConnection(auth, input.connectionId);
  const ds = await notionStructuredApiFor(auth, input.connectionId).dataSource(input.dataSourceId);
  const properties = toSchema(ds);
  let fields: FieldMapping[];
  try {
    fields = confirmMapping(input.fields, properties);
  } catch (error) {
    throw new AppError("VALIDATION_ERROR", (error as Error).message, { recovery: "review" });
  }
  const values = {
    workspace_id: auth.workspaceId,
    connection_id: input.connectionId,
    provider_key: "notion" as const,
    database_id: ds.parent?.database_id ?? ds.id,
    data_source_id: ds.id,
    name: input.name,
    context: input.context || null,
    schema_fingerprint: schemaFingerprint(properties),
    schema_snapshot: properties as unknown as Json,
    field_mappings: fields as unknown as Json,
    allow_read: true,
    allow_create: input.permissions.create,
    allow_update: input.permissions.update,
    allow_archive: input.permissions.archive,
    status: "active" as const,
    schema_issues: {} as Json,
    schema_checked_at: new Date().toISOString(),
    url: ds.url ?? null,
  };
  const q = sourceId
    ? auth.db
        .from("structured_sources")
        .update(values)
        .eq("id", sourceId)
        .eq("workspace_id", auth.workspaceId)
    : auth.db.from("structured_sources").insert({ ...values, created_by_user_id: auth.userId });
  const { data, error } = await q.select("id").single();
  if (error) {
    throw new AppError(
      error.code === "23505" ? "CONFLICT" : "INTERNAL_ERROR",
      error.code === "23505"
        ? "That database (or name) is already mapped"
        : "Could not save the mapping",
      { cause: error, recovery: "review" },
    );
  }
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: sourceId ? "structured.mapping_updated" : "structured.source_mapped",
    resource_type: "structured_source",
    resource_id: data.id,
    provider_key: "notion",
    connection_id: input.connectionId,
    origin: "user_ui",
    result: "success",
    metadata: { fields: fields.length, permissions: input.permissions },
  });
  return data.id;
}

async function ownSource(auth: AuthContext, id: string) {
  const { data } = await auth.db
    .from("structured_sources")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Source not found");
  return data;
}

export interface SourceView {
  id: string;
  name: string;
  context: string | null;
  account: string;
  connectionId: string | null;
  connectionStatus: string;
  status: StructuredSourceRow["status"];
  fields: FieldMapping[];
  permissions: { read: boolean; create: boolean; update: boolean; archive: boolean };
  issues: {
    renamed?: { key: string; from: string; to: string }[];
    removed?: string[];
    typeChanged?: string[];
    added?: string[];
  };
  checkedAt: string | null;
  url: string | null;
  dataSourceId: string;
}

export async function listStructuredSources(auth: AuthContext): Promise<SourceView[]> {
  const [{ data }, { data: conns }] = await Promise.all([
    auth.db
      .from("structured_sources")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null)
      .order("name"),
    auth.db
      .from("provider_connections")
      .select("id, display_name, status")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "notion"),
  ]);
  return (data ?? []).map((r) => {
    const conn = (conns ?? []).find((c) => c.id === r.connection_id);
    return {
      id: r.id,
      name: r.name,
      context: r.context,
      account: conn?.display_name ?? "Notion",
      connectionId: r.connection_id,
      connectionStatus: conn?.status ?? "disconnected",
      status: r.status,
      fields: r.field_mappings as unknown as FieldMapping[],
      permissions: {
        read: r.allow_read,
        create: r.allow_create,
        update: r.allow_update,
        archive: r.allow_archive,
      },
      issues: (r.schema_issues ?? {}) as SourceView["issues"],
      checkedAt: r.schema_checked_at,
      url: r.url,
      dataSourceId: r.data_source_id,
    };
  });
}

export async function getStructuredSource(auth: AuthContext, id: string) {
  const all = await listStructuredSources(auth);
  const source = all.find((s) => s.id === id);
  if (!source) throw new AppError("NOT_FOUND", "Source not found");
  return source;
}

/** Checks the live schema now: follows renames, marks removed/retyped fields. */
export async function refreshSchema(auth: AuthContext, id: string) {
  const row = await ownSource(auth, id);
  if (!row.connection_id)
    throw new AppError("AUTH_EXPIRED", "Reconnect Notion first", { recovery: "reconnect" });
  const ds = await notionStructuredApiFor(auth, row.connection_id).dataSource(row.data_source_id);
  const next = applySchema(row, toSchema(ds));
  await auth.db
    .from("structured_sources")
    .update({
      field_mappings: next.field_mappings,
      schema_snapshot: next.schema_snapshot,
      schema_fingerprint: next.schema_fingerprint,
      schema_issues: next.schema_issues,
      status: next.status,
      schema_checked_at: next.schema_checked_at,
    })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  return next.schema_issues;
}

/** A live read of three records through the saved mapping. */
export async function testSource(auth: AuthContext, id: string) {
  const row = await ownSource(auth, id);
  if (!row.connection_id)
    throw new AppError("AUTH_EXPIRED", "Reconnect Notion first", { recovery: "reconnect" });
  const provider = new NotionStructuredProvider(
    auth.db,
    auth.workspaceId,
    row.connection_id,
    "Notion",
    notionStructuredApiFor(auth, row.connection_id),
    async () => undefined,
  );
  const [source] = await provider.findSources(`x:${row.connection_id}:source:${row.id}`);
  if (!source) throw new AppError("NOT_FOUND", "Source not found");
  const page = await provider.query(source, {
    filters: [],
    sort: [{ field: "last_edited", direction: "desc" }],
    limit: 3,
  });
  return page.records.map((r) => ({ title: r.title, values: r.values, url: r.url }));
}

export async function updatePermissions(
  auth: AuthContext,
  id: string,
  patch: {
    create?: boolean;
    update?: boolean;
    archive?: boolean;
    context?: string | null;
    name?: string;
  },
) {
  await ownSource(auth, id);
  const { error } = await auth.db
    .from("structured_sources")
    .update({
      ...(patch.create !== undefined ? { allow_create: patch.create } : {}),
      ...(patch.update !== undefined ? { allow_update: patch.update } : {}),
      ...(patch.archive !== undefined ? { allow_archive: patch.archive } : {}),
      ...(patch.context !== undefined
        ? { context: patch.context?.trim().slice(0, 200) || null }
        : {}),
      ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 120) } : {}),
    })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  if (error)
    throw new AppError("VALIDATION_ERROR", "Could not update the source", { cause: error });
}

/** Stops using a database in ELISE. Nothing changes in Notion. */
export async function unmapSource(auth: AuthContext, id: string) {
  await ownSource(auth, id);
  await auth.db
    .from("structured_sources")
    .update({ status: "archived", archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: "structured.source_unmapped",
    resource_type: "structured_source",
    resource_id: id,
    origin: "user_ui",
    result: "success",
    metadata: {},
  });
}

/** For Chat: the mapped sources by name, id, context and field keys (no records, no content). */
export async function structuredSourcesForChat(auth: AuthContext) {
  const sources = await listStructuredSources(auth).catch(() => []);
  return sources
    .filter((s) => s.status !== "archived" && s.connectionId && s.connectionStatus === "connected")
    .map((s) => ({
      id: `x:${s.connectionId}:source:${s.id}`,
      name: s.name,
      account: s.account,
      context: s.context,
      fields: s.fields.filter((f) => !f.broken).map((f) => f.key),
      needsAttention: s.status === "needs_attention",
    }));
}

// ── Background ───────────────────────────────────────────────────────────────

/**
 * Runs an approved bulk change: exactly the approved record ids, one by one within Notion's
 * rate limit, with progress on the job row. A record that fails is counted, not retried blindly.
 */
export async function runStructuredBulk(workspaceId: string, jobId: string) {
  const db = createAdminClient();
  const { data: job } = await db
    .from("background_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("workspace_id", workspaceId)
    .eq("job_type", "structured.bulk")
    .maybeSingle();
  if (!job || !job.user_id || job.status === "completed") return null;
  const input = job.input as unknown as BulkInput;
  const ref = parseExternalRef(input.sourceId);
  if (!ref) throw new AppError("VALIDATION_ERROR", "Invalid source");
  const auth = await ownerContext(workspaceId, job.user_id);
  const { data: grant } = await db
    .from("connection_capabilities")
    .select("enabled")
    .eq("connection_id", ref.connectionId)
    .eq("capability_key", "structured")
    .maybeSingle();
  if (!grant?.enabled)
    throw new AppError("PERMISSION_DENIED", "Structured Data is off for this Notion workspace");
  const provider = new NotionStructuredProvider(
    db,
    workspaceId,
    ref.connectionId,
    "Notion",
    notionStructuredApiFor(auth, ref.connectionId),
    async () => {
      throw new AppError("INTERNAL_ERROR", "Nested bulk");
    },
  );
  const [source] = await provider.findSources(input.sourceId);
  if (!source) throw new AppError("NOT_FOUND", "The source is no longer mapped");
  await db
    .from("background_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);
  let done = 0;
  let failed = 0;
  for (const recordRef of input.recordRefs) {
    try {
      if (input.change.archive) await provider.archiveRecord(source, recordRef);
      else await provider.updateRecord(source, recordRef, input.change.values ?? {});
      done++;
    } catch (error) {
      failed++;
      logger.warn("structured.bulk_record_failed", { job_id: jobId, code: toAppError(error).code });
    }
    if ((done + failed) % 10 === 0)
      await db
        .from("background_jobs")
        .update({ progress_current: done + failed })
        .eq("id", jobId);
    await new Promise((r) => setTimeout(r, 350));
  }
  const now = new Date().toISOString();
  await db
    .from("background_jobs")
    .update({
      status: failed ? "completed_with_warning" : "completed",
      progress_current: done + failed,
      completed_at: now,
      result_reference: { done, failed } as Json,
    })
    .eq("id", jobId);
  await db.from("notifications").insert({
    workspace_id: workspaceId,
    user_id: job.user_id,
    notification_type: "structured.bulk_done",
    title: failed
      ? `${source.name}: ${done} changed, ${failed} couldn't be changed`
      : `${source.name}: ${done} records changed`,
    priority: "normal",
    source_type: "structured_source",
    source_id: ref.parts[1]!,
    action_url: "/connections",
  });
  await db.from("audit_events").insert({
    workspace_id: workspaceId,
    user_id: job.user_id,
    event_type: "structured.bulk.completed",
    resource_type: "structured_source",
    resource_id: ref.parts[1]!,
    action_id: input.actionId,
    origin: "system",
    result: failed ? "failure" : "success",
    metadata: { done, failed, total: input.recordRefs.length },
  });
  logger.info("structured.bulk_completed", { job_id: jobId, done, failed });
  // The Live Workspace that asked for it shows the result (Realtime updates open browsers).
  const { data: approval } = input.actionId
    ? await db
        .from("approvals")
        .select("id")
        .eq("action_id", input.actionId)
        .eq("workspace_id", workspaceId)
        .maybeSingle()
    : { data: null };
  if (approval)
    await markResourceSurfaces(workspaceId, "approval", approval.id, (s) => ({
      state: failed && !done ? "error" : "ready",
      payload: { ...(s.payload as object), background: failed && !done ? "failed" : "done" },
    })).catch((error) =>
      logger.warn("workspace.background_update_failed", { code: toAppError(error).code }),
    );
  return { done, failed };
}

/** Hourly: re-check mapped schemas so renamed/removed fields surface before the next request. */
export async function dispatchSchemaChecks(): Promise<{ checked: number }> {
  const db = createAdminClient();
  const { data } = await db
    .from("structured_sources")
    .select("*")
    .is("archived_at", null)
    .neq("status", "paused")
    .lt("schema_checked_at", new Date(Date.now() - 60 * 60_000).toISOString())
    .limit(50);
  let checked = 0;
  for (const row of data ?? []) {
    if (!row.connection_id) continue;
    try {
      const auth = await workspaceContext(row.workspace_id);
      const ds = await notionStructuredApiFor(auth, row.connection_id).dataSource(
        row.data_source_id,
      );
      const next = applySchema(row, toSchema(ds));
      await db
        .from("structured_sources")
        .update({
          field_mappings: next.field_mappings,
          schema_snapshot: next.schema_snapshot,
          schema_fingerprint: next.schema_fingerprint,
          schema_issues: next.schema_issues,
          status: next.status,
          schema_checked_at: next.schema_checked_at,
        })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id);
      checked++;
    } catch (error) {
      logger.warn("structured.schema_check_failed", {
        source_id: row.id,
        code: toAppError(error).code,
      });
    }
  }
  return { checked };
}

export { startStructuredBulk };
export type { StructuredSource };
