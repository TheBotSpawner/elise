import type { SupabaseClient } from "@supabase/supabase-js";

import { AppError } from "@/core/errors";
import type {
  CurrentVersion,
  IndexedChunk,
  IngestionStore,
  VersionToIngest,
} from "@/core/knowledge/ingest";
import type { KnowledgeSourceType } from "@/core/knowledge/model";
import type {
  ExternalItem,
  KnownItem,
  SyncCounts,
  SyncRun,
  SyncSource,
  SyncStore,
} from "@/core/knowledge/sync";

import type { Database, Json } from "../database.types";
import { toVector } from "./knowledge";

type Db = SupabaseClient<Database>;

/** Extracted text of older versions is kept for this many versions (history + compare). */
export const VERSIONS_WITH_TEXT = 5;
const INSERT_BATCH = 50;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

function check(error: { message: string } | null, what: string) {
  if (error) throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

/**
 * Background writes for Knowledge (service role: there is no user session in the runtime).
 * Every statement is scoped by workspace_id; ids come from the payload and are re-checked here.
 */
export class SupabaseKnowledgeStore implements IngestionStore, SyncStore {
  constructor(private readonly db: Db) {}

  // ── Ingestion ──────────────────────────────────────────────────────────────

  async loadVersion(workspaceId: string, versionId: string): Promise<VersionToIngest | null> {
    const { data } = await this.db
      .from("knowledge_versions")
      .select(
        "id, version_number, status, storage_path, mime_type, knowledge_items!knowledge_versions_knowledge_item_id_fkey(id, space_id, source_id, title, item_type, external_id, mime_type, knowledge_sources(source_type, connection_id))",
      )
      .eq("id", versionId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const item = data?.knowledge_items as unknown as {
      id: string;
      space_id: string;
      source_id: string;
      title: string;
      item_type: VersionToIngest["itemType"];
      external_id: string;
      mime_type: string | null;
      knowledge_sources: { source_type: KnowledgeSourceType; connection_id: string | null } | null;
    } | null;
    if (!data || !item) return null;
    return {
      versionId: data.id,
      itemId: item.id,
      workspaceId,
      spaceId: item.space_id,
      sourceId: item.source_id,
      versionNumber: data.version_number,
      title: item.title,
      sourceType: item.knowledge_sources?.source_type ?? "upload",
      itemType: item.item_type,
      externalId: item.external_id,
      connectionId: item.knowledge_sources?.connection_id ?? null,
      storagePath: data.storage_path,
      mimeType: data.mime_type ?? item.mime_type,
      status: data.status,
    };
  }

  async currentVersion(itemId: string): Promise<CurrentVersion | null> {
    const { data } = await this.db
      .from("knowledge_versions")
      .select("id, content_hash, chunking_version, embedding_model")
      .eq("knowledge_item_id", itemId)
      .eq("is_current", true)
      .maybeSingle();
    return data
      ? {
          id: data.id,
          contentHash: data.content_hash,
          chunkingVersion: data.chunking_version,
          embeddingModel: data.embedding_model,
        }
      : null;
  }

  private async hasCurrent(itemId: string) {
    return (await this.currentVersion(itemId)) !== null;
  }

  async markProcessing(v: VersionToIngest, detail: "reading" | "indexing") {
    await this.db
      .from("knowledge_versions")
      .update({ status: "processing" })
      .eq("id", v.versionId)
      .eq("workspace_id", v.workspaceId);
    // An item that is already searchable stays "ready" while its update is processed.
    const current = await this.hasCurrent(v.itemId);
    await this.db
      .from("knowledge_items")
      .update({ ...(current ? {} : { status: "processing" as const }), status_detail: detail })
      .eq("id", v.itemId)
      .eq("workspace_id", v.workspaceId);
  }

  async markUnchanged(v: VersionToIngest, hash: string) {
    await this.db
      .from("knowledge_versions")
      .update({
        status: "unchanged",
        content_hash: hash,
        processed_at: new Date().toISOString(),
        extracted_text: null,
      })
      .eq("id", v.versionId)
      .eq("workspace_id", v.workspaceId);
    await this.db
      .from("knowledge_items")
      .update({
        status: "ready",
        status_detail: null,
        error_code: null,
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", v.itemId)
      .eq("workspace_id", v.workspaceId);
  }

  async activate(v: VersionToIngest, r: Parameters<IngestionStore["activate"]>[1]): Promise<void> {
    const ws = v.workspaceId;
    // Re-running (retry/reindex) replaces this version's chunks instead of duplicating them.
    check(
      (
        await this.db
          .from("knowledge_chunks")
          .delete()
          .eq("version_id", v.versionId)
          .eq("workspace_id", ws)
      ).error,
      "reset chunks",
    );
    for (let i = 0; i < r.chunks.length; i += INSERT_BATCH) {
      const rows = r.chunks.slice(i, i + INSERT_BATCH).map((c: IndexedChunk) => ({
        workspace_id: ws,
        space_id: v.spaceId,
        source_id: v.sourceId,
        knowledge_item_id: v.itemId,
        version_id: v.versionId,
        chunk_index: c.index,
        content: c.content,
        heading_path: c.headingPath,
        page_number: c.page,
        token_count: c.tokenCount,
        embedding: toVector(c.embedding),
        embedding_model: r.embeddingModel,
      }));
      check((await this.db.from("knowledge_chunks").insert(rows)).error, "store chunks");
    }

    // ponytail: not one transaction (PostgREST); each step is idempotent, so a retry converges.
    const { data: previous } = await this.db
      .from("knowledge_versions")
      .select("id")
      .eq("knowledge_item_id", v.itemId)
      .eq("is_current", true)
      .neq("id", v.versionId);
    const previousIds = (previous ?? []).map((p) => p.id);
    if (previousIds.length) {
      await this.db
        .from("knowledge_versions")
        .update({ is_current: false, status: "superseded" })
        .in("id", previousIds)
        .eq("workspace_id", ws);
      // Only the current version is searchable; older ones keep their text for comparison.
      await this.db
        .from("knowledge_chunks")
        .delete()
        .in("version_id", previousIds)
        .eq("workspace_id", ws);
    }
    check(
      (
        await this.db
          .from("knowledge_versions")
          .update({
            status: "ready",
            is_current: true,
            extracted_text: r.text,
            content_hash: r.hash,
            parser_version: r.parserVersion,
            chunking_version: r.chunkingVersion,
            embedding_model: r.embeddingModel,
            chunk_count: r.chunks.length,
            processed_at: new Date().toISOString(),
            error_code: null,
            ...(r.sourceRevision ? { source_revision: r.sourceRevision } : {}),
          })
          .eq("id", v.versionId)
          .eq("workspace_id", ws)
      ).error,
      "activate version",
    );
    check(
      (
        await this.db
          .from("knowledge_items")
          .update({
            current_version_id: v.versionId,
            status: "ready",
            status_detail: null,
            error_code: null,
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", v.itemId)
          .eq("workspace_id", ws)
      ).error,
      "update item",
    );
    // Retention: text of the latest versions only.
    await this.db
      .from("knowledge_versions")
      .update({ extracted_text: null })
      .eq("knowledge_item_id", v.itemId)
      .eq("workspace_id", ws)
      .lte("version_number", v.versionNumber - VERSIONS_WITH_TEXT);
  }

  async markFailed(
    v: VersionToIngest,
    f: { status: "needs_attention" | "failed"; code: string; detail: string },
  ) {
    await this.db
      .from("knowledge_versions")
      .update({ status: "failed", error_code: f.code, processed_at: new Date().toISOString() })
      .eq("id", v.versionId)
      .eq("workspace_id", v.workspaceId);
    // A failed update keeps the previous version searchable, flagged; a first version fails visibly.
    const current = await this.hasCurrent(v.itemId);
    await this.db
      .from("knowledge_items")
      .update({
        ...(current ? { status: "ready" as const } : { status: f.status }),
        status_detail: f.detail.slice(0, 300),
        error_code: f.code,
      })
      .eq("id", v.itemId)
      .eq("workspace_id", v.workspaceId);
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  async loadRun(workspaceId: string, runId: string) {
    const { data: run } = await this.db
      .from("knowledge_sync_runs")
      .select("id, workspace_id, source_id, status")
      .eq("id", runId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!run) return null;
    const { data: source } = await this.db
      .from("knowledge_sources")
      .select(
        "id, workspace_id, space_id, source_type, connection_id, configuration, status, archived_at",
      )
      .eq("id", run.source_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!source || source.archived_at || source.status === "disconnected") return null;
    return {
      run: {
        id: run.id,
        workspaceId: run.workspace_id,
        sourceId: run.source_id,
        status: run.status,
      } satisfies SyncRun,
      source: {
        id: source.id,
        workspaceId: source.workspace_id,
        spaceId: source.space_id,
        sourceType: source.source_type,
        connectionId: source.connection_id,
        configuration: source.configuration,
      } satisfies SyncSource,
    };
  }

  async markRunning(run: SyncRun) {
    await this.db
      .from("knowledge_sync_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("workspace_id", run.workspaceId);
    await this.db
      .from("knowledge_sources")
      .update({ status: "syncing" })
      .eq("id", run.sourceId)
      .eq("workspace_id", run.workspaceId);
  }

  async knownItems(sourceId: string): Promise<KnownItem[]> {
    const { data, error } = await this.db
      .from("knowledge_items")
      .select(
        "id, external_id, status, knowledge_versions!knowledge_versions_knowledge_item_id_fkey(version_number, source_revision)",
      )
      .eq("source_id", sourceId);
    check(error, "load items");
    return (data ?? []).map((i) => {
      const versions = (i.knowledge_versions ?? []) as unknown as {
        version_number: number;
        source_revision: string | null;
      }[];
      const newest = versions.sort((a, b) => b.version_number - a.version_number)[0];
      return {
        id: i.id,
        externalId: i.external_id,
        status: i.status,
        revision: newest?.source_revision ?? null,
      };
    });
  }

  async createItem(source: SyncSource, item: ExternalItem) {
    const { data, error } = await this.db
      .from("knowledge_items")
      .insert({
        workspace_id: source.workspaceId,
        space_id: source.spaceId,
        source_id: source.id,
        item_type: item.itemType,
        external_id: item.externalId,
        title: item.title.slice(0, 500) || "Untitled",
        source_url: item.url,
        mime_type: item.mimeType,
        external_modified_at: item.modifiedAt,
        metadata: json({ path: item.path }),
      })
      .select("id")
      .single();
    check(error, "create item");
    return this.newVersion(source.workspaceId, data!.id, 1, item);
  }

  private async newVersion(
    workspaceId: string,
    itemId: string,
    number: number,
    item: ExternalItem,
  ) {
    const { data, error } = await this.db
      .from("knowledge_versions")
      .insert({
        workspace_id: workspaceId,
        knowledge_item_id: itemId,
        version_number: number,
        source_revision: item.revision,
        mime_type: item.mimeType,
      })
      .select("id")
      .single();
    check(error, "create version");
    return { versionId: data!.id };
  }

  async addVersion(source: SyncSource, itemId: string, item: ExternalItem) {
    const { data: last } = await this.db
      .from("knowledge_versions")
      .select("version_number")
      .eq("knowledge_item_id", itemId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const current = await this.hasCurrent(itemId);
    await this.db
      .from("knowledge_items")
      .update({
        title: item.title.slice(0, 500) || "Untitled",
        source_url: item.url,
        mime_type: item.mimeType,
        external_modified_at: item.modifiedAt,
        metadata: json({ path: item.path }),
        // A removed item that came back is searchable again once re-indexed.
        status: current ? "ready" : "queued",
        archived_at: null,
      })
      .eq("id", itemId)
      .eq("workspace_id", source.workspaceId);
    return this.newVersion(source.workspaceId, itemId, (last?.version_number ?? 0) + 1, item);
  }

  async markRemoved(source: SyncSource, itemIds: string[]) {
    // Removed items leave search immediately; their versions stay as history.
    await this.db
      .from("knowledge_items")
      .update({ status: "removed", status_detail: null })
      .in("id", itemIds)
      .eq("workspace_id", source.workspaceId);
  }

  async finish(
    run: SyncRun,
    source: SyncSource,
    r: Parameters<SyncStore["finish"]>[2],
  ): Promise<void> {
    const c: SyncCounts = r.counts;
    await this.db
      .from("knowledge_sync_runs")
      .update({
        status: r.status,
        completed_at: new Date().toISOString(),
        items_discovered: c.discovered,
        items_created: c.created,
        items_updated: c.updated,
        items_removed: c.removed,
        items_failed: c.failed,
        error_code: r.errorCode,
      })
      .eq("id", run.id)
      .eq("workspace_id", run.workspaceId);
    await this.db
      .from("knowledge_sources")
      .update({
        status: r.sourceStatus,
        last_error_code: r.errorCode,
        next_sync_at: r.nextSyncAt.toISOString(),
        ...(r.status !== "failed" ? { last_synced_at: new Date().toISOString() } : {}),
      })
      .eq("id", source.id)
      .eq("workspace_id", source.workspaceId);
  }

  // ── Scheduling syncs ───────────────────────────────────────────────────────

  /** External sources due for their periodic sync. */
  async dueSources(now: Date, limit: number) {
    const { data } = await this.db
      .from("knowledge_sources")
      .select("id, workspace_id")
      .in("source_type", ["google_drive", "notion"])
      .in("status", ["idle", "ready", "needs_attention"])
      .is("archived_at", null)
      .lte("next_sync_at", now.toISOString())
      .limit(limit);
    return data ?? [];
  }

  /** One sync at a time per source (unique index): returns null when one is already active. */
  async createSyncRun(
    workspaceId: string,
    sourceId: string,
    trigger: "scheduled" | "manual" | "initial",
  ) {
    const { data, error } = await this.db
      .from("knowledge_sync_runs")
      .insert({ workspace_id: workspaceId, source_id: sourceId, trigger })
      .select("id")
      .single();
    if (error?.code === "23505") return null;
    check(error, "start sync");
    return data!.id;
  }

  async setRunRuntime(workspaceId: string, runId: string, runtimeJobId: string) {
    await this.db
      .from("knowledge_sync_runs")
      .update({ runtime_job_id: runtimeJobId })
      .eq("id", runId)
      .eq("workspace_id", workspaceId);
  }

  async failRun(workspaceId: string, runId: string, code: string) {
    await this.db
      .from("knowledge_sync_runs")
      .update({ status: "failed", error_code: code, completed_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("workspace_id", workspaceId);
  }

  /** Runs the runtime never started or lost must not block a source forever. */
  async expireStaleSyncs(before: Date) {
    await this.db
      .from("knowledge_sync_runs")
      .update({ status: "failed", error_code: "TIMEOUT", completed_at: new Date().toISOString() })
      .in("status", ["queued", "running"])
      .lt("created_at", before.toISOString());
  }

  async setVersionRuntime(workspaceId: string, versionId: string, runtimeJobId: string) {
    await this.db
      .from("knowledge_versions")
      .update({ runtime_job_id: runtimeJobId })
      .eq("id", versionId)
      .eq("workspace_id", workspaceId);
  }

  /** Current versions indexed with another chunking version or embedding model (reindex). */
  async staleVersions(
    workspaceId: string | null,
    chunkingVersion: string,
    embeddingModel: string,
    limit: number,
  ) {
    let q = this.db
      .from("knowledge_versions")
      .select("id, workspace_id")
      .eq("is_current", true)
      .or(`chunking_version.neq.${chunkingVersion},embedding_model.neq.${embeddingModel}`)
      .limit(limit);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data } = await q;
    return data ?? [];
  }
}
