import "server-only";

import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";
import { extractText, getDocumentProxy } from "unpdf";

import { imageMatchesType } from "@/core/attachments/model";
import { AppError } from "@/core/errors";
import { parseCsv as csvRows } from "@/core/finance/import";
import type { DocumentSection, NormalizedDocument } from "@/core/knowledge/model";

/**
 * Text extraction into ELISE's normalized document (docs/architecture/09 §25-26, ADR-036).
 * One registry of extractors: each format declares its types, how its bytes are recognized
 * (never trust a name or a browser MIME type) and how it is read. Structure is kept where the
 * format has it: headings (Markdown, DOCX, HTML), pages (PDF), slides (PPTX), sheets and rows
 * (XLSX, CSV). Nothing embedded in a document is ever executed.
 */
export const PARSER_VERSION = "parsers-v2";

export const UPLOAD_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxFilesPerBatch: 20,
} as const;

/** Rows read from one spreadsheet into Knowledge (analysis of whole tables is Structured's job). */
const MAX_SHEET_ROWS = 5_000;

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
} as const;

export interface DocumentExtractor {
  id: string;
  mimeTypes: readonly string[];
  extensions: readonly string[];
  /** Do the bytes really look like this format? */
  matches(data: Uint8Array): boolean;
  /** Null: read through extraction with OCR (images), not here. */
  parse: ((title: string, data: Uint8Array) => Promise<NormalizedDocument>) | null;
}

function needsAttention(message: string, reason = "unreadable"): AppError {
  return new AppError("VALIDATION_ERROR", message, {
    recovery: "review",
    details: { knowledge: "needs_attention", reason },
  });
}

// ── Text ─────────────────────────────────────────────────────────────────────

/**
 * Text files as people really save them: UTF-8 (with or without BOM), UTF-16 with a BOM
 * (Windows Notepad "Unicode"), and Windows-1252 when the bytes aren't valid UTF-8.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

const isUtf16 = (d: Uint8Array) =>
  (d[0] === 0xff && d[1] === 0xfe) || (d[0] === 0xfe && d[1] === 0xff);
/** Text has no NUL bytes in its first 8 KB (UTF-16 has them by design, behind its BOM). */
const looksLikeText = (d: Uint8Array) => isUtf16(d) || !d.subarray(0, 8192).includes(0);

const paragraphs = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

export function parsePlainText(title: string, text: string): NormalizedDocument {
  return { title, sections: [{ headingPath: [], page: null, blocks: paragraphs(text) }] };
}

/** Markdown (and Google Docs exported as Markdown): headings become the section path. */
export function parseMarkdown(title: string, text: string): NormalizedDocument {
  const sections: DocumentSection[] = [];
  const path: string[] = [];
  let current: DocumentSection = { headingPath: [], page: null, blocks: [] };
  let paragraph: string[] = [];
  let fence = false;

  const endParagraph = () => {
    const p = paragraph.join("\n").trim();
    if (p) current.blocks.push(p);
    paragraph = [];
  };

  // Front matter (--- … ---) is metadata, not content.
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      paragraph.push(line);
      continue;
    }
    const heading = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      endParagraph();
      if (current.blocks.length) sections.push(current);
      const level = heading[1]!.length;
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = heading[2]!.replace(/[*_`]/g, "").trim();
      current = { headingPath: path.filter(Boolean), page: null, blocks: [] };
      continue;
    }
    if (!fence && !line.trim()) endParagraph();
    else paragraph.push(line);
  }
  endParagraph();
  if (current.blocks.length) sections.push(current);
  return { title, sections };
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Rows as passages that stand on their own: each value keeps its column name. */
function tableSection(
  rows: string[][],
  headingPath: string[],
  cellRef?: (row: number) => string,
): DocumentSection {
  const [header = [], ...body] = rows.filter((r) => r.some((c) => c.trim()));
  const blocks = body.slice(0, MAX_SHEET_ROWS).map((row, i) => {
    const line = row
      .map((cell, c) =>
        cell.trim() ? `${header[c]?.trim() || `Column ${c + 1}`}: ${cell.trim()}` : "",
      )
      .filter(Boolean)
      .join("; ");
    // The source row (header is row 1) so a passage can be traced back to its cells.
    return line && cellRef ? `[${cellRef(i + 2)}] ${line}` : line;
  });
  return { headingPath, page: null, blocks: blocks.filter(Boolean) };
}

/** CSV as knowledge: comma, semicolon or tab separated, each row with its column names. */
export function parseCsv(title: string, text: string): NormalizedDocument {
  const section = tableSection(csvRows(text), []);
  return { title, sections: section.blocks.length ? [section] : [] };
}

async function parseXlsx(title: string, data: Uint8Array): Promise<NormalizedDocument> {
  const sheets = await readXlsxFile(Buffer.from(data), { parseNumber: (s: string) => s });
  const cell = (v: unknown) =>
    v === null || v === undefined
      ? ""
      : v instanceof Date
        ? Number.isNaN(v.getTime())
          ? ""
          : v.toISOString().slice(0, 10)
        : String(v);
  return {
    title,
    // Sheet name as the section, the row as "Sheet!A12": citations point at real cells.
    sections: sheets
      .map((s) =>
        tableSection(
          s.data.map((row) => row.map(cell)),
          [s.sheet],
          (row) => `${s.sheet}!A${row}`,
        ),
      )
      .filter((s) => s.blocks.length),
  };
}

// ── HTML and DOCX (through mammoth's semantic HTML) ─────────────────────────

const decodeEntities = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Page chrome and code are not content: navigation, scripts, styles, forms, footers. */
const NOISE =
  /<(script|style|noscript|template|svg|nav|header|footer|aside|form|iframe|button|select)\b[\s\S]*?<\/\1>/gi;

/** Headings become the section path; paragraphs, list items and table rows become blocks. */
export function htmlToDocument(title: string, html: string): NormalizedDocument {
  const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(NOISE, "");
  const sections: DocumentSection[] = [];
  const path: string[] = [];
  let current: DocumentSection = { headingPath: [], page: null, blocks: [] };
  const tokens = body.match(/<(h[1-6]|p|li|tr|pre|blockquote|dt|dd)\b[^>]*>[\s\S]*?<\/\1>/gi);
  for (const token of tokens ?? []) {
    const tag = /^<(\w+)/.exec(token)![1]!.toLowerCase();
    if (tag === "tr") {
      const cells = (token.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(decodeEntities);
      const text = cells.filter(Boolean).join(" | ");
      if (text) current.blocks.push(text);
      continue;
    }
    const text = decodeEntities(token);
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      if (current.blocks.length) sections.push(current);
      const level = Number(tag[1]);
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = text;
      current = { headingPath: path.filter(Boolean), page: null, blocks: [] };
    } else if (!/<t[dh]\b/i.test(token)) {
      current.blocks.push(tag === "li" ? `• ${text}` : text);
    }
  }
  if (current.blocks.length) sections.push(current);
  // A page that keeps its text in bare <div>s: its visible text, as paragraphs.
  if (!sections.length) {
    const text = decodeEntities(
      body.replace(/<\/(div|section|article|br)\s*>|<br\s*\/?>/gi, "\n\n"),
    );
    if (text) return parsePlainText(title, text);
  }
  return { title, sections };
}

/** DOCX via mammoth's semantic HTML: headings, paragraphs, list items and table rows. */
export async function parseDocx(title: string, buffer: Buffer): Promise<NormalizedDocument> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  return htmlToDocument(title, html);
}

// ── PPTX ─────────────────────────────────────────────────────────────────────

/** Slides in order, one section each ("Slide 3 · Title"), speaker notes included. */
function parsePptx(title: string, data: Uint8Array): NormalizedDocument {
  const files = unzipSync(data, {
    filter: (f) => /^ppt\/(slides|notesSlides)\/\w+?\d+\.xml$/.test(f.name),
  });
  const num = (name: string) => Number(/(\d+)\.xml$/.exec(name)![1]);
  const paragraphsOf = (xml: string) =>
    (xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [])
      .map((p) => decodeEntities((p.match(/<a:t>[\s\S]*?<\/a:t>/g) ?? []).join("")))
      .filter(Boolean);
  const sections: DocumentSection[] = [];
  for (const name of Object.keys(files)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => num(a) - num(b))) {
    const n = num(name);
    const [heading, ...rest] = paragraphsOf(strFromU8(files[name]!));
    const notes = files[`ppt/notesSlides/notesSlide${n}.xml`];
    // Notes repeat the slide number as their last paragraph; keep only real sentences.
    const said = notes ? paragraphsOf(strFromU8(notes)).filter((p) => !/^\d+$/.test(p)) : [];
    const blocks = [...rest, ...said.map((p) => `Notes: ${p}`)];
    if (!heading && !blocks.length) continue;
    sections.push({
      headingPath: [heading ? `Slide ${n} · ${heading}` : `Slide ${n}`],
      page: n,
      blocks: blocks.length ? blocks : [heading!],
    });
  }
  return { title, sections };
}

// ── PDF (native text; scanned pages go through extraction + OCR) ────────────

export async function parsePdf(title: string, data: Uint8Array): Promise<NormalizedDocument> {
  const pdf = await getDocumentProxy(data.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  const sections = text.map((pageText, i) => {
    // PDF text often breaks every line; rebuild paragraphs from sentence endings.
    const blocks = paragraphs(pageText.replace(/([^.!?:;\n])\n(?=\S)/g, "$1 "));
    return { headingPath: [], page: i + 1, blocks };
  });
  return { title, sections };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const head = (d: Uint8Array, n: number) => String.fromCharCode(...d.subarray(0, n));
/**
 * An Office file is a ZIP that names its main part (word/, xl/, ppt/) in its entry headers:
 * the central directory at the end, and usually a local header near the start.
 */
const officeZip = (part: string) => (d: Uint8Array) => {
  if (!(d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04)) return false;
  const names = (from: number, to: number) =>
    new TextDecoder("latin1").decode(d.subarray(from, to)).includes(part);
  return names(Math.max(0, d.length - 262_144), d.length) || names(0, 65_536);
};
const text = (d: Uint8Array) => decodeText(d);

export const EXTRACTORS: readonly DocumentExtractor[] = [
  {
    id: "pdf",
    mimeTypes: [MIME.pdf],
    extensions: ["pdf"],
    matches: (d) => head(d, 1024).includes("%PDF-"),
    parse: (t, d) => parsePdf(t, d),
  },
  {
    id: "docx",
    mimeTypes: [MIME.docx],
    extensions: ["docx"],
    matches: officeZip("word/"),
    parse: (t, d) => parseDocx(t, Buffer.from(d)),
  },
  {
    id: "xlsx",
    mimeTypes: [MIME.xlsx],
    extensions: ["xlsx"],
    matches: officeZip("xl/"),
    parse: parseXlsx,
  },
  {
    id: "pptx",
    mimeTypes: [MIME.pptx],
    extensions: ["pptx"],
    matches: officeZip("ppt/"),
    parse: async (t, d) => parsePptx(t, d),
  },
  {
    id: "markdown",
    mimeTypes: [MIME.md],
    extensions: ["md", "markdown"],
    matches: looksLikeText,
    parse: async (t, d) => parseMarkdown(t, text(d)),
  },
  {
    id: "html",
    mimeTypes: [MIME.html],
    extensions: ["html", "htm"],
    matches: (d) => looksLikeText(d) && /<[a-z!]/i.test(text(d.subarray(0, 4096))),
    parse: async (t, d) => htmlToDocument(t, text(d)),
  },
  {
    id: "csv",
    mimeTypes: [MIME.csv],
    extensions: ["csv", "tsv"],
    matches: looksLikeText,
    parse: async (t, d) => parseCsv(t, text(d)),
  },
  {
    id: "text",
    mimeTypes: [MIME.txt],
    extensions: ["txt", "text"],
    matches: looksLikeText,
    parse: async (t, d) => parsePlainText(t, text(d)),
  },
  ...(
    [
      ["image/png", ["png"]],
      ["image/jpeg", ["jpg", "jpeg"]],
      ["image/webp", ["webp"]],
      ["image/gif", ["gif"]],
      ["image/tiff", ["tif", "tiff"]],
    ] as const
  ).map(([mime, extensions]): DocumentExtractor => ({
    id: mime,
    mimeTypes: [mime],
    extensions,
    matches: (d) =>
      mime === "image/tiff"
        ? head(d, 4) === "II*\0" || head(d, 4) === "MM\0*"
        : imageMatchesType(mime, d),
    // Images have no text layer: their text comes from OCR (extraction-service).
    parse: null,
  })),
];

export const extractorFor = (mimeType: string) =>
  EXTRACTORS.find((e) => e.mimeTypes.includes(mimeType)) ?? null;

/** Allowed uploads by extension → canonical MIME type. */
export const SUPPORTED_UPLOADS: Record<string, string> = Object.fromEntries(
  EXTRACTORS.flatMap((e) => e.extensions.map((ext) => [ext, e.mimeTypes[0]!])),
);

export function uploadMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return SUPPORTED_UPLOADS[ext] ?? null;
}

/** Text formats are read in milliseconds: they can be indexed right away, without a queue. */
export const isTextFormat = (mimeType: string) =>
  mimeType.startsWith("text/") && extractorFor(mimeType) !== null;

/**
 * Does the content look like the declared type? Upload names and browser MIME types are only
 * claims (the bucket also accepts application/octet-stream).
 */
export function contentMatchesType(mimeType: string, data: Uint8Array): boolean {
  return extractorFor(mimeType)?.matches(data) ?? false;
}

/** A supported type whose bytes really are that type; otherwise why not (Needs attention). */
export function checkContent(mimeType: string, data: Uint8Array): DocumentExtractor {
  const extractor = extractorFor(mimeType);
  if (!extractor) throw needsAttention("ELISE can't read this file type yet", "unsupported");
  if (!extractor.matches(data))
    throw needsAttention("This file's content doesn't match its type", "mismatch");
  return extractor;
}

export async function parseDocument(input: {
  title: string;
  mimeType: string;
  data: Uint8Array;
}): Promise<NormalizedDocument> {
  const extractor = checkContent(input.mimeType, input.data);
  if (!extractor.parse) throw needsAttention("ELISE can't read this file type yet", "unsupported");
  let doc: NormalizedDocument;
  try {
    doc = await extractor.parse(input.title, input.data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw needsAttention("The file could not be read (damaged or protected?)", "corrupt");
  }
  // Any real text is enough: a two-line note is a fine document.
  if (!doc.sections.some((s) => s.blocks.some((b) => /[\p{L}\p{N}]/u.test(b))))
    throw needsAttention("This file has no readable text", "no_text");
  return doc;
}

export function isNeedsAttention(error: unknown): boolean {
  return error instanceof AppError && error.details?.knowledge === "needs_attention";
}
