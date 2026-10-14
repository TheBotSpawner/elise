import { z } from "zod";

import type { EntrySource } from "./habits";

/**
 * Lists (docs/architecture/10 §17-19, ADR-051): ordered, checkable items. Deliberately NOT a
 * second task system: no due dates, reminders, priorities, subtasks or providers — a checklist.
 */
export interface ListItem {
  id: string;
  listId: string;
  content: string;
  checked: boolean;
  position: number;
  /** The item's optional description (multiline). */
  notes: string | null;
  /** Shared ELISE labels (the same label system as Tasks; the domains stay separate). */
  labels?: string[];
  checkedAt?: string | null;
  createdAt?: string;
}

export const LIST_ITEM_SORTS = ["manual", "alpha", "recent"] as const;
export type ListItemSort = (typeof LIST_ITEM_SORTS)[number];

export interface NativeList {
  id: string;
  name: string;
  description: string | null;
  items: ListItem[];
  updatedAt: string;
  /** Column order in the Lists workspace (user-arranged). */
  position?: number;
  icon?: string | null;
  itemSort?: ListItemSort;
}

export type ListSummary = Omit<NativeList, "items"> & { total: number; open: number };

export interface ListsProvider {
  list(): Promise<ListSummary[]>;
  /** Every list with its items, in column order (the workspace's one read). */
  all(): Promise<NativeList[]>;
  find(ref: string): Promise<NativeList[]>;
  get(id: string): Promise<NativeList | null>;
  create(
    list: { name: string; description?: string | null; icon?: string | null; items?: string[] },
    source: EntrySource,
  ): Promise<NativeList>;
  rename(id: string, name: string): Promise<NativeList>;
  update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      itemSort?: ListItemSort;
    },
  ): Promise<NativeList>;
  archive(id: string): Promise<NativeList>;
  duplicate(id: string, source: EntrySource): Promise<NativeList>;
  /** Rewrites column positions to follow `listIds`. */
  reorderLists(listIds: string[]): Promise<void>;
  addItems(
    listId: string,
    /** `checked`: already done (e.g. ticked on the whiteboard a photo shows). */
    items: (string | { content: string; notes?: string | null; checked?: boolean })[],
    source: EntrySource,
  ): Promise<ListItem[]>;
  updateItem(
    itemId: string,
    patch: {
      content?: string;
      checked?: boolean;
      notes?: string | null;
      addLabels?: string[];
      removeLabels?: string[];
    },
  ): Promise<ListItem>;
  removeItem(itemId: string): Promise<ListItem>;
  /** Moves an item to another list (at its end, or before `beforeItemId`). */
  moveItem(itemId: string, toListId: string, beforeItemId?: string | null): Promise<ListItem>;
  /** Removes the checked items of a list; returns how many. */
  clearChecked(listId: string): Promise<number>;
  /** Rewrites positions to follow `itemIds` (items not listed keep their relative order after). */
  reorder(listId: string, itemIds: string[]): Promise<NativeList>;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\p{Extended_Pictographic}|️/gu, "")
    .toLowerCase()
    .trim();

/** Matches an item of a list by id or by its text (case/accents-insensitive). */
export function matchItems(list: NativeList, ref: string): ListItem[] {
  const wanted = norm(ref);
  const exact = list.items.filter((i) => i.id === ref || norm(i.content) === wanted);
  return exact.length ? exact : list.items.filter((i) => norm(i.content).includes(wanted));
}

/** Words that name the container, not the list ("la lista de", "my … list"). */
const FILLER = new Set([
  "la",
  "el",
  "los",
  "las",
  "lista",
  "listas",
  "de",
  "del",
  "mi",
  "mis",
  "para",
  "a",
  "al",
  "con",
  "y",
  "the",
  "my",
  "list",
  "lists",
  "for",
  "of",
  "to",
]);
const stem = (w: string) => w.replace(/(es|s)$/, "");
const words = (s: string) =>
  norm(s)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w && !FILLER.has(w))
    .map(stem);

/**
 * The list a person means: id, exact name, then a name that contains every meaningful word they
 * said ("compras" → "🛍️ Lista de Compras", "la lista del viaje" → "Lista de Viaje"), then a
 * partial name. Several equally good matches are all returned so the caller asks.
 */
export function matchLists<T extends { id: string; name: string }>(lists: T[], ref: string): T[] {
  const byId = lists.filter((l) => l.id === ref);
  if (byId.length) return byId;
  const wanted = norm(ref);
  const exact = lists.filter((l) => norm(l.name) === wanted);
  if (exact.length) return exact;
  const said = words(ref);
  if (said.length) {
    const byWords = lists.filter((l) => {
      const have = words(l.name);
      return said.every((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w))));
    });
    if (byWords.length) return byWords;
  }
  return lists.filter((l) => {
    const n = norm(l.name);
    return n.includes(wanted) || (n.length >= 3 && wanted.includes(n));
  });
}

/**
 * Does the message name one of the user's lists ("agregalos a Aprendizajes" → "📚 Aprendizaje")?
 * Every meaningful word of a list's name must appear (singular/plural alike). Used to offer the
 * Lists tools up front when a message never says "lista".
 */
export function namesAList(message: string, names: readonly string[]): boolean {
  const said = words(message);
  if (!said.length) return false;
  return names.some((name) => {
    const have = words(name).filter((w) => w.length >= 3);
    return (
      have.length > 0 &&
      have.every((h) =>
        said.some((w) => w === h || (w.length >= 4 && (h.startsWith(w) || w.startsWith(h)))),
      )
    );
  });
}

/** Presentation order of a list's items (never rewrites positions or timestamps). */
export function sortItems(items: ListItem[], sort: ListItemSort = "manual"): ListItem[] {
  return [...items].sort((a, b) =>
    sort === "alpha"
      ? a.content.localeCompare(b.content, undefined, { sensitivity: "base" })
      : sort === "recent"
        ? (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        : a.position - b.position,
  );
}

/** Active above, checked below (most recently checked first). */
export function splitItems(list: NativeList) {
  const sorted = sortItems(list.items, list.itemSort);
  return {
    active: sorted.filter((i) => !i.checked),
    done: sorted
      .filter((i) => i.checked)
      .sort((a, b) => (b.checkedAt ?? "").localeCompare(a.checkedAt ?? "")),
  };
}

/** The starter Lists a new workspace gets once (normal, deletable user lists). */
export const STARTER_LISTS = [
  {
    icon: "🛍️",
    es: "Lista de Compras",
    en: "Shopping List",
    match: ["compra", "shopping", "supermercado", "groceri"],
  },
  {
    icon: "🛩️",
    es: "Lista de Viaje",
    en: "Travel List",
    match: ["viaje", "travel", "trip", "packing", "equipaje"],
  },
] as const;

const listRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('The list\'s id or name, e.g. "compras".');
const itemText = z.string().trim().min(1).max(500);
const itemNotes = z.string().trim().max(1000);
const labelNames = z.array(z.string().trim().min(1).max(60)).max(20);

export const createListInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).optional(),
    icon: z.string().trim().max(16).optional().describe("An emoji for the list, e.g. 🛩️"),
    items: z.array(itemText).max(100).optional(),
  })
  .strict();

export const listRefInput = z.object({ list: listRef }).strict();
export const renameListInput = z
  .object({ list: listRef, name: z.string().trim().min(1).max(120) })
  .strict();
export const updateListInput = z
  .object({
    list: listRef,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    icon: z.string().trim().max(16).nullable().optional(),
    sort: z.enum(LIST_ITEM_SORTS).optional().describe("How its items are shown."),
  })
  .strict();
export const addItemsInput = z
  .object({
    list: listRef,
    items: z
      .array(
        z.union([
          itemText,
          z
            .object({
              content: itemText,
              notes: itemNotes.optional(),
              checked: z
                .boolean()
                .optional()
                .describe(
                  "true when the entry is already done — e.g. ticked, checked or crossed out in the photo or list it came from. Use this field, not a note, to keep that state.",
                ),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(100)
      .describe('All the items in one call ("leche, café y arroz" → three items).'),
  })
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
    notes: itemNotes.nullable().optional().describe("The item's description."),
    addLabels: labelNames.optional(),
    removeLabels: labelNames.optional(),
  })
  .strict();
export const moveItemInput = itemRefInput
  .extend({ to: listRef.describe("The list it moves to.") })
  .strict();
