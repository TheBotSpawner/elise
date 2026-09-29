import "server-only";

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

import { AppError } from "@/core/errors";
import type { DocumentSection, NormalizedDocument } from "@/core/knowledge/model";

/**
 * Text extraction into ELISE's normalized document (docs/architecture/09 §25-26). Structure is
 * kept where the format has it: headings (Markdown, DOCX, Google Docs), pages (PDF), rows (CSV).
 * Nothing embedded in a document is ever executed; formats we cannot read are refused.
 */
export const PARSER_VERSION = "parsers-v1";

export const UPLOAD_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxFilesPerBatch: 20,
} as const;

/** Allowed uploads by extension → canonical MIME type. */
export const SUPPORTED_UPLOADS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
};

export function uploadMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return SUPPORTED_UPLOADS[ext] ?? null;
}

/** Too little text for the file's size: likely scanned images, which need OCR we don't run. */
const MIN_TEXT_CHARS = 40;

function needsAttention(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, {
    recovery: "review",
    details: { knowledge: "needs_attention" },
  });
}

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

  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
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

/** CSV as knowledge: each row keeps its column names so a passage stands on its own. */
export function parseCsv(title: string, text: string): NormalizedDocument {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim()));
  const [header, ...body] = rows;
  if (!header) return { title, sections: [] };
  const blocks = body.map((row) =>
    row
      .map((cell, i) =>
        cell.trim() ? `${header[i]?.trim() || `Column ${i + 1}`}: ${cell.trim()}` : "",
      )
      .filter(Boolean)
      .join("; "),
  );
  return { title, sections: [{ headingPath: [], page: null, blocks: blocks.filter(Boolean) }] };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const decodeEntities = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** DOCX via mammoth's semantic HTML: headings, paragraphs, list items and table rows. */
export async function parseDocx(title: string, buffer: Buffer): Promise<NormalizedDocument> {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const sections: DocumentSection[] = [];
  const path: string[] = [];
  let current: DocumentSection = { headingPath: [], page: null, blocks: [] };
  const tokens = html.match(/<(h[1-6]|p|li|tr)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
  for (const token of tokens) {
    const tag = /^<(\w+)/.exec(token)![1]!;
    if (tag === "tr") {
      const cells = (token.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(decodeEntities);
      const text = cells.filter(Boolean).join(" | ");
      if (text) current.blocks.push(text);
      continue;
    }
    const text = decodeEntities(token);
    if (!text) continue;
    if (tag.startsWith("h")) {
      if (current.blocks.length) sections.push(current);
      const level = Number(tag[1]);
      path.length = Math.min(path.length, level - 1);
      path[level - 1] = text;
      current = { headingPath: path.filter(Boolean), page: null, blocks: [] };
    } else if (!/<t[dh]\b/.test(token)) {
      current.blocks.push(tag === "li" ? `• ${text}` : text);
    }
  }
  if (current.blocks.length) sections.push(current);
  return { title, sections };
}

/** PDF text per page (no OCR): pages become sections so citations can say "page 4". */
export async function parsePdf(title: string, data: Uint8Array): Promise<NormalizedDocument> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  const sections = text.map((pageText, i) => {
    // PDF text often breaks every line; rebuild paragraphs from sentence endings.
    const blocks = paragraphs(pageText.replace(/([^.!?:;\n])\n(?=\S)/g, "$1 "));
    return { headingPath: [], page: i + 1, blocks };
  });
  return { title, sections };
}

export async function parseDocument(input: {
  title: string;
  mimeType: string;
  data: Uint8Array;
}): Promise<NormalizedDocument> {
  const text = () => new TextDecoder("utf-8").decode(input.data);
  let doc: NormalizedDocument;
  try {
    switch (input.mimeType) {
      case "application/pdf":
        doc = await parsePdf(input.title, input.data);
        break;
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        doc = await parseDocx(input.title, Buffer.from(input.data));
        break;
      case "text/markdown":
        doc = parseMarkdown(input.title, text());
        break;
      case "text/csv":
        doc = parseCsv(input.title, text());
        break;
      case "text/plain":
        doc = parsePlainText(input.title, text());
        break;
      default:
        throw needsAttention("ELISE can't read this file type yet");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw needsAttention("The file could not be read (damaged or protected?)");
  }
  const chars = doc.sections.reduce((n, s) => n + s.blocks.join("").length, 0);
  if (chars < MIN_TEXT_CHARS) {
    throw needsAttention(
      input.mimeType === "application/pdf"
        ? "This PDF has no readable text (it may be scanned images)"
        : "This file has no readable text",
    );
  }
  return doc;
}

export function isNeedsAttention(error: unknown): boolean {
  return error instanceof AppError && error.details?.knowledge === "needs_attention";
}
