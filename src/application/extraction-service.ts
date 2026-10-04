import "server-only";

import { createHash } from "node:crypto";

import {
  EXTRACTION_LIMITS,
  toNormalizedDocument,
  type DocumentExtraction,
  type ExtractedPage,
} from "@/core/knowledge/extraction";
import type { NormalizedDocument } from "@/core/knowledge/model";
import { extractFile, OCR_TYPES, unreadableReason } from "@/infrastructure/knowledge/extraction";
import { parseDocument } from "@/infrastructure/knowledge/parsers";
import { logger } from "@/infrastructure/observability/logger";
import { getOcrProvider } from "@/infrastructure/ocr/google-document-ai";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";

/**
 * The one DocumentExtraction service (ADR-035), used by Knowledge ingestion (uploads, Drive)
 * and chat attachments. Results are kept by the file's bytes (SHA-256) per workspace: the same
 * file attached in chat and then saved to Knowledge is read once, and an OCR interrupted at
 * page 83 resumes there. Different versions have different bytes: they never share a result.
 */

export interface ExtractionResult extends DocumentExtraction {
  hash: string;
  /** Served from an earlier extraction of the same bytes (no OCR this time). */
  reused: boolean;
}

export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function extractDocument(
  workspaceId: string,
  input: { data: Uint8Array; mimeType: string },
  opts: { purpose: "chat" | "knowledge"; onOcr?: (pages: number) => void | Promise<void> },
): Promise<ExtractionResult> {
  const hash = sha256(input.data);
  const db = createAdminClient();
  const { data: row } = await db
    .from("document_extractions")
    .select("pages, method, page_count, ocr_pages, complete, warnings")
    .eq("workspace_id", workspaceId)
    .eq("content_hash", hash)
    .maybeSingle();
  const stored = (row?.pages ?? []) as unknown as ExtractedPage[];
  if (row?.complete) {
    logger.info("extraction.reused", { method: row.method, pages: row.page_count });
    return {
      hash,
      reused: true,
      pages: stored,
      method: row.method,
      pageCount: row.page_count,
      ocrPages: stored.filter((p) => p.method === "ocr").map((p) => p.page),
      unreadPages: [],
      warnings: (row.warnings as string[]) ?? [],
    };
  }
  const ocr = getOcrProvider();
  const save = (x: DocumentExtraction, complete: boolean) =>
    db.from("document_extractions").upsert(
      {
        workspace_id: workspaceId,
        content_hash: hash,
        mime_type: input.mimeType,
        method: x.method,
        page_count: x.pageCount,
        pages: x.pages as unknown as Json,
        ocr_provider: x.ocrPages.length ? (ocr?.id ?? null) : null,
        ocr_pages: x.ocrPages.length,
        complete,
        warnings: x.warnings as unknown as Json,
      },
      { onConflict: "workspace_id,content_hash" },
    );
  const started = Date.now();
  const extraction = await extractFile(input, {
    ocr,
    maxOcrPages:
      opts.purpose === "chat"
        ? EXTRACTION_LIMITS.chatOcrPages
        : EXTRACTION_LIMITS.maxOcrPagesPerJob,
    known: new Map(stored.filter((p) => p.method === "ocr").map((p) => [p.page, p.text])),
    onOcr: opts.onOcr,
    // Each OCR batch is kept: a failure later doesn't lose (or re-bill) the pages already read.
    onProgress: async (partial) => {
      await save(partial, false);
    },
  });
  // Only a full read is final; one that left pages unread is retried later from where it was.
  await save(extraction, extraction.unreadPages.length === 0);
  logger.info("extraction.done", {
    purpose: opts.purpose,
    method: extraction.method,
    pages: extraction.pageCount,
    ocr_pages: extraction.ocrPages.length,
    unread_pages: extraction.unreadPages.length,
    duration_ms: Date.now() - started,
  });
  return { ...extraction, hash, reused: false };
}

/**
 * A file as Knowledge reads it: PDFs and images through extraction (OCR where needed), other
 * formats through their parsers. Nothing readable → "Needs attention" with the real reason.
 */
export async function readDocument(
  workspaceId: string,
  input: { title: string; mimeType: string; data: Uint8Array },
  onOcr?: (pages: number) => void | Promise<void>,
): Promise<NormalizedDocument> {
  if (!OCR_TYPES.has(input.mimeType)) return parseDocument(input);
  const x = await extractDocument(workspaceId, input, { purpose: "knowledge", onOcr });
  const doc = toNormalizedDocument(input.title, x);
  if (!doc.sections.length) throw unreadableReason(x);
  return doc;
}
