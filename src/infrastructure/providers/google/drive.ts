import { AppError } from "@/core/errors";
import type { KnowledgeItemType } from "@/core/knowledge/model";
import type { ExternalItem } from "@/core/knowledge/sync";

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
const FILES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/csv",
]);

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

  /** Every supported file under the user's selection (folders recursively). */
  async listSelection(
    selection: readonly DriveSelection[],
    limit: number,
  ): Promise<ExternalItem[]> {
    const items = new Map<string, ExternalItem>();
    const walk = async (folderId: string, path: string[], depth: number) => {
      if (depth > MAX_DEPTH || items.size >= limit) return;
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
    return [...items.values()];
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
