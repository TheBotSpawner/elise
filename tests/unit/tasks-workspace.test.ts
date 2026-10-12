import { describe, expect, it } from "vitest";

import type { Task, TaskList } from "@/core/capabilities/tasks";
import {
  applyFilters,
  groupTasks,
  inboxListIds,
  inSelection,
  nest,
  parseSelection,
  selectionQuery,
  sortTasks,
  viewCounts,
} from "@/features/tasks/views";

/** ADR-050: the Tasks workspace's views — pure presentation over the unified read. */

const TODAY = "2026-10-12"; // a Monday
const NATIVE = "native-conn";
const GOOGLE = "22222222-2222-4222-8222-222222222222";

let n = 0;
function task(p: Partial<Task> & { list?: string; conn?: string } = {}): Task {
  const { list = "inbox", conn = NATIVE, ...rest } = p;
  n++;
  return {
    id: `t${n}`,
    title: `Task ${n}`,
    description: null,
    notes: null,
    status: "pending",
    priority: null,
    category: null,
    parentId: null,
    labels: [],
    dueDate: null,
    completedAt: null,
    createdAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    updatedAt: "2026-10-01T00:00:00Z",
    provenance: {
      providerKey: conn === NATIVE ? "elise_native" : "google",
      connectionId: conn,
      externalId: `e${n}`,
      source: conn === NATIVE ? "ELISE" : "Firbot Academy",
      listId: list,
      listName: list,
    },
    ...rest,
  };
}

const lists: TaskList[] = [
  {
    id: "inbox",
    name: "Inbox",
    isDefault: true,
    provenance: { providerKey: "elise_native", connectionId: NATIVE, source: "ELISE" },
  },
  {
    id: "personal",
    name: "Personal",
    provenance: { providerKey: "elise_native", connectionId: NATIVE, source: "ELISE" },
  },
  {
    id: "g-default",
    name: "My Tasks",
    isDefault: true,
    provenance: { providerKey: "google", connectionId: GOOGLE, source: "Firbot Academy" },
  },
  {
    id: "g-general",
    name: "General",
    provenance: { providerKey: "google", connectionId: GOOGLE, source: "Firbot Academy" },
  },
];
const inbox = inboxListIds(lists);

describe("system views", () => {
  const overdue = task({ dueDate: "2026-10-10", list: "personal" });
  const dueToday = task({ dueDate: TODAY, conn: GOOGLE, list: "g-general" });
  const tomorrow = task({ dueDate: "2026-10-13" });
  const nextWeek = task({ dueDate: "2026-10-20" });
  const later = task({ dueDate: "2026-11-30" });
  const googleInbox = task({ conn: GOOGLE, list: "g-default" });
  const done = task({ status: "completed", completedAt: `${TODAY}T09:00:00Z` });
  const all = [overdue, dueToday, tomorrow, nextWeek, later, googleInbox, done];
  const ids = (sel: Parameters<typeof inSelection>[1]) =>
    all.filter((t) => inSelection(t, sel, TODAY, inbox)).map((t) => t.id);

  it("Today is a command center across every account: overdue first, then today", () => {
    const today = all.filter((t) => inSelection(t, { kind: "view", view: "today" }, TODAY, inbox));
    expect(today.map((t) => t.id).sort()).toEqual([overdue.id, dueToday.id].sort());
    expect(groupTasks(today, { kind: "view", view: "today" }, TODAY).map((g) => g.key)).toEqual([
      "overdue",
      "today",
    ]);
  });

  it("Upcoming groups by time, empty groups left out", () => {
    const up = all.filter((t) => inSelection(t, { kind: "view", view: "upcoming" }, TODAY, inbox));
    expect(
      groupTasks(up, { kind: "view", view: "upcoming" }, TODAY).map((g) => [g.key, g.tasks.length]),
    ).toEqual([
      ["tomorrow", 1],
      ["nextWeek", 1],
      ["later", 1],
    ]);
  });

  it("Inbox is ELISE's Inbox plus each provider's default list, identities kept apart", () => {
    expect(ids({ kind: "view", view: "inbox" }).sort()).toEqual(
      [tomorrow.id, nextWeek.id, later.id, googleInbox.id].sort(),
    );
  });

  it("Completed is its own view; open views never show done tasks", () => {
    expect(ids({ kind: "view", view: "completed" })).toEqual([done.id]);
    expect(ids({ kind: "view", view: "all" })).not.toContain(done.id);
  });

  it("counts match the views behind them", () => {
    expect(viewCounts(all, TODAY, inbox)).toMatchObject({ today: 2, overdue: 1, upcoming: 3 });
  });

  it("a list view is one provider list", () => {
    expect(ids({ kind: "list", listId: "g-general" })).toEqual([dueToday.id]);
  });
});

describe("search, filters and sorting", () => {
  const a = task({
    title: "Preparar propuesta Larrea",
    conn: GOOGLE,
    list: "g-general",
    priority: "high",
    labels: ["Ventas"],
    dueDate: "2026-10-14",
  });
  const b = task({ title: "Comprar pilas", description: "las AA del control", priority: "low" });
  const c = task({ title: "Llamar a Rod", labels: ["Trabajo"], dueDate: "2026-11-02" });

  it("search covers title, description, labels, list and account — with provenance kept", () => {
    expect(applyFilters([a, b, c], {}, TODAY, "control").map((t) => t.id)).toEqual([b.id]);
    expect(applyFilters([a, b, c], {}, TODAY, "ventas").map((t) => t.id)).toEqual([a.id]);
    expect(applyFilters([a, b, c], {}, TODAY, "firbot")[0]!.provenance.source).toBe(
      "Firbot Academy",
    );
  });

  it("filters combine: account + P1 + this week", () => {
    expect(
      applyFilters([a, b, c], { source: GOOGLE, priority: "high", thisWeek: true }, TODAY, "").map(
        (t) => t.id,
      ),
    ).toEqual([a.id]);
    expect(applyFilters([a, b, c], { label: "trabajo" }, TODAY, "").map((t) => t.id)).toEqual([
      c.id,
    ]);
  });

  it("sorts are presentation only (provider order is never rewritten)", () => {
    expect(sortTasks([b, c, a], "priority").map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(sortTasks([c, b, a], "due").map((t) => t.id)).toEqual([a.id, c.id, b.id]);
    const g1 = task({ position: "00002" });
    const g2 = task({ position: "00001" });
    expect(sortTasks([g1, g2], "manual").map((t) => t.id)).toEqual([g2.id, g1.id]);
    expect(g1.position).toBe("00002");
  });
});

describe("subtasks and URLs", () => {
  it("subtasks nest under a visible parent and stand alone otherwise", () => {
    const parent = task();
    const child = task({ parentId: parent.id });
    const orphan = task({ parentId: "not-shown" });
    expect(nest([child, parent, orphan]).map((r) => [r.task.id, r.depth])).toEqual([
      [parent.id, 0],
      [child.id, 1],
      [orphan.id, 0],
    ]);
  });

  it("selection round-trips through the URL; Today is the default entry", () => {
    expect(parseSelection({})).toEqual({ kind: "view", view: "today" });
    for (const sel of [
      { kind: "view", view: "overdue" },
      { kind: "list", listId: "x:abc:list:L1" },
      { kind: "label", name: "Ventas" },
    ] as const) {
      const q = Object.fromEntries(new URLSearchParams(selectionQuery(sel)));
      expect(parseSelection(q)).toEqual(sel);
    }
  });
});
