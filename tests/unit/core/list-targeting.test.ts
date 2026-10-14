import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ToolContext } from "@/core/agents/tools";
import {
  createListIntent,
  matchLists,
  type ListItem,
  type NativeList,
} from "@/core/capabilities/lists";
import { surfacesFromOutcome } from "@/core/workspace/from-results";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * List targeting (ADR-061): the user's named list is the destination; nothing in an attachment
 * creates a list; ambiguity and absence are questions; the Surface is the whole list, read back.
 */

function memoryLists(names: string[]) {
  const lists: NativeList[] = names.map((name, n) => ({
    id: `l${n + 1}`,
    name,
    description: null,
    icon: null,
    items: [],
    updatedAt: "",
  }));
  const calls = { create: 0, addItems: 0 };
  const provider = {
    list: async () => lists.map((l) => ({ ...l, total: l.items.length, open: 0 })),
    find: async (ref: string) => matchLists(lists, ref),
    get: async (id: string) => lists.find((l) => l.id === id) ?? null,
    create: async (l: { name: string; items?: string[] }) => {
      calls.create++;
      const list: NativeList = {
        id: `l${lists.length + 1}`,
        name: l.name,
        description: null,
        icon: null,
        items: [],
        updatedAt: "",
      };
      lists.push(list);
      if (l.items) await provider.addItems(list.id, l.items);
      return list;
    },
    addItems: async (
      listId: string,
      items: (string | { content: string; checked?: boolean })[],
    ) => {
      calls.addItems++;
      const list = lists.find((l) => l.id === listId)!;
      const added = items.map((it, i): ListItem => ({
        id: `${listId}-i${list.items.length + i}`,
        listId,
        content: typeof it === "string" ? it : it.content,
        checked: typeof it !== "string" && it.checked === true,
        position: list.items.length + i,
        notes: null,
        labels: [],
      }));
      list.items.push(...added);
      return added;
    },
    updateItem: async (itemId: string, p: { checked?: boolean }) => {
      const item = lists.flatMap((l) => l.items).find((i) => i.id === itemId)!;
      if (p.checked !== undefined) item.checked = p.checked;
      return item;
    },
  };
  const { ports, log } = makePorts(
    [binding({ connectionId: "conn-native", capability: "lists", providerKey: "elise_native" })],
    { "conn-native": provider },
  );
  const events: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const ctx = (userMessage: string | null, over: Partial<ToolContext> = {}) =>
    makeCtx({
      origin: "ai",
      userMessage,
      log: (level, event, fields) => events.push({ level, event, fields }),
      ...over,
    });
  const run = (c: ToolContext, name: string, args: unknown, idempotencyKey?: string) =>
    executeToolCall(ports, c, { name, args, ...(idempotencyKey ? { idempotencyKey } : {}) });
  return { lists, calls, run, ctx, events, log };
}

const WHITEBOARD = [
  "Marketing — Hooks",
  { content: "Automation — Meta Coexistencia", checked: true },
];

describe("explicit target beats what an attachment says", () => {
  it("'Agregá esto a Aprendizaje' + an image titled Learning Paths → only Aprendizaje", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const c = t.ctx("Agregá esto a Aprendizaje.", { attachmentCount: 1 });
    // A model that reads the heading as a list name is stopped by the tool itself.
    const create = await t.run(c, "lists.create", { name: "Learning Paths", items: ["Hooks"] });
    expect(create).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(t.calls.create).toBe(0);
    expect(t.events).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "list.unexpected_create_blocked",
        fields: expect.objectContaining({ explicit_target: true, attachment_present: true }),
      }),
    );
    const add = await t.run(c, "lists.addItem", { list: "Aprendizaje", items: WHITEBOARD });
    expect(add.status).toBe("succeeded");
    expect(t.lists.map((l) => [l.name, l.items.length])).toEqual([["📚 Aprendizaje", 2]]);
  });

  it("a translation/synonym list exists too: the named one wins, alone", async () => {
    const t = memoryLists(["📚 Aprendizaje", "Learning Paths"]);
    const add = await t.run(t.ctx("Agregá esto a Aprendizaje."), "lists.addItem", {
      list: "Aprendizaje",
      items: ["Hooks"],
    });
    expect(add.status).toBe("succeeded");
    expect(t.lists.map((l) => l.items.length)).toEqual([1, 0]);
  });

  it("singular/plural and 'la lista de': 'aprendizajes' → 📚 Aprendizaje", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const add = await t.run(t.ctx("agregalo a la lista de aprendizajes"), "lists.addItem", {
      list: "la lista de aprendizajes",
      items: ["Hooks"],
    });
    expect(add.status).toBe("succeeded");
    expect(t.events).toContainEqual(
      expect.objectContaining({
        event: "list.target_resolution",
        fields: expect.objectContaining({ match_type: "name", candidate_count: 1 }),
      }),
    );
  });
});

describe("ambiguity and absence are questions, never new lists", () => {
  it("Compras Casa / Compras Firbot + 'agregalo a Compras' → ask; nothing written or created", async () => {
    const t = memoryLists(["Compras Casa", "Compras Firbot"]);
    const c = t.ctx("agregalo a Compras");
    const add = await t.run(c, "lists.addItem", { list: "Compras", items: ["Leche"] });
    expect(add).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(JSON.stringify(add)).toMatch(/Ask which one/);
    expect(await t.run(c, "lists.create", { name: "Compras" })).toMatchObject({
      status: "failed",
    });
    expect(t.calls).toEqual({ create: 0, addItems: 0 });
  });

  it("'agregalo a Lecturas' with no such list → asks to use another or create; no create", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const c = t.ctx("agregalo a Lecturas");
    const add = await t.run(c, "lists.addItem", { list: "Lecturas", items: ["Rayuela"] });
    expect(add).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(add)).toMatch(/📚 Aprendizaje.*never create it without their answer/);
    expect(await t.run(c, "lists.create", { name: "Lecturas", items: ["Rayuela"] })).toMatchObject({
      status: "failed",
    });
    expect(t.calls.create).toBe(0);
  });

  it("only an image title and no destination ('guardá estos elementos') → no list from the title", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const out = await t.run(
      t.ctx("guardá estos elementos", { attachmentCount: 1 }),
      "lists.create",
      { name: "Learning Paths", items: ["Hooks"] },
    );
    expect(out).toMatchObject({ status: "failed" });
    expect(JSON.stringify(out)).toMatch(/Ask where to put this/);
    expect(t.calls.create).toBe(0);
  });
});

describe("explicit creation still works — exactly once", () => {
  it("'Creame una lista Learning Paths y agregá estos items' → one list, populated", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const c = t.ctx("Creame una lista Learning Paths y agregá estos items", {
      attachmentCount: 1,
    });
    const first = await t.run(c, "lists.create", { name: "Learning Paths", items: ["Hooks"] });
    expect(first.status).toBe("succeeded");
    // A second create of the same name (a confused plan) can't duplicate it.
    const again = await t.run(c, "lists.create", { name: "learning paths" });
    expect(again).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
    expect(t.lists.map((l) => l.name)).toEqual(["📚 Aprendizaje", "Learning Paths"]);
    expect(t.lists[1]!.items.map((i) => i.content)).toEqual(["Hooks"]);
  });

  it("create intent is read from what the user said", () => {
    for (const yes of [
      "Creame una lista Learning Paths",
      "Hacé una nueva lista con estas cosas",
      "Guardá esto en una lista nueva llamada Aprendizaje",
      "necesito una lista para el viaje",
      "make a new list for groceries",
    ])
      expect(createListIntent(yes), yes).toBe(true);
    for (const no of [
      "Agregá esto a Aprendizaje",
      "Ponelo en la lista de compras",
      "agregame estos ítems a la lista de aprendizajes",
      "guardá estos elementos",
    ])
      expect(createListIntent(no), no).toBe(false);
  });

  it("schedules and the UI aren't second-guessed (no user message to read)", async () => {
    const t = memoryLists([]);
    const out = await t.run(t.ctx(null, { origin: "schedule" }), "lists.create", {
      name: "Semana",
    });
    expect(out.status).toBe("succeeded");
  });
});

describe("retries", () => {
  it("the same tool call retried (same operation id) writes once", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    const c = t.ctx("agregá esto a Aprendizaje");
    const args = { list: "Aprendizaje", items: ["Hooks", "Onboarding"] };
    const a = await t.run(c, "lists.addItem", args, "run-1:call-7");
    const b = await t.run(c, "lists.addItem", args, "run-1:call-7");
    expect([a.status, b.status]).toEqual(["succeeded", "succeeded"]);
    expect(t.calls.addItems).toBe(1);
    expect(t.lists[0]!.items).toHaveLength(2);
  });
});

describe("the list Surface is the whole list, read back", () => {
  const surfaceOf = async (t: ReturnType<typeof memoryLists>, name: string, args: unknown) => {
    const out = await t.run(t.ctx("agregá a la lista"), name, args);
    expect(out.status).toBe("succeeded");
    const [s] = surfacesFromOutcome(name, out as never, { key: "k" });
    return s!;
  };

  it("adding C to [A, B] shows A, B, C under the list's real name", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    await t.run(t.ctx("x"), "lists.addItem", { list: "Aprendizaje", items: ["A", "B"] });
    const s = await surfaceOf(t, "lists.addItem", { list: "Aprendizaje", items: ["C"] });
    expect(s.type).toBe("checklist");
    expect(s.payload).toMatchObject({ name: "📚 Aprendizaje", total: 3, open: 3 });
    expect((s.payload as { items: { content: string }[] }).items.map((i) => i.content)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });

  it("completing A moves it to completed; B stays pending", async () => {
    const t = memoryLists(["📚 Aprendizaje"]);
    await t.run(t.ctx("x"), "lists.addItem", { list: "Aprendizaje", items: ["A", "B"] });
    const s = await surfaceOf(t, "lists.checkItem", { list: "Aprendizaje", item: "A" });
    const items = (s.payload as { items: { content: string; checked: boolean }[] }).items;
    expect(items.filter((i) => !i.checked).map((i) => i.content)).toEqual(["B"]);
    expect(items.filter((i) => i.checked).map((i) => i.content)).toEqual(["A"]);
    expect(s.payload).toMatchObject({ open: 1, total: 2 });
  });

  it("one list = one Surface (updated in place); two lists = two Surfaces", async () => {
    const t = memoryLists(["📚 Aprendizaje", "🛍️ Compras"]);
    const a1 = await surfaceOf(t, "lists.addItem", { list: "Aprendizaje", items: ["A"] });
    const a2 = await surfaceOf(t, "lists.addItem", { list: "Aprendizaje", items: ["B"] });
    const c1 = await surfaceOf(t, "lists.addItem", { list: "Compras", items: ["Leche"] });
    expect(a1.id).toBe(a2.id);
    expect(a1.id).not.toBe(c1.id);
  });
});
