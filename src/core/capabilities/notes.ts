import { z } from "zod";

import type { EntrySource } from "./habits";

/**
 * Notes (docs/architecture/10 §30-32). The note is the single editable source of truth. A note
 * in a Knowledge Space is also indexed into Knowledge (source "ELISE Note") and re-indexed
 * whenever it changes; the indexed copy is never edited.
 */
export interface Note {
  id: string;
  title: string;
  content: string;
  spaceId: string | null;
  spaceName: string | null;
  source: EntrySource;
  createdAt: string;
  updatedAt: string;
}

export interface NotesProvider {
  list(opts: { spaceId?: string | null; limit: number }): Promise<Note[]>;
  find(ref: string): Promise<Note[]>;
  get(id: string): Promise<Note | null>;
  search(query: string, limit: number): Promise<Note[]>;
  create(
    note: { title: string; content: string; spaceId: string | null },
    source: EntrySource,
  ): Promise<Note>;
  update(
    id: string,
    patch: { title?: string; content?: string; spaceId?: string | null },
  ): Promise<Note>;
  archive(id: string): Promise<Note>;
  /** Resolves a Knowledge Space by id, name or path ("Work › Firbot"). */
  resolveSpace(ref: string): Promise<{ id: string; path: string } | null>;
}

const noteRef = z.string().trim().min(1).max(300).describe("The note's id or title.");
const space = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Knowledge Space name to file it in (makes it searchable in that Space).");

export const createNoteInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    content: z.string().trim().max(100000).default(""),
    space: space.optional(),
  })
  .strict();

export const updateNoteInput = z
  .object({
    note: noteRef,
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(100000).optional().describe("The full new content."),
    append: z
      .string()
      .max(20000)
      .optional()
      .describe("Text to add at the end instead of replacing."),
    space: space.nullable().optional(),
  })
  .strict();

export const noteRefInput = z.object({ note: noteRef }).strict();
export const listNotesInput = z
  .object({ space: space.optional(), limit: z.number().int().min(1).max(50).default(20) })
  .strict();
export const searchNotesInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

/**
 * What a note change means for its Knowledge representation:
 * - remove: archived or taken out of Knowledge → the indexed item is deleted (note kept);
 * - move: filed in another Space → re-created there;
 * - reindex: same Space → a new version is indexed (unchanged text is not re-embedded);
 * - none: not in Knowledge and never was.
 */
export function noteKnowledgePlan(
  indexedIn: string | null,
  note: { spaceId: string | null },
  archived: boolean,
): "remove" | "move" | "reindex" | "none" {
  if (archived || !note.spaceId) return indexedIn ? "remove" : "none";
  if (indexedIn && indexedIn !== note.spaceId) return "move";
  return "reindex";
}
