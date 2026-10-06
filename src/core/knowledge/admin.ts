/**
 * Knowledge administration (ADR-035): what ELISE can do with the user's Knowledge environment
 * through typed, workspace-scoped operations — never tables. Implemented by the application
 * layer with the same services (and validation, audit and Realtime) as the Knowledge UI.
 */

export interface DocumentCounts {
  ready: number;
  processing: number;
  attention: number;
}

export interface SpaceOverview {
  id: string;
  name: string;
  /** "Facultad › Análisis II" for a Section. */
  path: string;
  parentId: string | null;
  /** General Knowledge (ADR-047): never renamed, moved or archived. */
  general?: boolean;
  /** What it is, in the user's words (shown in the Knowledge UI). */
  description: string | null;
  /** Background ELISE reads when working there (dates, preferences…). */
  context: string | null;
  sections: number;
  sources: number;
  documents: DocumentCounts;
}

export interface SpaceContents {
  space: SpaceOverview;
  /** A Section's parent Space: its description/context and general sources also apply here. */
  parent: { name: string; description: string | null; context: string | null } | null;
  sections: { id: string; name: string; description: string | null }[];
  sources: {
    id: string;
    name: string;
    type: string;
    status: string;
    documents: DocumentCounts;
    lastSyncedAt: string | null;
    lastError: string | null;
  }[];
  documents: {
    id: string;
    title: string;
    type: string;
    status: string;
    /** Stage while processing ("ocr") or the reason it needs attention. */
    detail: string | null;
  }[];
}

export interface KnowledgeManager {
  listSpaces(): Promise<SpaceOverview[]>;
  contents(spaceId: string): Promise<SpaceContents>;
  /** A Section when `parentId` is a Space. */
  createSpace(input: {
    name: string;
    description?: string | null;
    parentId?: string | null;
  }): Promise<{ id: string; section: boolean }>;
  updateSpace(
    spaceId: string,
    patch: {
      name?: string;
      description?: string | null;
      context?: string | null;
      icon?: string | null;
      color?: string | null;
    },
  ): Promise<void>;
  archiveSpace(spaceId: string): Promise<void>;
  /** Between a Space and its Sections (no copy, no re-reading). */
  moveDocument(itemId: string, spaceId: string): Promise<void>;
  removeDocument(itemId: string): Promise<void>;
  /** A connected source (Drive folder, Notion page): stops syncing, removes what was indexed. */
  removeSource(sourceId: string): Promise<void>;
  /** Reprocess documents (OCR included); idempotent. Returns how many were queued. */
  retryDocuments(itemIds: string[]): Promise<number>;
  syncSource(sourceId: string): Promise<"started" | "already_syncing" | "not_syncable">;
  /** A chat attachment saved into Knowledge: same bytes, its extraction reused. */
  saveAttachment(attachmentId: string, spaceId: string): Promise<{ itemId: string; title: string }>;
}
