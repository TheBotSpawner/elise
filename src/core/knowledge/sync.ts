import { toAppError } from "../errors";
import type { KnowledgeItemType, KnowledgeSourceType } from "./model";

/**
 * Incremental sync of an external Knowledge source (docs/architecture/09 Â§17-19, 54): list the
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
  /** Sign of life while items are being created (ADR-036 lease). */
  heartbeat?(run: SyncRun): Promise<void>;
  knownItems(sourceId: string): Promise<KnownItem[]>;
  /** A new catalog entry (metadata only, no version, no content). */
  catalogItem(source: SyncSource, item: ExternalItem): Promise<void>;
  /** An entry's metadata changed (or it came back after being removed). */
  updateCatalogItem(source: SyncSource, itemId: string, item: ExternalItem): Promise<void>;
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
      /** Source-level catalog facts (Drive: the folders live search may look in). */
      catalog?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface SourceLister {
  list(source: SyncSource): Promise<{ items: ExternalItem[]; catalog?: Record<string, unknown> }>;
}

export interface SyncPorts {
  store: SyncStore;
  lister: SourceLister;
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
    // Changed, came back, or still carries a pre-ADR-046 ingestion state: refresh the entry.
    else if (k.status !== "ready" || k.revision !== item.revision)
      updated.push({ itemId: k.id, item });
  }
  const removed = known
    .filter((k) => !seen.has(k.externalId) && k.status !== "removed" && k.status !== "archived")
    .map((k) => k.id);
  return { created, updated, removed };
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
  let catalog: Record<string, unknown> | undefined;
  try {
    const listed = await ports.lister.list(source);
    external = listed.items.slice(0, MAX_ITEMS_PER_SOURCE);
    catalog = listed.catalog;
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
  let done = 0;
  const beat = async () => {
    if (++done % 25 === 0) await ports.store.heartbeat?.(run);
  };
  for (const item of plan.created) {
    try {
      await ports.store.catalogItem(source, item);
      counts.created++;
    } catch {
      counts.failed++;
    }
    await beat();
  }
  for (const { itemId, item } of plan.updated) {
    try {
      await ports.store.updateCatalogItem(source, itemId, item);
      counts.updated++;
    } catch {
      counts.failed++;
    }
    await beat();
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
    ...(catalog ? { catalog } : {}),
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
