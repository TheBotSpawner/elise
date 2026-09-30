import { z } from "zod";

import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  addItemsInput,
  createListInput,
  itemRefInput,
  listRefInput,
  matchItems,
  renameListInput,
  updateItemInput,
  type NativeList,
} from "../capabilities/lists";

function provider(env: ToolRunEnv) {
  return env.providers.get("lists", env.binding);
}

async function resolve(env: ToolRunEnv, ref: string): Promise<NativeList> {
  return pickOne(await provider(env).find(ref), ref, "list", (l) => l.name);
}

function forModel(list: NativeList) {
  return {
    listId: list.id,
    name: list.name,
    open: list.items.filter((i) => !i.checked).map((i) => i.content),
    checked: list.items.filter((i) => i.checked).map((i) => i.content),
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
  description: "The user's lists (shopping, packing, ideas…) with how many items are still open.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List lists" };
  },
  async run(_raw, env) {
    const lists = await provider(env).list();
    return {
      output: { lists: lists.map((l) => ({ name: l.name, open: l.open, total: l.total })) },
    };
  },
};

export const getListTool: ToolDefinition = {
  name: "lists.get",
  capability: "lists",
  operation: "get",
  description:
    "\"What's still missing from my Japan packing list?\": the list's open and checked items, current.",
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
    'Create a list, optionally with items ("a Japan packing list with passport, charger and headphones").',
  input: createListInput,
  async describe(raw) {
    return { summary: `Create list “${createListInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const l = createListInput.parse(raw);
    return show(
      await provider(env).create(
        { name: l.name, description: l.description ?? null, items: l.items },
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
    'Add one or more items to a list ("add eggs and coffee to the shopping list" → ["eggs", "coffee"]).',
  input: addItemsInput,
  async describe(raw) {
    return { summary: `Add to “${addItemsInput.parse(raw).list}”` };
  },
  async run(raw, env) {
    const a = addItemsInput.parse(raw);
    const list = await resolve(env, a.list);
    await provider(env).addItems(list.id, a.items, sourceOf(env.ctx));
    return show((await provider(env).get(list.id))!, { added: a.items });
  },
};

async function item(env: ToolRunEnv, listRef: string, itemRef: string) {
  const list = await resolve(env, listRef);
  return { list, item: pickOne(matchItems(list, itemRef), itemRef, "item", (i) => i.content) };
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
  description: "Edit an item's text or notes.",
  input: updateItemInput,
  async describe(raw) {
    return { summary: `Edit “${updateItemInput.parse(raw).item}”` };
  },
  async run(raw, env) {
    const u = updateItemInput.parse(raw);
    const { list, item: it } = await item(env, u.list, u.item);
    await provider(env).updateItem(it.id, { content: u.content, notes: u.notes });
    return show((await provider(env).get(list.id))!);
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

export const archiveListTool: ToolDefinition = {
  name: "lists.archive",
  capability: "lists",
  operation: "archive",
  description: "Archive a whole list. Needs the user's approval.",
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
  archiveListTool,
];
