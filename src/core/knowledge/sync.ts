import type { BackgroundRuntime } from "../background/runtime";
import { toAppError } from "../errors";
import type { KnowledgeItemType, KnowledgeSourceType } from "./model";
import { TRANSIENT_CODES } from "./source-state";

/**
 * Incremental sync of an external Knowledge source (docs/architecture/09 §17-19, 54): list the
 * selected roots, compare with what ELISE has (external id + revision), and only touch what
 * changed. New and modified items get a new version and are ingested in the background;
 * items that disappeared are marked removed and stop being searchable.
 */

export const SYNC_INTERVAL_MINUTES = 60;
export const MAX_ITEMS_PER_SOURCE = 500;

export interface ExternalItem {
  externalId: string;
  title: string;
  itemType: KnowledgeItemType;
  mimeType: string | null;
  url: string | null;
  modifiedAt: string | null;
  /** Provider revision (Drive version / Notion last_edited_time). */
  revision: string;
  /** Folder or page path inside the source, kept as metadata. */
  path: string[];
}

export interface SyncSource {
  id: string;
  workspaceId: string;
  spaceId: string;
  sourceType: KnowledgeSourceType;
  connectionId: string | null;
  configuration: unknown;
}

export interface SyncRun {
  id: string;
  workspaceId: string;
  sourceId: string;
  status: string;
}

export interface KnownItem {
  id: string;
  externalId: string;
  status: string;
  /** Revision of the newest version ELISE has for it. */
  revision: string | null;
  /** Why it isn't ready, when it isn't (a stalled or transient failure is retried). */
  errorCode?: string | null;
}

export interface SyncCounts {
  discovered: number;
  created: number;
  updated: number;
  removed: number;
  failed: number;
}

export interface SyncStore {
  loadRun(workspaceId: string, runId: string): Promise<{ run: SyncRun; source: SyncSource } | null>;
  markRunning(run: SyncRun): Promise<void>;
  knownItems(sourceId: string): Promise<KnownItem[]>;
  /** New item + version 1 (pending). */
  createItem(source: SyncSource, item: ExternalItem): Promise<{ versionId: string }>;
  /** Next version (pending) of an existing item; also restores a removed item. */
  addVersion(
    source: SyncSource,
    itemId: string,
    item: ExternalItem,
  ): Promise<{ versionId: string }>;
  markRemoved(source: SyncSource, itemIds: string[]): Promise<void>;
  finish(
    run: SyncRun,
    source: SyncSource,
    result: {
      status: "completed" | "completed_with_warning" | "failed";
      counts: SyncCounts;
      errorCode: string | null;
      nextSyncAt: Date;
      sourceStatus: "ready" | "needs_attention";
    },
  ): Promise<void>;
}

export interface SourceLister {
  list(source: SyncSource): Promise<ExternalItem[]>;
}

export interface SyncPorts {
  store: SyncStore;
  lister: SourceLister;
  runtime: BackgroundRuntime;
  now(): Date;
  log?(event: string, fields: Record<string, unknown>): void;
}

export function planSync(known: readonly KnownItem[], external: readonly ExternalItem[]) {
  const byId = new Map(known.map((k) => [k.externalId, k]));
  const seen = new Set(external.map((e) => e.externalId));
  const created: ExternalItem[] = [];
  const updated: { itemId: string; item: ExternalItem }[] = [];
  for (const item of external) {
    const k = byId.get(item.externalId);
    if (!k) created.push(item);
    else if (
      k.status === "removed" ||
      k.revision !== item.revision ||
      // Same file, but its last ingestion never finished for a reason worth retrying.
      ((k.status === "failed" || k.status === "needs_attention") &&
        TRANSIENT_CODES.has(k.errorCode ?? ""))
    )
      updated.push({ itemId: k.id, item });
  }
  const removed = known
    .filter((k) => !seen.has(k.externalId) && k.status !== "removed" && k.status !== "archived")
    .map((k) => k.id);
  return { created, updated, removed };
}

async function enqueueIngest(ports: SyncPorts, workspaceId: string, versionId: string) {
  await ports.runtime.enqueue({
    type: "knowledge.ingest",
    payload: { workspaceId, versionId },
    idempotencyKey: `knowledge-ingest:${versionId}`,
  });
}

export async function syncSource(
  ports: SyncPorts,
  job: { workspaceId: string; syncRunId: string },
): Promise<SyncCounts | null> {
  const loaded = await ports.store.loadRun(job.workspaceId, job.syncRunId);
  if (!loaded || loaded.run.status !== "queued") return null;
  const { run, source } = loaded;
  const started = ports.now().getTime();
  await ports.store.markRunning(run);
  ports.log?.("knowledge.sync_started", {
    sync_run_id: run.id,
    source_id: source.id,
    provider: source.sourceType,
  });
  const counts: SyncCounts = { discovered: 0, created: 0, updated: 0, removed: 0, failed: 0 };
  const next = new Date(ports.now().getTime() + SYNC_INTERVAL_MINUTES * 60_000);

  let external: ExternalItem[];
  try {
    external = (await ports.lister.list(source)).slice(0, MAX_ITEMS_PER_SOURCE);
  } catch (error) {
    const e = toAppError(error);
    // Nothing is removed when the source can't be read: stale beats wrongly deleted.
    await ports.store.finish(run, source, {
      status: "failed",
      counts,
      errorCode: e.code,
      nextSyncAt: next,
      sourceStatus: "needs_attention",
    });
    ports.log?.("knowledge.sync_failed", {
      sync_run_id: run.id,
      source_id: source.id,
      provider: source.sourceType,
      stage: "list",
      code: e.code,
      duration_ms: ports.now().getTime() - started,
    });
    return counts;
  }

  counts.discovered = external.length;
  const plan = planSync(await ports.store.knownItems(source.id), external);
  for (const item of plan.created) {
    try {
      const { versionId } = await ports.store.createItem(source, item);
      await enqueueIngest(ports, source.workspaceId, versionId);
      counts.created++;
    } catch {
      counts.failed++;
    }
  }
  for (const { itemId, item } of plan.updated) {
    try {
      const { versionId } = await ports.store.addVersion(source, itemId, item);
      await enqueueIngest(ports, source.workspaceId, versionId);
      counts.updated++;
    } catch {
      counts.failed++;
    }
  }
  if (plan.removed.length) {
    await ports.store.markRemoved(source, plan.removed);
    counts.removed = plan.removed.length;
  }
  await ports.store.finish(run, source, {
    status: counts.failed ? "completed_with_warning" : "completed",
    counts,
    errorCode: null,
    nextSyncAt: next,
    sourceStatus: "ready",
  });
  ports.log?.("knowledge.sync_completed", {
    sync_run_id: run.id,
    source_id: source.id,
    provider: source.sourceType,
    ...counts,
    duration_ms: ports.now().getTime() - started,
  });
  return counts;
}
