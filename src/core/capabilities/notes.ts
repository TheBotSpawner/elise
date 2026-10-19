import { z } from "zod";

import type { EntrySource } from "./habits";

/**
 * Notes (docs/architecture/10 §30-32, ADR-056). The note is the single editable source of
 * truth; its content is Markdown (plain text is valid Markdown, so older notes need nothing).
 *
 * A note may belong to zero, one or many Knowledge Spaces. In Knowledge it is ONE indexed item
 * with ONE set of chunks, filed in its first Space; the other Spaces retrieve it through
 * membership, so nothing is copied, embedded twice or cited twice.
 */
export interface NoteSpace {
  id: string;
  /** "Trabajo › Cliente A" (Sections are child Spaces). */
  path: string;
}

/** ADR-088: a fixed palette (theme-aware on screen), never arbitrary colors. */
export const NOTE_TAG_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export type NoteTagColor = (typeof NOTE_TAG_COLORS)[number];

/** ADR-088: the workspace's own labels for notes. */
export interface NoteTag {
  id: string;
  name: string;
  color: NoteTagColor;
}

export interface Note {
  id: string;
  title: string;
  /** Markdown. */
  content: string;
  /** Every Space the note belongs to, in the order it was added. */
  spaces: NoteSpace[];
  /** The first Space (kept for older callers): null when the note is outside Knowledge. */
  spaceId: string | null;
  spaceName: string | null;
  source: EntrySource;
  createdAt: string;
  updatedAt: string;
  /** ADR-088: its tags, by name. */
  tags?: NoteTag[];
}

export interface NotesProvider {
  /** `tagIds`: only notes carrying every one of these tags (ADR-088). */
  list(opts: { spaceId?: string | null; limit: number; tagIds?: string[] }): Promise<Note[]>;
  find(ref: string): Promise<Note[]>;
  get(id: string): Promise<Note | null>;
  /** Words in the title, text or a tag's name; `tagIds` narrows like `list`. */
  search(query: string, limit: number, tagIds?: string[]): Promise<Note[]>;
  create(
    note: { title: string; content: string; spaceIds: string[] },
    source: EntrySource,
  ): Promise<Note>;
  /** `spaceIds` replaces the note's Spaces (an empty list takes it out of Knowledge). */
  update(
    id: string,
    patch: { title?: string; content?: string; spaceIds?: string[] },
  ): Promise<Note>;
  archive(id: string): Promise<Note>;
  /** Resolves a Knowledge Space by id, name or path ("Work › Acme"). */
  resolveSpace(ref: string): Promise<{ id: string; path: string } | null>;
  // ADR-088 — tags (absent before migration 054).
  listTags?(): Promise<NoteTag[]>;
  /** Creates (no id) or renames / recolors a tag. Names are unique, case-insensitively. */
  saveTag?(tag: { id?: string; name?: string; color?: NoteTagColor }): Promise<NoteTag>;
  /** Removes the tag from every note; the notes stay. */
  deleteTag?(id: string): Promise<void>;
  /** Exactly these tags on the note. */
  setNoteTags?(noteId: string, tagIds: string[]): Promise<Note>;
}

/** Markdown → readable text for previews and lists (search uses the database's own tokens). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const noteRef = z.string().trim().min(1).max(300).describe("The note's id or title.");
const space = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A Knowledge Space or Section by name ("Trabajo", "General").');
const spaceList = z.array(space).max(20);

export const createNoteInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    content: z
      .string()
      .trim()
      .max(100000)
      .default("")
      .describe("Markdown: # headings, **bold**, *italic*, - lists, 1. lists, > quotes, `code`."),
    spaces: spaceList
      .optional()
      .describe("Knowledge Spaces to file it in (searchable there). Omit to keep it outside."),
    space: space.optional().describe("One Space (same as spaces with one name)."),
  })
  .strict();

export const updateNoteInput = z
  .object({
    note: noteRef,
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().max(100000).optional().describe("The full new content, in Markdown."),
    append: z
      .string()
      .max(20000)
      .optional()
      .describe("Markdown to add at the end instead of replacing."),
    space: space
      .nullable()
      .optional()
      .describe("Older form: exactly this one Space; null takes it out of Knowledge."),
  })
  .strict();

export const setNoteSpacesInput = z
  .object({
    note: noteRef,
    spaces: spaceList
      .optional()
      .describe("Exactly these Spaces (replaces). [] = outside Knowledge."),
    add: spaceList.optional().describe('"Sumala a Marketing también" → add ["Marketing"].'),
    remove: spaceList.optional().describe('"Sacala de Marketing" → remove ["Marketing"].'),
  })
  .strict()
  .refine((x) => x.spaces !== undefined || x.add?.length || x.remove?.length, {
    message: "Pass spaces, add or remove",
  });

export const noteRefInput = z.object({ note: noteRef }).strict();

const tagName = z.string().trim().min(1).max(40).describe('A tag name ("Ideas", "Urgente").');
const tagColor = z.enum(NOTE_TAG_COLORS);

export const tagNoteInput = z
  .object({
    note: noteRef,
    tags: z.array(tagName).max(20).optional().describe("Exactly these tags (replaces)."),
    add: z
      .array(tagName)
      .max(20)
      .optional()
      .describe('"Etiquetala como Ideas" → add ["Ideas"]. Missing tags are created.'),
    remove: z.array(tagName).max(20).optional(),
  })
  .strict()
  .refine((x) => x.tags !== undefined || x.add?.length || x.remove?.length, {
    message: "Pass tags, add or remove",
  });

export const saveTagInput = z
  .object({
    tag: tagName.optional().describe("An existing tag to change (omit to create one)."),
    name: tagName.optional(),
    color: tagColor.optional(),
  })
  .strict()
  .refine((x) => x.tag || x.name, { message: "Pass tag (to change) or name (to create)" });

export const deleteTagInput = z.object({ tag: tagName }).strict();
const tagFilter = z
  .array(tagName)
  .max(10)
  .optional()
  .describe("Only notes with every one of these tags.");
export const listNotesInput = z
  .object({
    space: space.optional(),
    tags: tagFilter,
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
export const searchNotesInput = z
  .object({
    query: z.string().trim().min(1).max(200),
    tags: tagFilter,
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

/** The Spaces after an add / remove / replace, deduplicated, in a stable order. */
export function nextSpaces(
  current: string[],
  change: { spaces?: string[]; add?: string[]; remove?: string[] },
): string[] {
  const base = change.spaces ?? current;
  const removed = new Set(change.remove ?? []);
  return [...new Set([...base, ...(change.add ?? [])])].filter((id) => !removed.has(id));
}

export type NoteIndexPlan =
  | { action: "none" }
  | { action: "remove" }
  | { action: "sync"; home: string; rehome: boolean; reindex: boolean };

/**
 * What a note change means for its single Knowledge item:
 * - none: outside Knowledge and never indexed;
 * - remove: archived, or every Space removed → the item goes (the note stays);
 * - sync: kept in its home Space while that is still one of its Spaces (else the first
 *   Space; moving home updates rows, it never re-embeds), memberships set to its Spaces, and a
 *   new version only when the text changed or it is new to Knowledge.
 */
export function noteIndexPlan(
  indexedHome: string | null,
  spaces: string[],
  archived: boolean,
  textChanged: boolean,
): NoteIndexPlan {
  if (archived || !spaces.length) return indexedHome ? { action: "remove" } : { action: "none" };
  const home = indexedHome && spaces.includes(indexedHome) ? indexedHome : spaces[0]!;
  return {
    action: "sync",
    home,
    rehome: indexedHome !== null && indexedHome !== home,
    reindex: indexedHome === null || textChanged,
  };
}
