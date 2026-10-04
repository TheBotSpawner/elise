import "server-only";

import { extractText, getDocumentProxy } from "unpdf";

import { AppError } from "@/core/errors";
import {
  EXTRACTION_LIMITS,
  inBatches,
  mergeExtraction,
  needsOcr,
  type DocumentExtraction,
  type OcrProvider,
} from "@/core/knowledge/extraction";

/**
 * Reads PDFs and images into a DocumentExtraction (ADR-035): native text per page first, then
 * OCR only for the pages that need it, in page-selected batches. `known` pages (an earlier,
 * interrupted run of the same bytes) are reused, so a retry continues instead of starting over.
 */

export const OCR_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/tiff",
]);

function attention(message: string, reason: string): AppError {
  return new AppError("VALIDATION_ERROR", message, {
    recovery: "review",
    details: { knowledge: "needs_attention", reason },
  });
}

async function nativePages(data: Uint8Array): Promise<string[]> {
  try {
    // pdf.js takes ownership of the buffer it parses: give it a copy, so the same bytes can
    // still go to OCR (and be hashed, cached) afterwards.
    const pdf = await getDocumentProxy(data.slice());
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name ?? "";
    if (name === "PasswordException")
      throw attention(
        "This PDF is password-protected: remove the password and upload it again",
        "password",
      );
    throw attention("This PDF is damaged or isn't a real PDF", "corrupt");
  }
}

export async function extractFile(
  input: { data: Uint8Array; mimeType: string },
  opts: {
    ocr: OcrProvider | null;
    /** Most pages to OCR now; the rest stay "unread" (chat waits less than a background job). */
    maxOcrPages: number;
    known?: ReadonlyMap<number, string>;
    languageHints?: string[];
    /** OCR is about to run (the UI says "Reconociendo texto"). */
    onOcr?: (pages: number) => void | Promise<void>;
    /** After each OCR batch: the extraction so far (saved so a retry resumes). */
    onProgress?: (partial: DocumentExtraction) => void | Promise<void>;
  },
): Promise<DocumentExtraction> {
  const isPdf = input.mimeType === "application/pdf";
  const native = isPdf ? await nativePages(input.data) : [""];
  const needOcr = native.map((t, i) => (needsOcr(t) ? i + 1 : 0)).filter(Boolean);
  const ocr = new Map(opts.known ?? []);
  const todo = needOcr.filter((p) => !ocr.has(p)).slice(0, Math.max(0, opts.maxOcrPages));
  if (todo.length && opts.ocr && input.data.byteLength <= EXTRACTION_LIMITS.maxOcrBytes) {
    await opts.onOcr?.(todo.length);
    for (const batch of isPdf ? inBatches(todo, EXTRACTION_LIMITS.ocrBatchPages) : [null]) {
      const read = await opts.ocr.ocr({
        data: input.data,
        mimeType: input.mimeType,
        pages: batch,
        languageHints: opts.languageHints,
      });
      // A page the engine returned nothing for was still read: it's blank, not unread.
      for (const p of batch ?? [1]) ocr.set(p, read.find((r) => r.page === p)?.text ?? "");
      await opts.onProgress?.(mergeExtraction({ native, ocr, needOcr }));
    }
  }
  const extraction = mergeExtraction({ native, ocr, needOcr });
  if (input.data.byteLength > EXTRACTION_LIMITS.maxOcrBytes && extraction.unreadPages.length)
    extraction.warnings.push("too_large_for_ocr");
  if (!opts.ocr && extraction.unreadPages.length) extraction.warnings.push("ocr_unavailable");
  return extraction;
}

/** Why nothing could be read, in the user's terms (Knowledge's "Needs attention"). */
export function unreadableReason(x: DocumentExtraction): AppError {
  if (x.warnings.includes("ocr_unavailable"))
    return attention(
      "This document is scanned and text recognition (OCR) isn't set up yet",
      "ocr_unavailable",
    );
  if (x.warnings.includes("too_large_for_ocr"))
    return attention("This scanned document is too large to read", "too_large");
  return attention(
    x.ocrPages.length
      ? "No text was found, even with text recognition"
      : "This file has no readable text",
    x.ocrPages.length ? "blank" : "no_text",
  );
}
