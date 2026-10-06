import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { chunkDocument } from "@/core/knowledge/chunking";
import {
  ingestVersion,
  type IngestionPorts,
  type IngestionStore,
  type VersionToIngest,
} from "@/core/knowledge/ingest";
import {
  canMove,
  retryDelayMinutes,
  runStalled,
  sourcePhase,
  sourceState,
  SOURCE_LIFECYCLE,
} from "@/core/knowledge/source-state";
import { syncSource, type SyncPorts, type SyncStore } from "@/core/knowledge/sync";
import { UPLOAD_ACCEPT } from "@/features/knowledge/constants";
import {
  contentMatchesType,
  decodeText,
  isNeedsAttention,
  isTextFormat,
  parseDocument,
  SUPPORTED_UPLOADS,
} from "@/infrastructure/knowledge/parsers";
import { isSupportedDriveFile } from "@/infrastructure/providers/google/drive";

/** ADR-036: ingestion that can't hang silently, and every document format ELISE accepts. */

const NOW = new Date("2026-10-04T15:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const counts = (ready: number, processing = 0) => ({ ready, processing, attention: 0 });

describe("source lifecycle (the observed Notion case)", () => {
  it("a retry after a stalled first sync says 'retrying', not 'preparing'", () => {
    const queued = { status: "queued" as const, createdAt: ago(1), startedAt: null };
    const base = { lastSyncedAt: null, activeRun: queued, counts: counts(0) };
    expect(sourceState({ ...base, status: "needs_attention" }, NOW)).toBe("retrying");
    expect(sourceState({ ...base, status: "idle" }, NOW)).toBe("preparing");
  });

  it("a dispatched sync nobody starts is stalled within minutes, not 40", () => {
    const run = { status: "queued" as const, createdAt: ago(6), startedAt: null };
    expect(SOURCE_LIFECYCLE.queuedStallMinutes).toBeLessThanOrEqual(5);
    expect(runStalled(run, NOW)).toBe(true);
    expect(
      sourceState({ status: "idle", lastSyncedAt: null, activeRun: run, counts: counts(0) }, NOW),
    ).toBe("needs_attention");
  });

  it("a running sync lives by its heartbeat (the lease), not by when it started", () => {
    const run = { status: "running" as const, createdAt: ago(12), startedAt: ago(12) };
    expect(runStalled({ ...run, heartbeatAt: ago(1) }, NOW)).toBe(false);
    expect(runStalled({ ...run, heartbeatAt: ago(9) }, NOW)).toBe(true);
    // No heartbeat column yet: the old fixed limit.
    expect(runStalled(run, NOW)).toBe(false);
  });

  it("automatic retries back off exponentially and stop growing at a day", () => {
    expect([1, 2, 3, 4].map(retryDelayMinutes)).toEqual([15, 30, 60, 120]);
    expect(retryDelayMinutes(30)).toBe(24 * 60);
    expect(retryDelayMinutes(0)).toBe(15);
  });

  it("the phase under a working source: its run first, then its furthest document", () => {
    const run = { status: "queued" as const, createdAt: ago(0), startedAt: null };
    expect(sourcePhase(run, [])).toBe("queued");
    expect(sourcePhase({ ...run, status: "running", startedAt: ago(0) }, [])).toBe("discovering");
    expect(sourcePhase(null, [null, "reading", "ocr"])).toBe("ocr");
    expect(sourcePhase(null, [null])).toBe("queued");
    expect(sourcePhase(null, [])).toBeNull();
  });
});

describe("ingestion state machine", () => {
  it("only legal edges: no skipping to indexing from the queue, no resurrecting 'ready'", () => {
    expect(canMove("queued", "reading")).toBe(true);
    expect(canMove("queued", "indexing")).toBe(false);
    expect(canMove("reading", "ocr")).toBe(false);
    expect(canMove("extracting", "ocr")).toBe(true);
    expect(canMove("ocr", "ocr")).toBe(true); // one beat per OCR batch
    expect(canMove("ready", "indexing")).toBe(false);
    expect(canMove("failed", "queued")).toBe(true); // retry
  });

  const version: VersionToIngest = {
    versionId: "v1",
    itemId: "i1",
    workspaceId: "ws",
    spaceId: "s",
    sourceId: "src",
    versionNumber: 1,
    title: "Scan",
    sourceType: "upload",
    itemType: "file",
    externalId: "x",
    connectionId: null,
    storagePath: "p",
    mimeType: "application/pdf",
    status: "pending",
  };
  function ports(fetch: IngestionPorts["fetcher"]["fetch"]) {
    const phases: string[] = [];
    const failed: { code: string }[] = [];
    const store = {
      loadVersion: async () => ({ ...version }),
      currentVersion: async () => null,
      markProcessing: async (_v: unknown, p: string) => void phases.push(p),
      markUnchanged: async () => undefined,
      activate: async () => undefined,
      markFailed: async (_v: unknown, f: { code: string }) => void failed.push(f),
    } as unknown as IngestionStore;
    const p: IngestionPorts = {
      store,
      fetcher: { fetch },
      embeddings: () => ({ model: "m", dimensions: 2, embed: async (t) => t.map(() => [0, 1]) }),
      parserVersion: "t",
      isNeedsAttention: () => false,
    };
    return { p, phases, failed };
  }

  it("every phase is recorded in order — each one is also the job's heartbeat", async () => {
    const { p, phases } = ports(async (_v, progress) => {
      await progress("extracting");
      await progress("ocr");
      await progress("ocr");
      return {
        doc: { title: "Scan", sections: [{ headingPath: [], page: 1, blocks: ["Texto leído."] }] },
      };
    });
    expect(await ingestVersion(p, { workspaceId: "ws", versionId: "v1", attempt: 3 })).toBe(
      "ready",
    );
    expect(phases).toEqual(["reading", "extracting", "ocr", "ocr", "indexing"]);
  });

  it("an illegal step fails the version instead of corrupting its state", async () => {
    const { p, failed } = ports(async (_v, progress) => {
      await progress("ocr"); // OCR before the bytes were extracted
      return { doc: { title: "x", sections: [] } };
    });
    expect(await ingestVersion(p, { workspaceId: "ws", versionId: "v1", attempt: 3 })).toBe(
      "failed",
    );
    expect(failed[0]!.code).toBe("INTERNAL_ERROR");
  });
});

describe("sync heartbeat", () => {
  it("a long listing beats while it creates items, so it isn't taken for dead", async () => {
    const heartbeat = vi.fn(async () => undefined);
    const store = {
      loadRun: async () => ({
        run: { id: "r", workspaceId: "w", sourceId: "s", status: "queued" },
        source: {
          id: "s",
          workspaceId: "w",
          spaceId: "sp",
          sourceType: "notion",
          connectionId: "c",
          configuration: {},
        },
      }),
      markRunning: async () => undefined,
      heartbeat,
      knownItems: async () => [],
      catalogItem: async () => undefined,
      updateCatalogItem: vi.fn(),
      markRemoved: vi.fn(),
      finish: vi.fn(),
    } as unknown as SyncStore;
    const items = Array.from({ length: 60 }, (_, i) => ({
      externalId: `p${i}`,
      title: `Page ${i}`,
      itemType: "notion_page" as const,
      mimeType: null,
      url: null,
      modifiedAt: null,
      revision: "1",
      path: [],
    }));
    const ports: SyncPorts = {
      store,
      lister: { list: async () => ({ items }) },
      now: () => NOW,
    };
    expect(await syncSource(ports, { workspaceId: "w", syncRunId: "r" })).toMatchObject({
      created: 60,
    });
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("a source with nothing in it is ready, not stuck", async () => {
    const finish = vi.fn();
    const store = {
      loadRun: async () => ({
        run: { id: "r", workspaceId: "w", sourceId: "s", status: "queued" },
        source: { id: "s", workspaceId: "w", spaceId: "sp", sourceType: "notion" },
      }),
      markRunning: async () => undefined,
      knownItems: async () => [],
      finish,
    } as unknown as SyncStore;
    await syncSource(
      {
        store,
        lister: { list: async () => ({ items: [] }) },
        now: () => NOW,
      },
      { workspaceId: "w", syncRunId: "r" },
    );
    expect(finish.mock.calls[0]![2]).toMatchObject({ status: "completed", sourceStatus: "ready" });
  });
});

// ── Formats ────────────────────────────────────────────────────────────────

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (mimeType: string, data: Uint8Array, title = "doc") =>
  parseDocument({ title, mimeType, data });
const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function docx(body: string) {
  const rel = (type: string, target: string) =>
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("officeDocument", "word/document.xml")}</Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("styles", "styles.xml")}</Relationships>`,
    ),
    "word/styles.xml": strToU8(
      `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ),
  });
}
const wp = (text: string, style = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

function pptx(slides: [string, string[], string?][]) {
  const files: Record<string, Uint8Array> = {
    "ppt/presentation.xml": strToU8(`<p:presentation/>`),
  };
  const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
  slides.forEach(([title, body, notes], i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${para(title)}</p:txBody></p:sp><p:sp><p:txBody>${body.map(para).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    if (notes)
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = strToU8(
        `<p:notes>${para(notes)}${para(String(i + 1))}</p:notes>`,
      );
  });
  return zipSync(files);
}

function xlsx(sheets: [string, string[][]][]) {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  sheets.forEach(([, rows], i) => {
    const cells = rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`,
      )
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`,
    );
  });
  return zipSync(files);
}

describe("document formats", () => {
  it("Markdown: a short note is a document; headings and lists kept; front matter dropped", async () => {
    expect((await parse("text/markdown", enc("# Hola\n\nNota."))).sections[0]).toMatchObject({
      headingPath: ["Hola"],
      blocks: ["Nota."],
    });
    const doc = await parse(
      "text/markdown",
      enc(
        "---\ntags: [x]\n---\n# Plan\n\n- uno\n- dos\n\n## Fechas\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      ),
    );
    expect(doc.sections.map((s) => s.headingPath)).toEqual([["Plan"], ["Plan", "Fechas"]]);
    expect(doc.sections[0]!.blocks[0]).toBe("- uno\n- dos");
    expect(JSON.stringify(doc)).not.toContain("tags");
  });

  it("TXT in UTF-8 (BOM), UTF-16 and Windows-1252 all read correctly", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("año")]))).toBe("año");
    const utf16 = new Uint8Array([0xff, 0xfe, ...[..."año"].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(decodeText(utf16)).toBe("año");
    expect(contentMatchesType("text/plain", utf16)).toBe(true);
    expect(decodeText(new Uint8Array([0x61, 0xf1, 0x6f]))).toBe("año"); // Latin-1 "año"
  });

  it("DOCX keeps headings, lists and tables", async () => {
    const doc = await parse(
      MIME.docx,
      docx(
        wp("Contrato", "Heading1") +
          wp("Plazo de 48 horas.") +
          `<w:tbl><w:tr><w:tc>${wp("Cliente")}</w:tc><w:tc>${wp("Acme")}</w:tc></w:tr></w:tbl>`,
      ),
    );
    expect(doc.sections[0]!.headingPath).toEqual(["Contrato"]);
    expect(doc.sections[0]!.blocks).toEqual(["Plazo de 48 horas.", "Cliente | Acme"]);
  });

  it("HTML: headings kept; scripts, styles, navigation and footers removed", async () => {
    const doc = await parse(
      "text/html",
      enc(
        `<html><head><style>p{}</style></head><body><nav><a>Inicio</a></nav><script>alert(1)</script><h1>Guía</h1><p>Paso uno &amp; dos.</p><ul><li>Item</li></ul><footer>© 2026</footer></body></html>`,
      ),
    );
    expect(doc.sections).toEqual([
      { headingPath: ["Guía"], page: null, blocks: ["Paso uno & dos.", "• Item"] },
    ]);
  });

  it("XLSX: every sheet, every row with its column names and its cell", async () => {
    const doc = await parse(
      MIME.xlsx,
      xlsx([
        [
          "Clientes",
          [
            ["Nombre", "Estado"],
            ["Initech", "Activo"],
          ],
        ],
        [
          "Pagos",
          [
            ["Mes", "Monto"],
            ["Enero", "100"],
          ],
        ],
      ]),
    );
    expect(doc.sections.map((s) => [s.headingPath, s.blocks])).toEqual([
      [["Clientes"], ["[Clientes!A2] Nombre: Initech; Estado: Activo"]],
      [["Pagos"], ["[Pagos!A2] Mes: Enero; Monto: 100"]],
    ]);
  });

  it("PPTX: one section per slide, in order, with speaker notes", async () => {
    const doc = await parse(
      MIME.pptx,
      pptx(
        Array.from({ length: 11 }, (_, i) => [
          `Título ${i + 1}`,
          [`Punto ${i + 1}`],
          i === 0 ? "Decir esto" : undefined,
        ]),
      ),
    );
    expect(doc.sections).toHaveLength(11);
    expect(doc.sections[0]).toEqual({
      headingPath: ["Slide 1 · Título 1"],
      page: 1,
      blocks: ["Punto 1", "Notes: Decir esto"],
    });
    expect(doc.sections[10]!.page).toBe(11); // slide10 sorts after slide9, not after slide1
    expect(chunkDocument(doc)[0]!.headingPath).toEqual(["Slide 1 · Título 1"]);
  });

  it("validates real bytes: a renamed file, an XLSX posing as DOCX, an unknown type", async () => {
    for (const [mime, data] of [
      ["application/pdf", enc("<html>not a pdf</html>")],
      [MIME.docx, xlsx([["A", [["x"], ["y"]]]])],
      [MIME.pptx, enc("plain text")],
      ["application/zip", new Uint8Array([0x50, 0x4b, 3, 4])],
    ] as const)
      await expect(parse(mime, data)).rejects.toSatisfy(isNeedsAttention);
    await expect(parse("application/zip", enc("PK"))).rejects.toMatchObject({
      details: { reason: "unsupported" },
    });
  });

  it("one registry: uploads, the file picker and Drive accept the same formats", () => {
    expect(
      UPLOAD_ACCEPT.split(",")
        .map((e) => e.slice(1))
        .sort(),
    ).toEqual(Object.keys(SUPPORTED_UPLOADS).sort());
    for (const m of [MIME.xlsx, MIME.pptx, "text/html"]) expect(isSupportedDriveFile(m)).toBe(true);
    expect(isSupportedDriveFile("image/jpeg")).toBe(false); // photo folders aren't OCR'd
    expect(isTextFormat("text/markdown")).toBe(true);
    expect(isTextFormat("application/pdf")).toBe(false);
  });
});
