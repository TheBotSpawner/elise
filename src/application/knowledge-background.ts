import "server-only";

import { AppError } from "@/core/errors";
import { CHUNKING } from "@/core/knowledge/chunking";
import { ingestVersion, type IngestionPorts, type IngestOutcome } from "@/core/knowledge/ingest";
import { syncSource, type SyncCounts, type SyncPorts } from "@/core/knowledge/sync";
import { getEmbeddingProvider } from "@/infrastructure/ai";
import { TriggerDevBackgroundRuntime } from "@/infrastructure/background/trigger/runtime";
import {
  isNeedsAttention,
  parseMarkdown,
  parseDocument,
  PARSER_VERSION,
} from "@/infrastructure/knowledge/parsers";
import { logger } from "@/infrastructure/observability/logger";
import { GoogleDriveClient, type DriveSelection } from "@/infrastructure/providers/google/drive";
import type { NotionSelection } from "@/infrastructure/providers/notion/client";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseKnowledgeStore } from "@/infrastructure/supabase/repositories/knowledge-store";
import { downloadOriginal } from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";
import { ownerContext } from "./background";
import { googleHttpFor, notionClientFor } from "./elise";

/**
 * Knowledge in the background (docs/architecture/09 §14-17, 14 §27-28): ingestion of one
 * version and incremental sync of one source. Business logic lives in Core; this file only
 * connects it to Supabase, Storage, Drive, Notion and the runtime. Runs as the workspace owner
 * with the service role, every statement scoped to the workspace in the payload.
 */

const log = (event: string, fields: Record<string, unknown>) => logger.info(event, fields);

async function workspaceContext(workspaceId: string): Promise<AuthContext> {
  const { data } = await createAdminClient()
    .from("workspaces")
    .select("owner_user_id, archived_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!data || data.archived_at) throw new AppError("NOT_FOUND", "Workspace not found");
  return ownerContext(workspaceId, data.owner_user_id);
}

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
            return { doc: await parseDocument({ title: v.title, mimeType: v.mimeType, data }) };
          }
          case "google_drive": {
            if (!v.connectionId || !v.mimeType)
              throw new AppError("PROVIDER_UNAVAILABLE", "The Drive account is not connected", {
                recovery: "reconnect",
              });
            const drive = new GoogleDriveClient(googleHttpFor(auth, v.connectionId));
            const content = await drive.content(v.externalId, v.mimeType);
            return { doc: await parseDocument({ title: v.title, ...content }) };
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
    runtime: new TriggerDevBackgroundRuntime(),
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
  return syncSource(syncPorts(await workspaceContext(job.workspaceId)), job);
}

/** Starts one sync of a source (manual, initial or periodic), at most one at a time. */
export async function startSync(
  workspaceId: string,
  sourceId: string,
  trigger: "scheduled" | "manual" | "initial",
): Promise<string | null> {
  const store = new SupabaseKnowledgeStore(createAdminClient());
  const runId = await store.createSyncRun(workspaceId, sourceId, trigger);
  if (!runId) return null;
  try {
    const { runtimeJobId } = await new TriggerDevBackgroundRuntime().enqueue({
      type: "knowledge.sync",
      payload: { workspaceId, syncRunId: runId },
      idempotencyKey: `knowledge-sync:${runId}`,
    });
    await store.setRunRuntime(workspaceId, runId, runtimeJobId);
  } catch (error) {
    await store.failRun(workspaceId, runId, "BACKGROUND_ERROR");
    throw error;
  }
  return runId;
}

/** Hands one version to the background runtime for ingestion. */
export async function enqueueIngestion(workspaceId: string, versionId: string, force = false) {
  const { runtimeJobId } = await new TriggerDevBackgroundRuntime().enqueue({
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
  await store.expireStaleSyncs(new Date(now.getTime() - 45 * 60_000));
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
