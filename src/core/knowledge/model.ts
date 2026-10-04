/**
 * Knowledge (docs/architecture/09): what ELISE understands from the user's documents.
 * Spaces are logical contexts; Sources feed them; Items are documents; Versions keep history;
 * Chunks are the searchable, citable passages of the current version.
 */

export type KnowledgeSourceType = "upload" | "google_drive" | "notion" | "note";

export type KnowledgeItemType =
  | "file"
  | "drive_file"
  | "google_doc"
  | "google_sheet"
  | "google_slides"
  | "notion_page"
  | "notion_database_page"
  | "note";

export type KnowledgeItemStatus =
  "queued" | "processing" | "ready" | "needs_attention" | "failed" | "removed" | "archived";

/** A structure-preserving, provider-neutral document (docs/architecture/09 §26). */
export interface NormalizedDocument {
  title: string;
  sections: DocumentSection[];
}

export interface DocumentSection {
  /** ["Chapter 2", "Email filing"]; empty for text before the first heading. */
  headingPath: string[];
  /** 1-based page, when the format has pages (PDF). */
  page: number | null;
  /** Paragraphs, list items, table rows — in order. */
  blocks: string[];
}

export interface ChunkDraft {
  index: number;
  content: string;
  headingPath: string[];
  page: number | null;
  tokenCount: number;
}

/** Embeddings behind a port; OpenAI is the first implementation. */
export interface EmbeddingProvider {
  /** Recorded on every chunk so indexes can be rebuilt when it changes. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SpaceInfo {
  id: string;
  name: string;
  parentId: string | null;
  /** "Work › Acme › Client A" */
  path: string;
  /** What else the user calls it (its description), for resolving "Análisis Matemático II". */
  aliases?: string[];
  /** What it is, in the user's words — Knowledge itself, read directly once resolved (ADR-035). */
  description?: string | null;
  /** Background the user wrote for it (dates, preferences…). */
  context?: string | null;
}

export interface KnowledgeHit {
  chunkId: string;
  itemId: string;
  versionId: string;
  versionNumber: number;
  title: string;
  itemType: KnowledgeItemType;
  sourceType: KnowledgeSourceType;
  sourceUrl: string | null;
  spaceId: string;
  spaceName: string;
  headingPath: string[];
  page: number | null;
  content: string;
  /** Cosine similarity of the semantic match (null when only keywords matched). */
  similarity: number | null;
  keywordMatched: boolean;
  score: number;
}

export interface ItemDetail {
  id: string;
  title: string;
  itemType: KnowledgeItemType;
  sourceType: KnowledgeSourceType;
  status: KnowledgeItemStatus;
  sourceUrl: string | null;
  spaceId: string;
  spaceName: string;
  updatedAt: string;
  versions: {
    id: string;
    number: number;
    createdAt: string;
    isCurrent: boolean;
    status: string;
  }[];
}

export interface SourceInfo {
  id: string;
  spaceId: string;
  spaceName: string;
  sourceType: KnowledgeSourceType;
  name: string;
  status: string;
  lastSyncedAt: string | null;
  items: { ready: number; processing: number; failed: number };
}

export interface ChangeEntry {
  itemId: string;
  title: string;
  spaceName: string;
  sourceType: KnowledgeSourceType;
  change: "added" | "updated" | "removed";
  versionNumber: number | null;
  at: string;
}

export interface VersionText {
  itemId: string;
  versionId: string;
  versionNumber: number;
  title: string;
  createdAt: string;
  text: string;
}

/** Read side used by the model-facing tools. Always scoped to one workspace. */
export interface KnowledgeReader {
  spaces(): Promise<SpaceInfo[]>;
  search(query: {
    text: string;
    spaceIds: string[] | null;
    itemIds: string[] | null;
    limit: number;
  }): Promise<{ hits: KnowledgeHit[]; semantic: boolean }>;
  getItem(itemId: string): Promise<ItemDetail | null>;
  listSources(spaceIds: string[] | null): Promise<SourceInfo[]>;
  recentChanges(spaceIds: string[] | null, since: Date): Promise<ChangeEntry[]>;
  versionText(itemId: string, versionNumber: number | null): Promise<VersionText | null>;
  /** First passage of each ready item, for space overviews. */
  overview(
    spaceIds: string[] | null,
    limit: number,
  ): Promise<{ total: number; items: { itemId: string; title: string; preview: string }[] }>;
}

/** Space plus all its descendants: searching "Work" includes "Work › Acme". */
export function withDescendants(
  spaces: readonly SpaceInfo[],
  rootIds: readonly string[],
): string[] {
  const out = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of spaces) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return [...out];
}

/**
 * Where a scope searches (ADR-018): the Spaces asked for with their Sections (primary), plus —
 * for a Section — its parent Space's own general sources (inherited, secondary). Sibling
 * Sections are never pulled in, and retrieval still decides what is relevant.
 */
export function scopeSpaces(
  spaces: readonly SpaceInfo[],
  rootIds: readonly string[],
): { spaceIds: string[]; primary: string[] } {
  const primary = withDescendants(spaces, rootIds);
  const inherited = rootIds
    .map((id) => spaces.find((s) => s.id === id)?.parentId)
    .filter((p): p is string => Boolean(p) && !primary.includes(p!));
  return { spaceIds: [...new Set([...primary, ...inherited])], primary };
}

export function spacePaths(
  spaces: readonly { id: string; name: string; parentId: string | null; aliases?: string[] }[],
): SpaceInfo[] {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  return spaces.map((s) => {
    const names: string[] = [];
    let cursor: typeof s | undefined = s;
    for (let depth = 0; cursor && depth < 12; depth++) {
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return { ...s, path: names.join(" › ") };
  });
}

/** SHA-256 of the extracted text: identical content is never re-embedded. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical text of a document (what is hashed, stored and diffed). */
export function documentText(doc: NormalizedDocument): string {
  return doc.sections
    .map((s) => {
      const heading = s.headingPath.length
        ? `${"#".repeat(s.headingPath.length)} ${s.headingPath.at(-1)}\n\n`
        : "";
      const page = s.page ? `[page ${s.page}]\n` : "";
      return `${page}${heading}${s.blocks.join("\n\n")}`;
    })
    .join("\n\n")
    .trim();
}
