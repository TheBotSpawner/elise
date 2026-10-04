import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OcrProvider } from "@/core/knowledge/extraction";

/**
 * One extraction per file content (ADR-035): a scanned PDF read for a chat turn is not OCR'd
 * again when it's saved to Knowledge; an interrupted OCR resumes; different bytes never share.
 */

type Row = Record<string, unknown>;
const table: Row[] = [];
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const filters: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({
          data: table.find((r) => filters.every(([k, v]) => r[k] === v)) ?? null,
        }),
        upsert: async (row: Row) => {
          const i = table.findIndex(
            (r) => r.workspace_id === row.workspace_id && r.content_hash === row.content_hash,
          );
          if (i >= 0) table[i] = { ...table[i], ...row };
          else table.push(row);
          return { error: null };
        },
      };
      return q;
    },
  }),
}));

const ocrCalls: (number[] | null)[] = [];
let failOn = 0;
const fake: OcrProvider = {
  id: "fake_ocr",
  async ocr({ pages }) {
    ocrCalls.push(pages);
    if (failOn && ocrCalls.length === failOn) throw new Error("provider down");
    return (pages ?? [1]).map((page) => ({
      page,
      text: `Scanned page ${page} with recognized words.`,
    }));
  },
};
vi.mock("@/infrastructure/ocr/google-document-ai", () => ({ getOcrProvider: () => fake }));

const { extractDocument, readDocument } = await import("@/application/extraction-service");

/** A minimal PDF of N pages without a text layer (scanned). */
function scanned(n: number, salt = ""): Uint8Array {
  const objs = ["", "", ...Array.from({ length: n }, () => "")];
  const kids: number[] = [];
  for (let i = 0; i < n; i++) {
    objs[2 + i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`;
    kids.push(3 + i);
  }
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${n} >>`;
  let out = `%PDF-1.4\n%${salt}\n`;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const WS = "ws-1";
beforeEach(() => {
  table.length = 0;
  ocrCalls.length = 0;
  failOn = 0;
});

describe("extraction reuse", () => {
  it("read in chat, saved to Knowledge: OCR runs once, the pages and their numbers are kept", async () => {
    const file = scanned(3);
    const chat = await extractDocument(
      WS,
      { data: file, mimeType: "application/pdf" },
      { purpose: "chat" },
    );
    expect(chat).toMatchObject({ reused: false, method: "ocr", ocrPages: [1, 2, 3] });
    expect(ocrCalls).toHaveLength(1);
    const doc = await readDocument(WS, {
      title: "chapter.pdf",
      mimeType: "application/pdf",
      data: file,
    });
    expect(ocrCalls).toHaveLength(1); // reused, not re-billed
    expect(doc.sections.map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it("different bytes (another version) are never served from the old result", async () => {
    await extractDocument(
      WS,
      { data: scanned(1, "v1"), mimeType: "application/pdf" },
      { purpose: "chat" },
    );
    await extractDocument(
      WS,
      { data: scanned(1, "v2"), mimeType: "application/pdf" },
      { purpose: "chat" },
    );
    expect(ocrCalls).toHaveLength(2);
    expect(new Set(table.map((r) => r.content_hash)).size).toBe(2);
  });

  it("another workspace never sees this one's extraction", async () => {
    const file = scanned(1);
    await extractDocument(WS, { data: file, mimeType: "application/pdf" }, { purpose: "chat" });
    await extractDocument("ws-2", { data: file, mimeType: "application/pdf" }, { purpose: "chat" });
    expect(ocrCalls).toHaveLength(2);
  });

  it("an OCR that stops at page 15 resumes at 16 — no duplicate pages, no double billing", async () => {
    const file = scanned(20);
    failOn = 2;
    await expect(
      readDocument(WS, { title: "book.pdf", mimeType: "application/pdf", data: file }),
    ).rejects.toThrow("provider down");
    expect(table[0]).toMatchObject({ complete: false, ocr_pages: 15 });
    failOn = 0;
    const doc = await readDocument(WS, {
      title: "book.pdf",
      mimeType: "application/pdf",
      data: file,
    });
    expect(ocrCalls.at(-1)).toEqual([16, 17, 18, 19, 20]);
    expect(doc.sections).toHaveLength(20);
    expect(table[0]).toMatchObject({ complete: true, method: "ocr", ocr_pages: 20 });
  });

  it("chat reads only a bounded number of scanned pages and names the rest as unread", async () => {
    const x = await extractDocument(
      WS,
      { data: scanned(20), mimeType: "application/pdf" },
      { purpose: "chat" },
    );
    expect(x.ocrPages).toHaveLength(15);
    expect(x.unreadPages).toEqual([16, 17, 18, 19, 20]);
    expect(table[0]).toMatchObject({ complete: false }); // Knowledge will finish it later
  });
});
