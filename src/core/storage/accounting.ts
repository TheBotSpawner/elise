/**
 * Storage accounting (ADR-068): only bytes ELISE itself keeps — files uploaded to Knowledge and
 * files attached in chat. Drive files, Notion pages and Google Sheets stay with their provider
 * and are never counted, listed or deletable here. Sizes come from each file's own metadata row
 * (written when it was uploaded), so nothing scans a bucket.
 */
export const STORAGE_CATEGORIES = ["documents", "images", "attachments"] as const;
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export interface StoredFile {
  id: string;
  origin: "knowledge" | "chat";
  name: string;
  mimeType: string | null;
  bytes: number;
  createdAt: string;
  /** Where it is used: a Knowledge Space, or the conversation it was sent in. */
  where: { kind: "space" | "conversation"; id: string; label: string };
  /** Knowledge uploads can be removed from here (with what ELISE learned from them). */
  deletable: boolean;
  /** The Knowledge source to remove, for deletable files. */
  sourceId: string | null;
}

export function categoryOf(f: Pick<StoredFile, "origin" | "mimeType">): StorageCategory {
  if (f.mimeType?.startsWith("image/")) return "images";
  return f.origin === "knowledge" ? "documents" : "attachments";
}

export interface StorageSummary {
  bytes: number;
  files: number;
  categories: Record<StorageCategory, { bytes: number; files: number }>;
}

export function summarizeStorage(files: readonly StoredFile[]): StorageSummary {
  const categories = Object.fromEntries(
    STORAGE_CATEGORIES.map((c) => [c, { bytes: 0, files: 0 }]),
  ) as StorageSummary["categories"];
  let bytes = 0;
  for (const f of files) {
    const c = categories[categoryOf(f)];
    c.bytes += f.bytes;
    c.files++;
    bytes += f.bytes;
  }
  return { bytes, files: files.length, categories };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** "1.57 GB", "697 MB", "12 KB": decimal units, two significant decimals at most. */
export function formatBytes(bytes: number, locale: string): string {
  let n = Math.max(0, bytes);
  let u = 0;
  while (n >= 1000 && u < UNITS.length - 1) {
    n /= 1000;
    u++;
  }
  const digits = u >= 3 ? 2 : u === 2 && n < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n)} ${UNITS[u]}`;
}
