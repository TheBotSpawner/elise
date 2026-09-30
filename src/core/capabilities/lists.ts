import { z } from "zod";

import type { EntrySource } from "./habits";

/** Lists (docs/architecture/10 §17-19): ordered, checkable items. Not a second task system. */
export interface ListItem {
  id: string;
  listId: string;
  content: string;
  checked: boolean;
  position: number;
  notes: string | null;
}

export interface NativeList {
  id: string;
  name: string;
  description: string | null;
  items: ListItem[];
  updatedAt: string;
}

export interface ListsProvider {
  list(): Promise<(Omit<NativeList, "items"> & { total: number; open: number })[]>;
  find(ref: string): Promise<NativeList[]>;
  get(id: string): Promise<NativeList | null>;
  create(
    list: { name: string; description?: string | null; items?: string[] },
    source: EntrySource,
  ): Promise<NativeList>;
  rename(id: string, name: string): Promise<NativeList>;
  archive(id: string): Promise<NativeList>;
  addItems(listId: string, items: string[], source: EntrySource): Promise<ListItem[]>;
  updateItem(
    itemId: string,
    patch: { content?: string; checked?: boolean; notes?: string | null },
  ): Promise<ListItem>;
  removeItem(itemId: string): Promise<ListItem>;
  /** Rewrites positions to follow `itemIds` (items not listed keep their relative order after). */
  reorder(listId: string, itemIds: string[]): Promise<NativeList>;
}

/** Matches an item of a list by id or by its text (case/accents-insensitive). */
export function matchItems(list: NativeList, ref: string): ListItem[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const wanted = norm(ref);
  const exact = list.items.filter((i) => i.id === ref || norm(i.content) === wanted);
  return exact.length ? exact : list.items.filter((i) => norm(i.content).includes(wanted));
}

const listRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The list\'s id or name, e.g. "shopping".');
const itemText = z.string().trim().min(1).max(500);

export const createListInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    items: z.array(itemText).max(100).optional(),
  })
  .strict();

export const listRefInput = z.object({ list: listRef }).strict();
export const renameListInput = z
  .object({ list: listRef, name: z.string().trim().min(1).max(120) })
  .strict();
export const addItemsInput = z
  .object({ list: listRef, items: z.array(itemText).min(1).max(100) })
  .strict();
export const itemRefInput = z
  .object({
    list: listRef,
    item: z.string().trim().min(1).max(500).describe("The item's id or text."),
  })
  .strict();
export const updateItemInput = itemRefInput
  .extend({
    content: itemText.optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
