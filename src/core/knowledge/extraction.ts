import type { DocumentSection, NormalizedDocument } from "./model";

/**
 * Document extraction (ADR-035): one way to read a file, shared by Knowledge ingestion and chat
 * attachments. Native text first (faster, cheaper, exact); OCR only for the pages whose text
 * layer is missing or empty — a mixed PDF is read page by page and merged in order. The text is
 * kept as extracted (only whitespace is normalized): nothing rewrites what a page says.
 */

export type PageMethod = "native" | "ocr";
export type ExtractionMethod = "native" | "ocr" | "hybrid";

export interface ExtractedPage {
  /** 1-based page number (images are page 1). */
  page: number;
  text: string;
  method: PageMethod;
}

export interface DocumentExtraction {
  pages: ExtractedPage[];
  method: ExtractionMethod;
  pageCount: number;
  /** Pages that needed OCR and were read with it. */
  ocrPages: number[];
  /** Pages that needed OCR but weren't read (limit reached, no provider): never "empty". */
  unreadPages: number[];
  warnings: string[];
}

/** Port: an OCR engine (Google Document AI first). Lives in infrastructure. */
export interface OcrProvider {
  readonly id: string;
  /** Text of the given pages (1-based), or of the whole file when `pages` is null. */
  ocr(input: {
    data: Uint8Array;
    mimeType: string;
    pages: number[] | null;
    languageHints?: string[];
  }): Promise<{ page: number; text: string }[]>;
}

/** One place for every extraction limit (documents and chat alike). */
export const EXTRACTION_LIMITS = {
  /** Pages per OCR request (Document AI online processing). */
  ocrBatchPages: 15,
  /** Pages OCR'd for one Knowledge document in one background job. */
  maxOcrPagesPerJob: 500,
  /** Pages OCR'd while a chat turn waits; the rest are reported as not read yet. */
  chatOcrPages: 15,
  /** Bytes sent to OCR in one request (Document AI online limit is 40 MB). */
  maxOcrBytes: 38 * 1024 * 1024,
} as const;

/** Letters and digits on a page: below this, its text layer is missing (scanned) or junk. */
const MIN_PAGE_CHARS = 25;

export function needsOcr(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) < MIN_PAGE_CHARS;
}

export function methodOf(pages: readonly ExtractedPage[]): ExtractionMethod {
  const ocr = pages.some((p) => p.method === "ocr");
  const native = pages.some((p) => p.method === "native" && p.text.trim());
  return ocr && native ? "hybrid" : ocr ? "ocr" : "native";
}

export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Whitespace only: line wraps rejoined into paragraphs. Never the words. */
export function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/([^.!?:;\n])\n(?=\S)/g, "$1 ")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

/** Pages become sections, so passages and citations keep "page 27". */
export function toNormalizedDocument(title: string, x: DocumentExtraction): NormalizedDocument {
  const sections: DocumentSection[] = x.pages
    .filter((p) => p.text.trim())
    .map((p) => ({ headingPath: [], page: p.page, blocks: paragraphsOf(p.text) }));
  return { title, sections };
}

/** Plain text of an extraction, with page marks (what a chat turn reads). */
export function extractionText(x: DocumentExtraction): string {
  return x.pages
    .filter((p) => p.text.trim())
    .map((p) => (x.pageCount > 1 ? `[page ${p.page}]\n${p.text.trim()}` : p.text.trim()))
    .join("\n\n");
}

/**
 * Merges native pages with OCR results, in page order. Pages that needed OCR and didn't get it
 * stay listed as unread — never silently dropped, never presented as empty.
 */
export function mergeExtraction(input: {
  native: string[];
  ocr: ReadonlyMap<number, string>;
  needOcr: readonly number[];
}): DocumentExtraction {
  const pages: ExtractedPage[] = input.native.map((text, i) => {
    const page = i + 1;
    const fromOcr = input.ocr.get(page);
    return fromOcr !== undefined && input.needOcr.includes(page)
      ? { page, text: fromOcr, method: "ocr" }
      : { page, text, method: "native" };
  });
  const ocrPages = input.needOcr.filter((p) => input.ocr.has(p));
  const unreadPages = input.needOcr.filter((p) => !input.ocr.has(p));
  return {
    pages,
    method: methodOf(pages),
    pageCount: pages.length,
    ocrPages,
    unreadPages,
    warnings: unreadPages.length ? [`unread_pages:${unreadPages.length}`] : [],
  };
}
