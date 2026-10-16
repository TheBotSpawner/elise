import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import readXlsxFile from "read-excel-file/node";

import { AppError } from "@/core/errors";
import { MAX_FINANCE_IMPORT_ROWS, parseCsv, type Cell } from "@/core/finance/import";

/**
 * Tabular files → text cells for Core. XLSX numbers keep the exact digits stored in the file
 * (no float round trip); date cells become ISO dates. Legacy .xls isn't supported (save as
 * .xlsx or CSV). Macros and formulas are never run: only stored values are read.
 */

export interface ParsedSheet {
  name: string;
  rows: Cell[][];
}

export type SpreadsheetKind = "csv" | "xlsx";

export function spreadsheetKind(
  fileName: string,
  mimeType?: string | null,
): SpreadsheetKind | null {
  const name = fileName.toLowerCase();
  if (name.endsWith(".xlsx") || mimeType?.includes("spreadsheetml")) return "xlsx";
  if (
    name.endsWith(".csv") ||
    name.endsWith(".tsv") ||
    name.endsWith(".txt") ||
    mimeType === "text/csv"
  )
    return "csv";
  return null;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Spreadsheets exported on Windows are often Latin-1 / Windows-1252.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function cellText(value: unknown): Cell {
  if (value === null || value === undefined) return "";
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value).trim();
}

function limit(rows: Cell[][]): Cell[][] {
  if (rows.length > MAX_FINANCE_IMPORT_ROWS + 50) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This file has more than ${MAX_FINANCE_IMPORT_ROWS.toLocaleString("en-US")} rows. Split it and import each part.`,
      { recovery: "review" },
    );
  }
  return rows;
}

const unreadable = (cause?: unknown) =>
  new AppError("VALIDATION_ERROR", "This doesn't look like a readable .xlsx file", {
    recovery: "review",
    cause,
  });

/**
 * The workbook as a plain, standard zip the reader understands (ADR-073). Exports from phone
 * apps stream their zip (data descriptors, zip64 headers) and write emoji as numeric character
 * references (`&#x1f35c;`) that the reader truncates to 16 bits ("🍜" U+1F35C becomes U+F35C). Reading the
 * central directory and spelling those characters out fixes both, without touching any value.
 * A password-protected workbook (an OLE container, like legacy .xls) is refused clearly.
 */
export function normalizeXlsx(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    throw new AppError(
      "VALIDATION_ERROR",
      "This workbook is password-protected or an old .xls: save it as .xlsx or CSV without a password",
      { recovery: "review" },
    );
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw unreadable(error);
  }
  for (const [name, data] of Object.entries(files)) {
    if (!/^xl\/(sharedStrings|worksheets\/[^/]+)\.xml$/.test(name)) continue;
    const xml = strFromU8(data);
    const fixed = xml.replace(/&#(x[0-9a-fA-F]{5,6}|\d{5,7});/g, (ref, code: string) => {
      const cp = code.startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
      return cp > 0xffff && cp <= 0x10ffff ? String.fromCodePoint(cp) : ref;
    });
    if (fixed !== xml) files[name] = strToU8(fixed);
  }
  return zipSync(files);
}

export async function parseSpreadsheet(
  bytes: Uint8Array,
  kind: SpreadsheetKind,
): Promise<ParsedSheet[]> {
  if (kind === "csv") return [{ name: "CSV", rows: limit(parseCsv(decodeText(bytes))) }];
  const workbook = normalizeXlsx(bytes);
  try {
    const sheets = await readXlsxFile(Buffer.from(workbook), {
      // Keep numbers as the exact text stored in the file.
      parseNumber: (s: string) => s,
    });
    return sheets.map((s) => ({
      name: s.sheet,
      rows: limit(
        s.data.map((row) => row.map(cellText)).filter((row) => row.some((c) => c !== "")),
      ),
    }));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unreadable(error);
  }
}
