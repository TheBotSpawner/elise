import { describe, expect, it } from "vitest";

import {
  EXTRACTION_LIMITS,
  extractionText,
  mergeExtraction,
  needsOcr,
  toNormalizedDocument,
  type OcrProvider,
} from "@/core/knowledge/extraction";
import { extractFile, unreadableReason } from "@/infrastructure/knowledge/extraction";
import { pagesFromDocument } from "@/infrastructure/ocr/google-document-ai";

/**
 * Shared document extraction (ADR-035): native text first, OCR only for the pages that need it,
 * merged in page order with page provenance. Real PDFs (built here), real parsing; the OCR
 * engine is a fake that records which pages it was asked for.
 */

/** A PDF whose pages have a text layer (string) or none at all (null: a scanned page). */
function pdf(pages: (string | null)[]): Uint8Array {
  const objs: string[] = [];
  const add = (o: string) => objs.push(o) - 1 + 1; // 1-based ids
  const catalog = add("");
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const text of pages) {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "0 0 1 rg 72 72 100 100 re f";
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const LINE = (n: number) => `Native page ${n} with plenty of readable words in it.`;

/** OCR that "reads" page N as "Scanned text of page N…" and records every request. */
function fakeOcr(opts: { blank?: boolean; failOnCall?: number } = {}) {
  const calls: (number[] | null)[] = [];
  const provider: OcrProvider = {
    id: "fake_ocr",
    async ocr({ pages }) {
      calls.push(pages);
      if (opts.failOnCall === calls.length) throw new Error("provider down");
      return (pages ?? [1]).map((page) => ({
        page,
        text: opts.blank ? "" : `Scanned text of page ${page}, recognized faithfully.`,
      }));
    },
  };
  return { provider, calls };
}

const run = (
  data: Uint8Array,
  ocr: OcrProvider | null,
  maxOcrPages = 500,
  mimeType = "application/pdf",
) => extractFile({ data, mimeType }, { ocr, maxOcrPages });

describe("deciding per page", () => {
  it("a page with real text keeps it; an empty or junk page needs OCR", () => {
    expect(needsOcr(LINE(1))).toBe(false);
    expect(needsOcr("")).toBe(true);
    expect(needsOcr("  \n · · 3 ")).toBe(true);
  });

  it("merges native and OCR pages in order, with each page's method", () => {
    const x = mergeExtraction({
      native: [LINE(1), "", LINE(3), ""],
      ocr: new Map([
        [2, "two"],
        [4, "four"],
      ]),
      needOcr: [2, 4],
    });
    expect(x.pages.map((p) => [p.page, p.method])).toEqual([
      [1, "native"],
      [2, "ocr"],
      [3, "native"],
      [4, "ocr"],
    ]);
    expect(x.method).toBe("hybrid");
    expect(toNormalizedDocument("Doc", x).sections.map((s) => s.page)).toEqual([1, 2, 3, 4]);
    expect(extractionText(x)).toContain("[page 2]\ntwo");
  });
});

describe("extracting real PDFs", () => {
  it("a normal PDF never calls OCR", async () => {
    const { provider, calls } = fakeOcr();
    const x = await run(pdf([LINE(1), LINE(2)]), provider);
    expect(calls).toEqual([]);
    expect(x).toMatchObject({ method: "native", pageCount: 2, ocrPages: [], unreadPages: [] });
    expect(x.pages[1]!.text).toContain("Native page 2");
  });

  it("a fully scanned PDF is read with OCR automatically", async () => {
    const { provider, calls } = fakeOcr();
    const x = await run(pdf([null, null]), provider);
    expect(calls).toEqual([[1, 2]]);
    expect(x.method).toBe("ocr");
    expect(x.pages.map((p) => p.text)).toEqual([
      "Scanned text of page 1, recognized faithfully.",
      "Scanned text of page 2, recognized faithfully.",
    ]);
  });

  it("OCR receives the whole file intact after native parsing (pdf.js takes its buffer)", async () => {
    const sizes: number[] = [];
    const data = pdf([LINE(1), null]);
    const provider: OcrProvider = {
      id: "size_probe",
      async ocr({ data: bytes, pages }) {
        sizes.push(bytes.byteLength);
        return (pages ?? []).map((page) => ({ page, text: "x" }));
      },
    };
    await run(data, provider);
    expect(sizes).toEqual([data.byteLength]);
  });

  it("a mixed PDF sends only its scanned pages to OCR", async () => {
    const { provider, calls } = fakeOcr();
    const x = await run(pdf([LINE(1), null, LINE(3), null]), provider);
    expect(calls).toEqual([[2, 4]]);
    expect(x.method).toBe("hybrid");
    expect(x.pages.map((p) => p.method)).toEqual(["native", "ocr", "native", "ocr"]);
  });

  it("many scanned pages go in page-selected batches", async () => {
    const { provider, calls } = fakeOcr();
    await run(pdf(Array(20).fill(null)), provider);
    expect(calls.map((c) => c!.length)).toEqual([EXTRACTION_LIMITS.ocrBatchPages, 5]);
  });

  it("past the page budget, the rest is reported unread — never as empty", async () => {
    const { provider } = fakeOcr();
    const x = await run(pdf([null, null, null, null]), provider, 2);
    expect(x.ocrPages).toEqual([1, 2]);
    expect(x.unreadPages).toEqual([3, 4]);
    expect(extractionText(x)).not.toContain("page 3");
  });

  it("without an OCR engine, a scanned PDF says why it can't be read", async () => {
    const x = await run(pdf([null]), null);
    expect(x.warnings).toContain("ocr_unavailable");
    expect(unreadableReason(x).message).toMatch(/scanned.*OCR/i);
  });

  it("a blank PDF: read with OCR, nothing found — a real reason, not a guess", async () => {
    const { provider } = fakeOcr({ blank: true });
    const x = await run(pdf([null]), provider);
    expect(x.ocrPages).toEqual([1]);
    expect(unreadableReason(x).message).toMatch(/even with text recognition/);
  });

  it("a corrupt PDF needs attention (no retry loop)", async () => {
    await expect(run(new TextEncoder().encode("%PDF-1.4 garbage"), null)).rejects.toMatchObject({
      details: { knowledge: "needs_attention", reason: "corrupt" },
    });
  });

  it("an image is one page, read with OCR", async () => {
    const { provider, calls } = fakeOcr();
    const x = await run(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), provider, 500, "image/png");
    expect(calls).toEqual([null]);
    expect(x.pages).toEqual([
      { page: 1, text: "Scanned text of page 1, recognized faithfully.", method: "ocr" },
    ]);
  });

  it("a provider failure surfaces (the job retries), after saving the batches already read", async () => {
    const { provider } = fakeOcr({ failOnCall: 2 });
    const saved: number[][] = [];
    await expect(
      extractFile(
        { data: pdf(Array(20).fill(null)), mimeType: "application/pdf" },
        { ocr: provider, maxOcrPages: 500, onProgress: (x) => void saved.push(x.ocrPages) },
      ),
    ).rejects.toThrow("provider down");
    expect(saved).toEqual([Array.from({ length: 15 }, (_, i) => i + 1)]);
  });

  it("a retry reuses the pages already read and only OCRs the rest", async () => {
    const { provider, calls } = fakeOcr();
    const known = new Map(Array.from({ length: 15 }, (_, i) => [i + 1, `old ${i + 1}`] as const));
    const x = await extractFile(
      { data: pdf(Array(20).fill(null)), mimeType: "application/pdf" },
      { ocr: provider, maxOcrPages: 500, known },
    );
    expect(calls).toEqual([[16, 17, 18, 19, 20]]);
    expect(x.pages[0]!.text).toBe("old 1");
    expect(x.unreadPages).toEqual([]);
  });
});

describe("Document AI response", () => {
  it("rebuilds each page's text from its layout anchors (int64 strings)", () => {
    const text = "Hola mundo\nSegunda página\n";
    expect(
      pagesFromDocument({
        text,
        pages: [
          { pageNumber: 2, layout: { textAnchor: { textSegments: [{ endIndex: "11" }] } } },
          {
            pageNumber: 4,
            layout: { textAnchor: { textSegments: [{ startIndex: "11", endIndex: "26" }] } },
          },
        ],
      }),
    ).toEqual([
      { page: 2, text: "Hola mundo\n" },
      { page: 4, text: "Segunda página\n" },
    ]);
  });
});
