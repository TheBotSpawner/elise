import { AppError } from "@/core/errors";
import type { KnowledgeItemType } from "@/core/knowledge/model";
import type { ExternalItem } from "@/core/knowledge/sync";
import { EXTRACTORS } from "@/infrastructure/knowledge/parsers";

import type { GoogleHttp } from "./http";

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,modifiedTime,version,webViewLink,size,trashed";
const MAX_DEPTH = 6;
export const MAX_DRIVE_BYTES = 25 * 1024 * 1024;

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  version?: string;
  webViewLink?: string;
  size?: string;
  trashed?: boolean;
}

/**
 * What ELISE can understand from Drive, and how to read it: Google-native files are exported
 * as text (Docs → Markdown keeps headings, Sheets → CSV, Slides → text); regular files are
 * downloaded as-is and parsed like uploads. Anything else is skipped.
 */
const NATIVE: Record<string, { itemType: KnowledgeItemType; exportAs: string; parseAs: string }> = {
  "application/vnd.google-apps.document": {
    itemType: "google_doc",
    exportAs: "text/markdown",
    parseAs: "text/markdown",
  },
  "application/vnd.google-apps.spreadsheet": {
    itemType: "google_sheet",
    exportAs: "text/csv",
    parseAs: "text/csv",
  },
  "application/vnd.google-apps.presentation": {
    itemType: "google_slides",
    exportAs: "text/plain",
    parseAs: "text/plain",
  },
};
/**
 * Ordinary files ELISE can read: the same extractor registry as uploads. Images are left out —
 * a synced photo folder would be OCR'd picture by picture; a scan the user wants is uploaded.
 */
const FILES = new Set(EXTRACTORS.filter((e) => e.parse).flatMap((e) => e.mimeTypes));

export function isSupportedDriveFile(mimeType: string): boolean {
  return mimeType in NATIVE || FILES.has(mimeType);
}

export function toExternalItem(file: GDriveFile, path: string[]): ExternalItem | null {
  if (!isSupportedDriveFile(file.mimeType) || file.trashed) return null;
  return {
    externalId: file.id,
    title: file.name,
    itemType: NATIVE[file.mimeType]?.itemType ?? "drive_file",
    mimeType: file.mimeType,
    url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    modifiedAt: file.modifiedTime ?? null,
    // Drive's `version` increases on every change; modifiedTime is the fallback.
    revision: file.version ?? file.modifiedTime ?? "",
    path,
  };
}

export interface DriveSelection {
  id: string;
  kind: "folder" | "file";
  name: string;
}

/** Read-only Google Drive access for Knowledge (scope drive.readonly). */
export class GoogleDriveClient {
  constructor(private readonly http: GoogleHttp) {}

  private async listChildren(folderId: string): Promise<GDriveFile[]> {
    const out: GDriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "200",
        orderBy: "folder,name",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.http.request<{ files?: GDriveFile[]; nextPageToken?: string }>(
        "GET",
        `${API}/files?${params}`,
      );
      out.push(...(page?.files ?? []));
      pageToken = page?.nextPageToken;
    } while (pageToken && out.length < 1000);
    return out;
  }

  /** One level of a folder, for the picker ("root" = My Drive). */
  async browse(folderId: string): Promise<{ folders: GDriveFile[]; files: GDriveFile[] }> {
    const children = await this.listChildren(folderId || "root");
    return {
      folders: children.filter((f) => f.mimeType === FOLDER),
      files: children.filter((f) => isSupportedDriveFile(f.mimeType)),
    };
  }

  async file(fileId: string): Promise<GDriveFile | null> {
    return this.http.request<GDriveFile>(
      "GET",
      `${API}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}&supportsAllDrives=true`,
      undefined,
      { notFoundAsNull: true },
    );
  }

  /**
   * Drive's own search inside what the user connected (ADR-046): files directly in any of
   * `folderIds` (the selected folder and its subfolders, from the catalog), matching the terms
   * by name or by Drive's full-text index. Newest first when asked for the latest, or when there
   * is nothing to match; otherwise Drive's relevance. Metadata only — nothing is downloaded.
   */
  async search(q: {
    folderIds: readonly string[];
    terms: readonly string[];
    recent: boolean;
    limit: number;
  }): Promise<GDriveFile[]> {
    const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    const terms = q.terms
      .map((t) =>
        q.recent
          ? `name contains ${quote(t)}`
          : `(name contains ${quote(t)} or fullText contains ${quote(t)})`,
      )
      .join(" or ");
    const out = new Map<string, GDriveFile>();
    // Long OR chains of parents are split: Drive limits the query's size.
    for (let i = 0; i < q.folderIds.length && i < 60; i += 20) {
      const parents = q.folderIds
        .slice(i, i + 20)
        .map((id) => `${quote(id)} in parents`)
        .join(" or ");
      const params = new URLSearchParams({
        q: `trashed = false and mimeType != '${FOLDER}' and (${parents})${terms ? ` and (${terms})` : ""}`,
        fields: `files(${FIELDS})`,
        pageSize: String(Math.min(q.limit * 2, 50)),
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        corpora: "allDrives",
        ...(q.recent || !terms ? { orderBy: "modifiedTime desc" } : {}),
      });
      const page = await this.http.request<{ files?: GDriveFile[] }>(
        "GET",
        `${API}/files?${params}`,
      );
      for (const f of page?.files ?? []) if (isSupportedDriveFile(f.mimeType)) out.set(f.id, f);
    }
    const files = [...out.values()];
    if (q.recent || !terms)
      files.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
    return files.slice(0, q.limit);
  }

  /** Every supported file under the user's selection (folders recursively). */
  async listSelection(
    selection: readonly DriveSelection[],
    limit: number,
  ): Promise<ExternalItem[]> {
    return (await this.catalog(selection, limit)).items;
  }

  /**
   * The catalog of a selection: its files' metadata and every folder in it (the scope live
   * search is allowed to look in). Never the files' content.
   */
  async catalog(
    selection: readonly DriveSelection[],
    limit: number,
  ): Promise<{ items: ExternalItem[]; folderIds: string[] }> {
    const items = new Map<string, ExternalItem>();
    // A folder reachable twice (selected twice, or nested inside another selection) is read once.
    const visited = new Set<string>();
    const walk = async (folderId: string, path: string[], depth: number) => {
      if (depth > MAX_DEPTH || items.size >= limit || visited.has(folderId)) return;
      visited.add(folderId);
      for (const child of await this.listChildren(folderId)) {
        if (items.size >= limit) return;
        if (child.mimeType === FOLDER) await walk(child.id, [...path, child.name], depth + 1);
        else {
          const item = toExternalItem(child, path);
          if (item) items.set(item.externalId, item);
        }
      }
    };
    for (const root of selection) {
      if (root.kind === "folder") await walk(root.id, [root.name], 0);
      else {
        const file = await this.file(root.id);
        const item = file ? toExternalItem(file, []) : null;
        if (item) items.set(item.externalId, item);
      }
    }
    return { items: [...items.values()], folderIds: [...visited] };
  }

  /** Content to parse: exported text for Google-native files, the original bytes otherwise. */
  async content(fileId: string, mimeType: string): Promise<{ data: Uint8Array; mimeType: string }> {
    const native = NATIVE[mimeType];
    if (native) {
      const url = `${API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(native.exportAs)}`;
      return { data: await this.http.download(url, MAX_DRIVE_BYTES), mimeType: native.parseAs };
    }
    if (!FILES.has(mimeType)) {
      throw new AppError("VALIDATION_ERROR", "ELISE can't read this file type yet", {
        details: { knowledge: "needs_attention" },
      });
    }
    const url = `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    return { data: await this.http.download(url, MAX_DRIVE_BYTES), mimeType };
  }
}
