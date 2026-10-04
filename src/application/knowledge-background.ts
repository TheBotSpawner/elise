import "server-only";

import { serverEnv } from "@/config/server-env";
import type { BackgroundRuntime } from "@/core/background/runtime";
import { AppError } from "@/core/errors";
import { CHUNKING } from "@/core/knowledge/chunking";
import { ingestVersion, type IngestionPorts, type IngestOutcome } from "@/core/knowledge/ingest";
import { syncSource, type SyncCounts, type SyncPorts } from "@/core/knowledge/sync";
import { getEmbeddingProvider } from "@/infrastructure/ai";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import {
  isNeedsAttention,
  parseMarkdown,
  PARSER_VERSION,
} from "@/infrastructure/knowledge/parsers";
import { logger } from "@/infrastructure/observability/logger";
import { GoogleDriveClient, type DriveSelection } from "@/infrastructure/providers/google/drive";
import type { NotionSelection } from "@/infrastructure/providers/notion/client";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseKnowledgeStore } from "@/infrastructure/supabase/repositories/knowledge-store";
import { downloadOriginal } from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";
import { workspaceContext } from "./background";
import { googleHttpFor, notionClientFor } from "./elise";
import { readDocument } from "./extraction-service";

/**
 * Knowledge in the background (docs/architecture/09 §14-17, 14 §27-28): ingestion of one
 * version and incremental sync of one source. Business logic lives in Core; this file only
 * connects it to Supabase, Storage, Drive, Notion and the runtime. Runs as the workspace owner
 * with the service role, every statement scoped to the workspace in the payload.
 */

const log = (event: string, fields: Record<string, unknown>) => logger.info(event, fields);

function ingestionPorts(auth: AuthContext): IngestionPorts {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  return {
    store,
    embeddings: getEmbeddingProvider,
    parserVersion: PARSER_VERSION,
    isNeedsAttention,
    log,
    fetcher: {
      async fetch(v) {
        switch (v.sourceType) {
          case "note": {
            // The note row is the source of truth: always index its latest text.
            const { data: note } = await createAdminClient()
              .from("notes")
              .select("title, content, status")
              .eq("id", v.externalId)
              .eq("workspace_id", v.workspaceId)
              .maybeSingle();
            if (!note || note.status !== "active")
              throw new AppError("NOT_FOUND", "The note no longer exists");
            return { doc: parseMarkdown(note.title, note.content || note.title) };
          }
          case "upload": {
            if (!v.storagePath || !v.mimeType)
              throw new AppError("NOT_FOUND", "The original file is missing");
            const data = await downloadOriginal(v.workspaceId, v.storagePath);
            // Native text first; scanned pages are recognized (OCR) right here, in the job.
            return {
              doc: await readDocument(
                v.workspaceId,
                { title: v.title, mimeType: v.mimeType, data },
                () => store.markProcessing(v, "ocr"),
              ),
            };
          }
          case "google_drive": {
            if (!v.connectionId || !v.mimeType)
              throw new AppError("PROVIDER_UNAVAILABLE", "The Drive account is not connected", {
                recovery: "reconnect",
              });
            const drive = new GoogleDriveClient(googleHttpFor(auth, v.connectionId));
            const content = await drive.content(v.externalId, v.mimeType);
            return {
              doc: await readDocument(v.workspaceId, { title: v.title, ...content }, () =>
                store.markProcessing(v, "ocr"),
              ),
            };
          }
          case "notion": {
            if (!v.connectionId)
              throw new AppError("PROVIDER_UNAVAILABLE", "The Notion account is not connected", {
                recovery: "reconnect",
              });
            return { doc: await notionClientFor(auth, v.connectionId).pageDocument(v.externalId) };
          }
        }
      },
    },
  };
}

/**
 * Where Knowledge work runs: Trigger.dev (durable, retried, scheduled). In development without
 * TRIGGER_SECRET_KEY it runs in this server process instead, so a connected Drive/Notion
 * source still prepares itself without any manual step. Production always needs Trigger.dev.
 */
function knowledgeRuntime(): BackgroundRuntime {
  if (isBackgroundConfigured() || serverEnv().ELISE_ENV === "production")
    return new TriggerDevBackgroundRuntime();
  return {
    async enqueue(job) {
      const id = `inline:${crypto.randomUUID()}`;
      setTimeout(() => {
        const run =
          job.type === "knowledge.sync"
            ? runSync(job.payload)
            : job.type === "knowledge.ingest"
              ? runIngestion({ ...job.payload, attempt: 1 })
              : Promise.reject(new Error(`no inline runner for ${job.type}`));
        run.catch((error: unknown) =>
          log("knowledge.inline_job_failed", {
            type: job.type,
            code: (error as { code?: string }).code,
          }),
        );
      }, 0);
      return { runtimeJobId: id };
    },
    async cancel() {},
  };
}

/**
 * Safety net (and the only scheduler in development): sources of these Spaces that are due —
 * never synced, or past their next check — start syncing now. Cheap when nothing is due.
 */
export async function syncDueSources(workspaceId: string, spaceIds: string[] | null = null) {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  // Work lost by the runtime is closed first, so it can't block the restart below.
  await recoverStaleWork(workspaceId);
  const due = (await store.dueSources(new Date(), 20)).filter(
    (s) => s.workspace_id === workspaceId && (!spaceIds || spaceIds.includes(s.space_id)),
  );
  for (const s of due) await startSync(workspaceId, s.id, "scheduled").catch(() => null);
  return due.length;
}

export async function runIngestion(job: {
  workspaceId: string;
  versionId: string;
  attempt: number;
  force?: boolean;
}): Promise<IngestOutcome> {
  return ingestVersion(ingestionPorts(await workspaceContext(job.workspaceId)), job);
}

function syncPorts(auth: AuthContext): SyncPorts {
  return {
    store: new SupabaseKnowledgeStore(createAdminClient()),
    runtime: knowledgeRuntime(),
    now: () => new Date(),
    log,
    lister: {
      async list(source) {
        if (!source.connectionId) {
          throw new AppError("AUTH_EXPIRED", "This source's account was disconnected", {
            recovery: "reconnect",
          });
        }
        const selection = ((source.configuration as { selection?: unknown[] })?.selection ??
          []) as never[];
        if (source.sourceType === "google_drive") {
          return new GoogleDriveClient(googleHttpFor(auth, source.connectionId)).listSelection(
            selection as DriveSelection[],
            500,
          );
        }
        if (source.sourceType === "notion") {
          return notionClientFor(auth, source.connectionId).listSelection(
            selection as NotionSelection[],
            500,
          );
        }
        return [];
      },
    },
  };
}

export async function runSync(job: {
  workspaceId: string;
  syncRunId: string;
}): Promise<SyncCounts | null> {
  try {
    return await syncSource(syncPorts(await workspaceContext(job.workspaceId)), job);
  } catch (error) {
    // Anything that escaped the sync (loading the workspace, the store) still closes the run:
    // a crashed task must never leave its source "preparing".
    const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
    const store = new SupabaseKnowledgeStore(createAdminClient());
    const loaded = await store.loadRun(job.workspaceId, job.syncRunId).catch(() => null);
    await store.failRun(job.workspaceId, job.syncRunId, code).catch(() => undefined);
    if (loaded)
      await store
        .markSourceAttention(job.workspaceId, loaded.source.id, code, new Date())
        .catch(() => undefined);
    log("knowledge.sync_crashed", { sync_run_id: job.syncRunId, code });
    throw error;
  }
}

/** Closes syncs and ingestions the runtime lost (see SOURCE_LIFECYCLE). Cheap when none. */
export async function recoverStaleWork(workspaceId: string | null) {
  const closed = await new SupabaseKnowledgeStore(createAdminClient()).recoverStale(
    new Date(),
    workspaceId,
  );
  if (closed.runs || closed.versions) log("knowledge.stale_recovered", closed);
  return closed;
}

/**
 * Starts one sync of a source (manual, initial or periodic), at most one at a time: null when
 * one is already active. If the runtime refuses the job, the run closes and the source says it
 * needs attention — it never sits "preparing" waiting for work nobody will do.
 */
export async function startSync(
  workspaceId: string,
  sourceId: string,
  trigger: "scheduled" | "manual" | "initial",
): Promise<string | null> {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  const runId = await store.createSyncRun(workspaceId, sourceId, trigger);
  if (!runId) return null;
  log("knowledge.sync_queued", { sync_run_id: runId, source_id: sourceId, trigger });
  try {
    const { runtimeJobId } = await knowledgeRuntime().enqueue({
      type: "knowledge.sync",
      payload: { workspaceId, syncRunId: runId },
      idempotencyKey: `knowledge-sync:${runId}`,
    });
    await store.setRunRuntime(workspaceId, runId, runtimeJobId);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "BACKGROUND_ERROR";
    await store.failRun(workspaceId, runId, code);
    await store.markSourceAttention(workspaceId, sourceId, code, new Date());
    log("knowledge.sync_enqueue_failed", { sync_run_id: runId, source_id: sourceId, code });
    throw error;
  }
  return runId;
}

/** Hands one version to the background runtime for ingestion. */
export async function enqueueIngestion(workspaceId: string, versionId: string, force = false) {
  const { runtimeJobId } = await knowledgeRuntime().enqueue({
    type: "knowledge.ingest",
    payload: { workspaceId, versionId, ...(force ? { force } : {}) },
    idempotencyKey: `knowledge-ingest:${versionId}${force ? `:reindex:${Date.now()}` : ""}`,
  });
  await new SupabaseKnowledgeStore(createAdminClient()).setVersionRuntime(
    workspaceId,
    versionId,
    runtimeJobId,
  );
}

/** Periodic tick: expire lost syncs, then start the ones that are due. */
export async function dispatchKnowledgeSyncs(): Promise<{ started: number }> {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  const now = new Date();
  await recoverStaleWork(null);
  let started = 0;
  for (const source of await store.dueSources(now, 50)) {
    const id = await startSync(source.workspace_id, source.id, "scheduled").catch(() => null);
    if (id) started++;
  }
  return { started };
}

/**
 * Internal reindex: current versions built with another chunking version or embedding model
 * are ingested again from their source. Not exposed in the product UI.
 */
export async function reindexKnowledge(workspaceId: string | null, limit = 200) {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  const stale = await store.staleVersions(
    workspaceId,
    CHUNKING.version,
    getEmbeddingProvider().model,
    limit,
  );
  for (const v of stale) await enqueueIngestion(v.workspace_id, v.id, true);
  log("knowledge.reindex_enqueued", { count: stale.length });
  return { enqueued: stale.length };
}
