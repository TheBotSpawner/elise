import type { SupabaseClient } from "@supabase/supabase-js";

import { AppError } from "@/core/errors";
import type {
  CurrentVersion,
  IndexedChunk,
  IngestionStore,
  IngestPhase,
  VersionToIngest,
} from "@/core/knowledge/ingest";
import type { KnowledgeSourceType } from "@/core/knowledge/model";
import { retryDelayMinutes, SOURCE_LIFECYCLE } from "@/core/knowledge/source-state";
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

  // â”€â”€ Ingestion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  async markProcessing(v: VersionToIngest, detail: IngestPhase) {
    await this.db
      .from("knowledge_versions")
      .update({ status: "processing" })
      .eq("id", v.versionId)
      .eq("workspace_id", v.workspaceId);
    await this.beat("knowledge_versions", v.workspaceId, v.versionId);
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

  // â”€â”€ Sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

  /**
   * A worker's sign of life (ADR-036). Its own statement, so a database without the column yet
   * (migration 029 not applied) only loses the heartbeat, never the work.
   */
  private async beat(table: "knowledge_versions" | "knowledge_sync_runs", ws: string, id: string) {
    await this.db
      .from(table)
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", ws);
  }

  async heartbeat(run: SyncRun) {
    await this.beat("knowledge_sync_runs", run.workspaceId, run.id);
  }

  async markRunning(run: SyncRun) {
    await this.db
      .from("knowledge_sync_runs")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("workspace_id", run.workspaceId);
    await this.heartbeat(run);
    await this.db
      .from("knowledge_sources")
      .update({ status: "syncing" })
      .eq("id", run.sourceId)
      .eq("workspace_id", run.workspaceId);
  }

  async knownItems(sourceId: string): Promise<KnownItem[]> {
    const { data, error } = await this.db
      .from("knowledge_items")
      .select("id, external_id, status, error_code, metadata")
      .eq("source_id", sourceId);
    check(error, "load items");
    return (data ?? []).map((i) => ({
      id: i.id,
      externalId: i.external_id,
      status: i.status,
      // The catalog's revision; entries from before ADR-046 have none and are refreshed once.
      revision: (i.metadata as { revision?: string } | null)?.revision ?? null,
      errorCode: i.error_code,
    }));
  }

  /** Catalog metadata of an external entry (ADR-046): never its content. */
  private static catalogFields(item: ExternalItem) {
    return {
      item_type: item.itemType,
      title: item.title.slice(0, 500) || "Untitled",
      source_url: item.url,
      mime_type: item.mimeType,
      external_modified_at: item.modifiedAt,
      metadata: json({ path: item.path, revision: item.revision }),
      status: "ready" as const,
      status_detail: null,
      error_code: null,
      archived_at: null,
    };
  }

  async catalogItem(source: SyncSource, item: ExternalItem) {
    const { error } = await this.db.from("knowledge_items").insert({
      workspace_id: source.workspaceId,
      space_id: source.spaceId,
      source_id: source.id,
      external_id: item.externalId,
      ...SupabaseKnowledgeStore.catalogFields(item),
    });
    check(error, "add catalog entry");
  }

  async updateCatalogItem(source: SyncSource, itemId: string, item: ExternalItem) {
    const { error } = await this.db
      .from("knowledge_items")
      .update(SupabaseKnowledgeStore.catalogFields(item))
      .eq("id", itemId)
      .eq("workspace_id", source.workspaceId);
    check(error, "update catalog entry");
  }

  /**
   * The catalog entry of a resource live search just read (opportunistic catalog refresh):
   * found or added by (source, external id), so every citation has a stable item to point at.
   */
  async ensureCatalogItem(source: SyncSource, item: ExternalItem): Promise<string> {
    const find = () =>
      this.db
        .from("knowledge_items")
        .select("id, metadata, status")
        .eq("workspace_id", source.workspaceId)
        .eq("source_id", source.id)
        .eq("external_id", item.externalId)
        .limit(1)
        .maybeSingle();
    const { data } = await find();
    if (data) {
      const revision = (data.metadata as { revision?: string } | null)?.revision;
      if (revision !== item.revision || data.status !== "ready")
        await this.updateCatalogItem(source, data.id, item);
      return data.id;
    }
    await this.catalogItem(source, item).catch(() => undefined);
    const again = await find();
    if (!again.data) throw new AppError("INTERNAL_ERROR", "Could not record the catalog entry");
    return again.data.id;
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
    const configuration = r.catalog
      ? json({
          ...((source.configuration as Record<string, unknown> | null) ?? {}),
          catalog: { ...r.catalog, refreshedAt: new Date().toISOString() },
        })
      : undefined;
    await this.db
      .from("knowledge_sources")
      .update({
        status: r.sourceStatus,
        last_error_code: r.errorCode,
        next_sync_at: r.nextSyncAt.toISOString(),
        ...(r.status !== "failed" ? { last_synced_at: new Date().toISOString() } : {}),
        ...(configuration ? { configuration } : {}),
      })
      .eq("id", source.id)
      .eq("workspace_id", source.workspaceId);
  }

  // â”€â”€ Scheduling syncs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** External sources due for their periodic sync. */
  async dueSources(now: Date, limit: number) {
    const { data } = await this.db
      .from("knowledge_sources")
      .select("id, workspace_id, space_id")
      .in("source_type", ["google_drive", "notion"])
      .in("status", ["idle", "ready", "needs_attention"])
      .is("archived_at", null)
      // Never synced (the first sync couldn't start) is due too: no source waits forever.
      .or(`next_sync_at.is.null,next_sync_at.lte.${now.toISOString()}`)
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

  /**
   * The watchdog (ADR-036). Work the runtime never started or never finished must not block a
   * source (or keep it "preparing") forever:
   *   - a sync queued past `queuedStallMinutes` never started (BACKGROUND_STALLED);
   *   - a started sync whose heartbeat stopped, or past its lease, died (TIMEOUT);
   *   - a document being processed whose heartbeat stopped, or past its lease, died;
   *   - a queued document never started while nothing in the workspace moved: the runtime
   *     isn't executing jobs. A long queue that is moving is left alone.
   * Closed syncs put their source in "needs attention" with its next automatic retry backed
   * off; a document keeps its last good version if it had one. Idempotent: every update is
   * guarded by the state it leaves. Returns what it closed.
   */
  async recoverStale(now: Date, workspaceId: string | null) {
    const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const at = now.toISOString();
    const L = SOURCE_LIFECYCLE;
    const inWorkspace = <T extends { eq: (c: string, v: string) => T }>(q: T) =>
      workspaceId ? q.eq("workspace_id", workspaceId) : q;

    // â”€â”€ Syncs â”€â”€
    const runs = () =>
      inWorkspace(
        this.db
          .from("knowledge_sync_runs")
          .update({ status: "failed", completed_at: at, error_code: "TIMEOUT" }),
      );
    const stalledRuns = [
      ...((
        await inWorkspace(
          this.db
            .from("knowledge_sync_runs")
            .update({ status: "failed", completed_at: at, error_code: "BACKGROUND_STALLED" }),
        )
          .eq("status", "queued")
          .lt("created_at", ago(L.queuedStallMinutes))
          .select("source_id, workspace_id, runtime_job_id, error_code")
      ).data ?? []),
      // Heartbeat stopped (needs migration 029; without it this finds nothing)â€¦
      ...((
        await runs()
          .eq("status", "running")
          .lt("heartbeat_at", ago(L.heartbeatStallMinutes))
          .select("source_id, workspace_id, runtime_job_id, error_code")
      ).data ?? []),
      // â€¦or past the lease, whatever the heartbeat says (a task is capped at 10 minutes).
      ...((
        await runs()
          .eq("status", "running")
          .lt("started_at", ago(L.runningStallMinutes))
          .select("source_id, workspace_id, runtime_job_id, error_code")
      ).data ?? []),
    ];
    for (const r of stalledRuns)
      await this.scheduleRetry(r.workspace_id, r.source_id, r.error_code ?? "TIMEOUT", now);

    // â”€â”€ Documents â”€â”€
    const versions = () =>
      inWorkspace(
        this.db
          .from("knowledge_versions")
          .update({ status: "failed", error_code: "BACKGROUND_STALLED", processed_at: at }),
      );
    const cols = "knowledge_item_id, workspace_id, runtime_job_id";
    const died = [
      ...((
        await versions()
          .eq("status", "processing")
          .lt("heartbeat_at", ago(L.heartbeatStallMinutes))
          .select(cols)
      ).data ?? []),
      ...((
        await versions()
          .eq("status", "processing")
          .lt("created_at", ago(L.ingestStallMinutes))
          .or(`processed_at.is.null,processed_at.lt.${ago(L.ingestStallMinutes)}`)
          .select(cols)
      ).data ?? []),
    ];
    // Queued documents: failed by age only when the runtime shows no life in the window.
    const { data: alive, error: noHeartbeats } = await inWorkspace(
      this.db.from("knowledge_versions").select("id"),
    )
      .gt("heartbeat_at", ago(L.ingestNotStartedMinutes))
      .limit(1);
    const queuedLimit = noHeartbeats
      ? L.ingestStallMinutes // before migration 029: the old fixed limit
      : alive?.length
        ? L.maxQueuedMinutes // the runtime is moving: a long queue is fine
        : L.ingestNotStartedMinutes;
    const neverStarted =
      (
        await versions()
          .eq("status", "pending")
          .lt("created_at", ago(queuedLimit))
          // A retried version is measured from when it was queued again (processed_at).
          .or(`processed_at.is.null,processed_at.lt.${ago(queuedLimit)}`)
          .select(cols)
      ).data ?? [];
    for (const v of [...died, ...neverStarted]) {
      const current = await this.hasCurrent(v.knowledge_item_id);
      await this.db
        .from("knowledge_items")
        .update(
          current
            ? { status: "ready", status_detail: null }
            : { status: "needs_attention", status_detail: null, error_code: "BACKGROUND_STALLED" },
        )
        .eq("id", v.knowledge_item_id)
        .eq("workspace_id", v.workspace_id)
        .in("status", ["queued", "processing"]);
    }
    const notStarted = [
      ...stalledRuns.filter((r) => r.error_code === "BACKGROUND_STALLED"),
      ...neverStarted,
    ];
    return {
      runs: stalledRuns.length,
      versions: died.length + neverStarted.length,
      /** Dispatched, never picked up: the runtime itself isn't executing jobs. */
      notStarted: notStarted.length,
      runtimeJobs: notStarted
        .map((r) => r.runtime_job_id)
        .filter(Boolean)
        .slice(0, 5),
    };
  }

  /** How many syncs of this source failed in a row (the latest first). */
  private async consecutiveFailures(workspaceId: string, sourceId: string) {
    const { data } = await this.db
      .from("knowledge_sync_runs")
      .select("status")
      .eq("workspace_id", workspaceId)
      .eq("source_id", sourceId)
      .not("status", "in", "(queued,running,cancelled)")
      .order("created_at", { ascending: false })
      .limit(12);
    const runs = data ?? [];
    const n = runs.findIndex((r) => r.status !== "failed");
    return n === -1 ? runs.length : n;
  }

  /**
   * A sync that failed or never ran: the source says it needs attention, and the next automatic
   * attempt backs off (15 min, 30, 60 â€¦ a day) so a broken runtime isn't fed a job every tick.
   */
  async scheduleRetry(workspaceId: string, sourceId: string, code: string, now: Date) {
    const failures = await this.consecutiveFailures(workspaceId, sourceId);
    await this.db
      .from("knowledge_sources")
      .update({
        status: "needs_attention",
        last_error_code: code,
        next_sync_at: new Date(now.getTime() + retryDelayMinutes(failures) * 60_000).toISOString(),
      })
      .eq("id", sourceId)
      .eq("workspace_id", workspaceId)
      .is("archived_at", null);
  }

  /**
   * Retry by the user: a queued sync that hasn't started after a minute is replaced (it was
   * handed to a runtime that isn't taking it). A running one is left alone. Returns how many.
   */
  async supersedeQueued(workspaceId: string, sourceId: string, now: Date) {
    const { data } = await this.db
      .from("knowledge_sync_runs")
      .update({ status: "cancelled", error_code: "SUPERSEDED", completed_at: now.toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("source_id", sourceId)
      .eq("status", "queued")
      .lt(
        "created_at",
        new Date(now.getTime() - SOURCE_LIFECYCLE.supersedeQueuedSeconds * 1000).toISOString(),
      )
      .select("id");
    return (data ?? []).length;
  }

  /** The sync in progress per source (at most one, by a unique index). */
  async activeRuns(workspaceId: string, sourceIds: string[]) {
    if (!sourceIds.length) return [];
    const { data } = await this.db
      .from("knowledge_sync_runs")
      // "*": the heartbeat when migration 029 is applied, the rest either way.
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("source_id", sourceIds)
      .in("status", ["queued", "running"]);
    return data ?? [];
  }

  /** The latest finished sync per source: what it found and when (source details). */
  async lastRuns(workspaceId: string, sourceIds: string[]) {
    if (!sourceIds.length) return [];
    const { data } = await this.db
      .from("knowledge_sync_runs")
      .select("source_id, status, completed_at, items_discovered, items_failed, error_code")
      .eq("workspace_id", workspaceId)
      .in("source_id", sourceIds)
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(sourceIds.length * 5);
    const latest = new Map<string, NonNullable<typeof data>[number]>();
    for (const r of data ?? []) if (!latest.has(r.source_id)) latest.set(r.source_id, r);
    return [...latest.values()];
  }

  /** The first (or a manual) sync could not even be queued: say so instead of "preparing". */
  async markSourceAttention(workspaceId: string, sourceId: string, code: string, now: Date) {
    await this.scheduleRetry(workspaceId, sourceId, code, now);
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
