import { z } from "zod";

import { sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  addItemsInput,
  createListInput,
  createListIntent,
  matchLists,
  namesAList,
  sameListName,
  itemRefInput,
  listRefInput,
  matchItems,
  moveItemInput,
  renameListInput,
  splitItems,
  updateItemInput,
  updateListInput,
  type NativeList,
} from "../capabilities/lists";
import { AppError } from "../errors";

function provider(env: ToolRunEnv) {
  return env.providers.get("lists", env.binding);
}

/**
 * The ONE existing list a request means (ADR-061): by id, else by the name the user said
 * (singular/plural, emoji, "la lista de" aside) — never by meaning or translation. Several
 * matches → ask which; none → ask whether to use another list or create it. Never guesses,
 * never creates.
 */
async function resolve(env: ToolRunEnv, ref: string): Promise<NativeList> {
  const matches = await provider(env).find(ref);
  const byId = matches.length === 1 && matches[0]!.id === ref;
  env.ctx.log?.("info", "list.target_resolution", {
    matched_list_id: matches.length === 1 ? matches[0]!.id : null,
    match_type: byId ? "id" : matches.length === 1 ? "name" : matches.length ? "ambiguous" : "none",
    candidate_count: matches.length,
    attachment_present: Boolean(env.ctx.attachmentCount),
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new AppError(
      "VALIDATION_ERROR",
      `Several lists match "${ref}": ${matches
        .map((l) => l.name)
        .slice(0, 8)
        .join("; ")}. Ask which one; change nothing until the user says.`,
      { recovery: "review" },
    );
  const names = (await provider(env).list()).map((l) => l.name).slice(0, 12);
  throw new AppError(
    "NOT_FOUND",
    `No list called "${ref}". The user's lists: ${names.join("; ") || "none"}. Ask whether to use one of them or create "${ref}" — never create it without their answer.`,
    { recovery: "review" },
  );
}

/** A list item as the model sees it: text, plus description/labels only when present. */
const itemForModel = (i: NativeList["items"][number]) =>
  i.notes || i.labels?.length
    ? {
        item: i.content,
        ...(i.notes ? { description: i.notes } : {}),
        ...(i.labels?.length ? { labels: i.labels } : {}),
      }
    : i.content;

function forModel(list: NativeList) {
  const { active, done } = splitItems(list);
  return {
    listId: list.id,
    name: list.name,
    ...(list.icon ? { icon: list.icon } : {}),
    open: active.map(itemForModel),
    checked: done.map(itemForModel),
  };
}

const show = (list: NativeList, extra: Record<string, unknown> = {}) => ({
  output: { ...extra, list: forModel(list) },
  display: { kind: "native_list" as const, list },
  target: { type: "list", id: list.id },
});

export const listListsTool: ToolDefinition = {
  name: "lists.list",
  capability: "lists",
  operation: "list",
  description:
    "The user's Lists (checklists: shopping, packing, ideas…) with how many items are still open. Lists are not tasks: no dates or priorities.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List lists" };
  },
  async run(_raw, env) {
    const lists = await provider(env).list();
    return {
      output: {
        lists: lists.map((l) => ({
          name: l.name,
          ...(l.icon ? { icon: l.icon } : {}),
          open: l.open,
          total: l.total,
        })),
      },
    };
  },
};

export const getListTool: ToolDefinition = {
  name: "lists.get",
  capability: "lists",
  operation: "get",
  description:
    '"¿Qué me falta comprar?", "mostrame lo que ya compré", "mostrame mi lista de viaje": the list\'s open and checked items, current, shown as the list on screen.',
  input: listRefInput,
  async describe() {
    return { summary: "Open list" };
  },
  async run(raw, env) {
    return show(await resolve(env, listRefInput.parse(raw).list));
  },
};

export const createListTool: ToolDefinition = {
  name: "lists.create",
  capability: "lists",
  operation: "create",
  description:
    'Create a NEW list, optionally with items — only when the user asks for a new list ("creame una lista para Japón con pasaporte y cargador"). To add to a list the user names ("agregalo a Aprendizaje"), use lists.addItem: it resolves their existing list. Never create a list from a title or heading inside an image or file, from a translation or synonym of an existing list, or as a fallback when unsure — ask instead.',
  input: createListInput,
  async describe(raw) {
    return { summary: `Create list “${createListInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const l = createListInput.parse(raw);
    // Guardrails (ADR-061), deterministic — not left to the prompt:
    const existing = await provider(env).list();
    // 1. A list with that name exists: never a second one.
    const same = existing.find((x) => sameListName(x.name, l.name));
    if (same)
      throw new AppError(
        "CONFLICT",
        `A list called "${same.name}" already exists. Add to it with lists.addItem (list "${same.name}"); don't create another.`,
        { recovery: "review" },
      );
    // 2. A request from a conversation creates only when the user asked for a new list. A list
    //    they named, a title in an attachment or a guess is never a reason to create one.
    const message = env.ctx.userMessage ?? null;
    if (env.ctx.origin === "ai" && message !== null && !createListIntent(message)) {
      const named = matchLists(
        existing.map((x) => ({ id: x.id, name: x.name })),
        message,
      );
      env.ctx.log?.("warn", "list.unexpected_create_blocked", {
        explicit_target: namesAList(
          message,
          existing.map((x) => x.name),
        ),
        attachment_present: Boolean(env.ctx.attachmentCount),
        existing_lists: existing.length,
      });
      throw new AppError(
        "VALIDATION_ERROR",
        `The user didn't ask for a new list, so none was created. ${
          named.length === 1 ||
          namesAList(
            message,
            existing.map((x) => x.name),
          )
            ? "They named an existing list: add the items there with lists.addItem."
            : `Ask where to put this: one of their lists (${
                existing
                  .map((x) => x.name)
                  .slice(0, 8)
                  .join("; ") || "none yet"
              }) or a new list they name.`
        } Titles inside images or files are content, never a list to create.`,
        { recovery: "review" },
      );
    }
    return show(
      await provider(env).create(
        { name: l.name, description: l.description ?? null, icon: l.icon ?? null, items: l.items },
        sourceOf(env.ctx),
      ),
      {
        created: true,
      },
    );
  },
};

export const renameListTool: ToolDefinition = {
  name: "lists.rename",
  capability: "lists",
  operation: "rename",
  description: "Rename a list.",
  input: renameListInput,
  async describe(raw) {
    return { summary: `Rename list “${renameListInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const r = renameListInput.parse(raw);
    return show(await provider(env).rename((await resolve(env, r.list)).id, r.name));
  },
};

export const addItemTool: ToolDefinition = {
  name: "lists.addItem",
  capability: "lists",
  operation: "addItem",
  description:
    'Add one or more items to ONE existing list in ONE call ("agregá leche, café y arroz a compras" → items ["leche", "café", "arroz"]). `list` is the list the USER named ("compras" → "🛍️ Compras"; "aprendizajes" → "📚 Aprendizaje"), never a title read from an image or file. An item may carry a description or already be done: {content, notes, checked} (e.g. ticked on a whiteboard in a photo). Write to one list only, unless the user asks for several. If no list or several match, ask — do not create one.',
  input: addItemsInput,
  async describe(raw) {
    return { summary: `Add to “${addItemsInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const a = addItemsInput.parse(raw);
    const list = await resolve(env, a.list);
    await provider(env).addItems(list.id, a.items, sourceOf(env.ctx));
    return show((await provider(env).get(list.id))!, {
      added: a.items.map((i) => (typeof i === "string" ? i : i.content)),
    });
  },
};

function pickOneItem(matches: NativeList["items"], ref: string) {
  if (matches.length === 1) return matches[0]!;
  throw new AppError(
    matches.length ? "VALIDATION_ERROR" : "NOT_FOUND",
    matches.length
      ? `Several items match "${ref}": ${matches
          .map((i) => i.content)
          .slice(0, 8)
          .join("; ")}. Ask which one.`
      : `No item "${ref}" in that list`,
    { recovery: "review" },
  );
}

async function item(env: ToolRunEnv, listRef: string, itemRef: string) {
  const list = await resolve(env, listRef);
  return { list, item: pickOneItem(matchItems(list, itemRef), itemRef) };
}

function checkTool(name: "checkItem" | "uncheckItem", checked: boolean): ToolDefinition {
  return {
    name: `lists.${name}`,
    capability: "lists",
    operation: name,
    description: checked ? 'Check off an item ("check passport").' : "Uncheck an item.",
    input: itemRefInput,
    async describe(raw) {
      return { summary: `${checked ? "Check" : "Uncheck"} “${itemRefInput.parse(raw).item}”` };
    },
    async run(raw, env) {
      const r = itemRefInput.parse(raw);
      const { list, item: it } = await item(env, r.list, r.item);
      await provider(env).updateItem(it.id, { checked });
      return show((await provider(env).get(list.id))!);
    },
  };
}

export const checkItemTool = checkTool("checkItem", true);
export const uncheckItemTool = checkTool("uncheckItem", false);

export const updateItemTool: ToolDefinition = {
  name: "lists.updateItem",
  capability: "lists",
  operation: "updateItem",
  description:
    'Edit an item: its text, its description (notes), or its labels (addLabels/removeLabels, e.g. "ponele la etiqueta farmacia").',
  input: updateItemInput,
  async describe(raw) {
    return { summary: `Edit “${updateItemInput.parse(raw).item}”` };
  },
  async run(raw, env) {
    const u = updateItemInput.parse(raw);
    const { list, item: it } = await item(env, u.list, u.item);
    await provider(env).updateItem(it.id, {
      content: u.content,
      notes: u.notes,
      addLabels: u.addLabels,
      removeLabels: u.removeLabels,
    });
    // The item as it reads now: a correction right after can point at it (ADR-065).
    return show((await provider(env).get(list.id))!, { updated: u.content ?? it.content });
  },
};

export const removeItemTool: ToolDefinition = {
  name: "lists.removeItem",
  capability: "lists",
  operation: "removeItem",
  description: "Remove an item from a list.",
  input: itemRefInput,
  async describe(raw) {
    return { summary: `Remove “${itemRefInput.parse(raw).item}”` };
  },
  async run(raw, env) {
    const r = itemRefInput.parse(raw);
    const { list, item: it } = await item(env, r.list, r.item);
    await provider(env).removeItem(it.id);
    return show((await provider(env).get(list.id))!, { removed: it.content });
  },
};

export const updateListTool: ToolDefinition = {
  name: "lists.update",
  capability: "lists",
  operation: "update",
  description: "Change a list's name, description, emoji icon, or how its items are sorted.",
  input: updateListInput,
  async describe(raw) {
    return { summary: `Edit list “${updateListInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const u = updateListInput.parse(raw);
    const list = await resolve(env, u.list);
    return show(
      await provider(env).update(list.id, {
        name: u.name,
        description: u.description,
        icon: u.icon,
        itemSort: u.sort,
      }),
    );
  },
};

export const moveItemTool: ToolDefinition = {
  name: "lists.moveItem",
  capability: "lists",
  operation: "moveItem",
  description:
    'Move an item to another list ("mové adaptador de compras a viaje"). It keeps its description and labels.',
  input: moveItemInput,
  async describe(raw) {
    const m = moveItemInput.parse(raw);
    return { summary: `Move “${m.item}” to “${m.to}”` };
  },
  async run(raw, env) {
    const m = moveItemInput.parse(raw);
    const { item: it } = await item(env, m.list, m.item);
    const to = await resolve(env, m.to);
    await provider(env).moveItem(it.id, to.id);
    return show((await provider(env).get(to.id))!, { moved: it.content });
  },
};

export const clearCheckedTool: ToolDefinition = {
  name: "lists.clearChecked",
  capability: "lists",
  operation: "clearChecked",
  description: 'Remove the checked items of a list ("borrá los completados de compras").',
  input: listRefInput,
  async describe(raw) {
    return { summary: `Clear checked items of “${listRefInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const list = await resolve(env, listRefInput.parse(raw).list);
    const removed = await provider(env).clearChecked(list.id);
    return show((await provider(env).get(list.id))!, { removed });
  },
};

export const duplicateListTool: ToolDefinition = {
  name: "lists.duplicate",
  capability: "lists",
  operation: "duplicate",
  description: "Copy a list (its items start unchecked), e.g. to reuse a packing list.",
  input: listRefInput,
  async describe(raw) {
    return { summary: `Duplicate list “${listRefInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const list = await resolve(env, listRefInput.parse(raw).list);
    return show(await provider(env).duplicate(list.id, sourceOf(env.ctx)), { created: true });
  },
};

export const archiveListTool: ToolDefinition = {
  name: "lists.archive",
  capability: "lists",
  operation: "archive",
  description: "Delete a whole list and its items. Needs the user's approval.",
  input: listRefInput,
  async describe(raw, env) {
    const list = await resolve(env, listRefInput.parse(raw).list);
    return {
      summary: `Archive list “${list.name}” (${list.items.length} items)`,
      target: { type: "list", id: list.id },
    };
  },
  async run(raw, env) {
    const list = await resolve(env, listRefInput.parse(raw).list);
    await provider(env).archive(list.id);
    return { output: { archived: list.name }, target: { type: "list", id: list.id } };
  },
};

export const LIST_TOOLS = [
  listListsTool,
  getListTool,
  createListTool,
  renameListTool,
  addItemTool,
  checkItemTool,
  uncheckItemTool,
  updateItemTool,
  removeItemTool,
  updateListTool,
  moveItemTool,
  clearCheckedTool,
  duplicateListTool,
  archiveListTool,
];
