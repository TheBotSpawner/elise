import { AppError, toAppError } from "../errors";
import { CHUNKING, chunkDocument, embeddingText } from "./chunking";
import {
  contentHash,
  documentText,
  type ChunkDraft,
  type EmbeddingProvider,
  type KnowledgeItemType,
  type KnowledgeSourceType,
  type NormalizedDocument,
} from "./model";

/**
 * Ingestion of one KnowledgeVersion (docs/architecture/09 §14): fetch → extract → normalize →
 * hash (unchanged content is never re-embedded) → chunk → embed → index → Ready. Runs in the
 * background runtime; state lives in the database so closing the browser changes nothing.
 */

export interface VersionToIngest {
  versionId: string;
  itemId: string;
  workspaceId: string;
  spaceId: string;
  sourceId: string;
  versionNumber: number;
  title: string;
  sourceType: KnowledgeSourceType;
  itemType: KnowledgeItemType;
  externalId: string;
  connectionId: string | null;
  storagePath: string | null;
  mimeType: string | null;
  status: string;
}

export interface CurrentVersion {
  id: string;
  contentHash: string | null;
  chunkingVersion: string | null;
  embeddingModel: string | null;
}

export interface IndexedChunk extends ChunkDraft {
  embedding: number[];
}

export interface IngestionStore {
  loadVersion(workspaceId: string, versionId: string): Promise<VersionToIngest | null>;
  currentVersion(itemId: string): Promise<CurrentVersion | null>;
  /** Progress the user sees ("Reading document", "Understanding it"). */
  markProcessing(v: VersionToIngest, detail: "reading" | "ocr" | "indexing"): Promise<void>;
  /** Same content as the current version: nothing to index, the item stays as it was. */
  markUnchanged(v: VersionToIngest, hash: string): Promise<void>;
  /**
   * Stores the chunks of this version and makes it current in one step. Chunks of the previous
   * current version stop being searchable; its text is kept for history and comparison.
   */
  activate(
    v: VersionToIngest,
    result: {
      text: string;
      hash: string;
      chunks: IndexedChunk[];
      parserVersion: string;
      chunkingVersion: string;
      embeddingModel: string;
      sourceRevision?: string | null;
    },
  ): Promise<void>;
  markFailed(
    v: VersionToIngest,
    failure: { status: "needs_attention" | "failed"; code: string; detail: string },
  ): Promise<void>;
}

export interface ContentFetcher {
  /** Returns the normalized document for this version (uploads, Drive, Notion…). */
  fetch(v: VersionToIngest): Promise<{ doc: NormalizedDocument; revision?: string | null }>;
}

export interface IngestionPorts {
  store: IngestionStore;
  fetcher: ContentFetcher;
  embeddings: () => EmbeddingProvider;
  parserVersion: string;
  isNeedsAttention(error: unknown): boolean;
  log?(event: string, fields: Record<string, unknown>): void;
}

export const MAX_INGEST_ATTEMPTS = 3;

export type IngestOutcome = "ready" | "unchanged" | "needs_attention" | "failed" | "skipped";

/** Throws only for transient failures that the background runtime should retry. */
export async function ingestVersion(
  ports: IngestionPorts,
  job: { workspaceId: string; versionId: string; attempt: number; force?: boolean },
): Promise<IngestOutcome> {
  const v = await ports.store.loadVersion(job.workspaceId, job.versionId);
  if (!v) return "skipped";
  if (!job.force && ["ready", "unchanged", "superseded"].includes(v.status)) return "skipped";
  const started = Date.now();

  try {
    await ports.store.markProcessing(v, "reading");
    const { doc, revision } = await ports.fetcher.fetch(v);
    const text = documentText(doc);
    const hash = await contentHash(text);
    const embeddings = ports.embeddings();

    const current = await ports.store.currentVersion(v.itemId);
    const sameIndex =
      current?.contentHash === hash &&
      current.chunkingVersion === CHUNKING.version &&
      current.embeddingModel === embeddings.model;
    if (!job.force && current && current.id !== v.versionId && sameIndex) {
      await ports.store.markUnchanged(v, hash);
      ports.log?.("knowledge.ingest_unchanged", { version_id: v.versionId });
      return "unchanged";
    }

    const drafts = chunkDocument(doc);
    if (!drafts.length) {
      throw new AppError("VALIDATION_ERROR", "This document has no readable text", {
        details: { knowledge: "needs_attention" },
      });
    }
    await ports.store.markProcessing(v, "indexing");
    const vectors = await embeddings.embed(drafts.map((c) => embeddingText(v.title, c)));
    await ports.store.activate(v, {
      text,
      hash,
      chunks: drafts.map((c, i) => ({ ...c, embedding: vectors[i]! })),
      parserVersion: ports.parserVersion,
      chunkingVersion: CHUNKING.version,
      embeddingModel: embeddings.model,
      sourceRevision: revision,
    });
    ports.log?.("knowledge.ingest_ready", {
      version_id: v.versionId,
      chunks: drafts.length,
      embedding_calls: Math.ceil(drafts.length / 96),
      duration_ms: Date.now() - started,
    });
    return "ready";
  } catch (error) {
    const e = toAppError(error);
    if (ports.isNeedsAttention(error)) {
      await ports.store.markFailed(v, {
        status: "needs_attention",
        code: e.code,
        detail: e.message,
      });
      return "needs_attention";
    }
    if (e.retryable && job.attempt < MAX_INGEST_ATTEMPTS) {
      ports.log?.("knowledge.ingest_retry", {
        version_id: v.versionId,
        attempt: job.attempt,
        code: e.code,
      });
      throw e;
    }
    // A revoked connection is actionable: reconnect, then sync again.
    const actionable = e.code === "AUTH_EXPIRED" || e.code === "PERMISSION_DENIED";
    await ports.store.markFailed(v, {
      status: actionable ? "needs_attention" : "failed",
      code: e.code,
      detail: e.message,
    });
    ports.log?.("knowledge.ingest_failed", { version_id: v.versionId, code: e.code });
    return actionable ? "needs_attention" : "failed";
  }
}
