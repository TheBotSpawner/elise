import { AppError } from "@/core/errors";
import { MAX_FINANCE_IMPORT_ROWS, type Cell } from "@/core/finance/import";

import type { GoogleHttp } from "./http";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

export interface SheetTab {
  sheetId: number;
  title: string;
  rows: number;
  columns: number;
}

export interface SpreadsheetInfo {
  id: string;
  title: string;
  tabs: SheetTab[];
}

/** Accepts a full Google Sheets link or a bare spreadsheet id. */
export function parseSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const fromUrl = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})/);
  if (fromUrl) return fromUrl[1]!;
  return /^[A-Za-z0-9_-]{20,200}$/.test(s) ? s : null;
}

/** Sheets API v4, read-only (scope spreadsheets.readonly). Values arrive unformatted. */
export class GoogleSheetsClient {
  constructor(private readonly http: GoogleHttp) {}

  async spreadsheet(id: string): Promise<SpreadsheetInfo> {
    const data = await this.http.request<{
      spreadsheetId: string;
      properties?: { title?: string };
      sheets?: {
        properties?: {
          sheetId?: number;
          title?: string;
          sheetType?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    }>(
      "GET",
      `${API}/${encodeURIComponent(id)}?fields=spreadsheetId,properties.title,sheets.properties`,
      undefined,
      { notFoundAsNull: true },
    );
    if (!data) {
      throw new AppError(
        "NOT_FOUND",
        "ELISE can't open that spreadsheet with this Google account",
        {
          recovery: "review",
        },
      );
    }
    return {
      id: data.spreadsheetId,
      title: data.properties?.title ?? "Spreadsheet",
      tabs: (data.sheets ?? [])
        .map((s) => s.properties ?? {})
        .filter((p) => (p.sheetType ?? "GRID") === "GRID" && p.title !== undefined)
        .map((p) => ({
          sheetId: p.sheetId ?? 0,
          title: p.title!,
          rows: p.gridProperties?.rowCount ?? 0,
          columns: p.gridProperties?.columnCount ?? 0,
        })),
    };
  }

  /**
   * Every value of one tab as text cells. UNFORMATTED_VALUE returns numbers as numbers (no
   * locale formatting to guess) and dates as serial numbers, which Core converts in date
   * columns only.
   */
  async values(id: string, tabTitle: string): Promise<Cell[][]> {
    const range = `'${tabTitle.replace(/'/g, "''")}'`;
    const data = await this.http.request<{ values?: unknown[][] }>(
      "GET",
      `${API}/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS`,
    );
    const rows = (data?.values ?? []).map((row) =>
      row.map((v) => (v === null || v === undefined ? "" : String(v).trim())),
    );
    if (rows.length > MAX_FINANCE_IMPORT_ROWS + 50) {
      throw new AppError("VALIDATION_ERROR", "This sheet is too large for ELISE Finance", {
        recovery: "review",
      });
    }
    return rows;
  }

  /**
   * Recent spreadsheets, only when the account also allowed Drive (Knowledge). Without Drive,
   * the user pastes the spreadsheet's link: ELISE never asks for more access than needed.
   */
  async recent(limit = 20): Promise<{ id: string; name: string; modifiedTime: string | null }[]> {
    const q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    );
    const data = await this.http.request<{
      files?: { id: string; name: string; modifiedTime?: string }[];
    }>(
      "GET",
      `${DRIVE}?q=${q}&orderBy=modifiedTime desc&pageSize=${limit}&fields=files(id,name,modifiedTime)`,
    );
    return (data?.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime ?? null,
    }));
  }
}
