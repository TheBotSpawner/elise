import readXlsxFile from "read-excel-file/node";

import { AppError } from "@/core/errors";
import { MAX_FINANCE_IMPORT_ROWS, parseCsv, type Cell } from "@/core/finance/import";

/**
 * Tabular files → text cells for Core. XLSX numbers keep the exact digits stored in the file
 * (no float round trip); date cells become ISO dates. Legacy .xls isn't supported (save as
 * .xlsx or CSV).
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

export async function parseSpreadsheet(
  bytes: Uint8Array,
  kind: SpreadsheetKind,
): Promise<ParsedSheet[]> {
  if (kind === "csv") return [{ name: "CSV", rows: limit(parseCsv(decodeText(bytes))) }];
  try {
    const sheets = await readXlsxFile(Buffer.from(bytes), {
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
    throw new AppError("VALIDATION_ERROR", "This doesn't look like a readable .xlsx file", {
      recovery: "review",
      cause: error,
    });
  }
}
