import { describe, expect, it, vi } from "vitest";

import type { Task, TaskProvider } from "@/core/capabilities/tasks";
import {
  EnrichedTaskProvider,
  TaskEnrichmentStore,
} from "@/infrastructure/providers/task-enrichment";
import { TaskRecurrenceStore } from "@/infrastructure/providers/task-recurrence";

/** ADR-115: a recurring task keeps one live occurrence; completing it creates the next. */

type Row = Record<string, unknown>;

/** Just enough PostgREST for the two stores, workspace-scoped like the real one. */
function memoryDb() {
  const tables: Record<string, Row[]> = {
    labels: [],
    task_enrichments: [],
    label_assignments: [],
    task_recurrences: [],
  };
  let seq = 0;
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let single = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      insert: (row: Row) => ((op = "insert"), (payload = row), q),
      update: (patch: Row) => ((op = "update"), (payload = patch), q),
      single: () => ((single = true), q),
      then(resolve: (v: unknown) => unknown) {
        const rows = tables[table]!;
        const match = (r: Row) => filters.every((f) => f(r));
        let data: Row[] = [];
        if (op === "select") data = rows.filter(match);
        if (op === "insert") {
          const row = { id: `r${++seq}`, status: "active", occurrences: 1, ...payload };
          rows.push(row);
          data = [row];
        }
        if (op === "update") data = rows.filter(match).map((r) => Object.assign(r, payload));
        return resolve({ data: single ? (data[0] ?? null) : data, error: null });
      },
    };
    return q;
  };
  return { db: { from } as never, tables };
}

const CONN = "11111111-1111-4111-8111-111111111111";

function nativeTasks() {
  const store = new Map<string, Task>();
  let n = 0;
  const make = (title: string, dueDate: string | null): Task => {
    const id = `t${++n}`;
    return {
      id,
      title,
      description: null,
      notes: null,
      status: "pending",
      priority: null,
      category: null,
      parentId: null,
      dueDate,
      completedAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      provenance: {
        providerKey: "elise_native",
        connectionId: CONN,
        externalId: id,
        source: "ELISE",
        listId: "inbox",
      },
    };
  };
  const inner: TaskProvider = {
    listLists: async () => [],
    list: async () => [...store.values()].filter((t) => t.status === "pending"),
    get: async (id) => store.get(id) ?? null,
    create: vi.fn(async (input) => {
      const t = make(input.title, input.dueDate ?? null);
      store.set(t.id, t);
      return t;
    }),
    update: vi.fn(async (input) => {
      const t = {
        ...store.get(input.taskId)!,
        ...(input.title ? { title: input.title } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
      };
      store.set(t.id, t);
      return t;
    }),
    complete: async (id) => {
      const t = { ...store.get(id)!, status: "completed" as const };
      store.set(id, t);
      return t;
    },
    reopen: async (id) => store.get(id)!,
    archive: async (id) => store.get(id)!,
  };
  return { inner, store };
}

function setup() {
  const { db, tables } = memoryDb();
  const tasks = nativeTasks();
  const series = new TaskRecurrenceStore(
    db,
    "ws1",
    "user1",
    "America/Argentina/Buenos_Aires",
    "es",
  );
  const provider = new EnrichedTaskProvider(
    tasks.inner,
    new TaskEnrichmentStore(db, "ws1"),
    "elise_native",
    CONN,
    series,
  );
  return { provider, tables, tasks };
}

const meta = { userId: "user1", source: "user_ui" as const };
// Far-future dates so "skip what's already past" never interferes.
const MONDAY = "2030-01-07";

describe("recurring tasks over a provider", () => {
  it("creating with a rule stores the series and says it in words", async () => {
    const { provider, tables } = setup();
    const t = await provider.create(
      {
        title: "Sacar la basura",
        dueDate: MONDAY,
        repeat: { freq: "weekly", interval: 1, days: ["mo"] },
      },
      meta,
    );
    expect(tables.task_recurrences).toHaveLength(1);
    expect(tables.task_recurrences![0]).toMatchObject({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      dtstart: MONDAY,
      current_task_id: t.provenance.externalId,
    });
    expect(t.recurrence?.summary).toBe("Todas las semanas, los lunes");
  });

  it("completing creates exactly the next occurrence — once, even if completed twice", async () => {
    const { provider, tasks } = setup();
    const t = await provider.create(
      {
        title: "Pagar el alquiler",
        dueDate: "2030-01-10",
        repeat: { freq: "monthly", interval: 1 },
      },
      meta,
    );
    const done = await provider.complete(t.id);
    expect(done.recurrence?.next).toBe("2030-02-10");
    const open = [...tasks.store.values()].filter((x) => x.status === "pending");
    expect(open.map((x) => [x.title, x.dueDate])).toEqual([["Pagar el alquiler", "2030-02-10"]]);
    await provider.complete(t.id);
    expect([...tasks.store.values()].filter((x) => x.status === "pending")).toHaveLength(1);
  });

  it("COUNT ends the series: no task after the last one", async () => {
    const { provider, tasks, tables } = setup();
    const t = await provider.create(
      { title: "Sesión", dueDate: MONDAY, repeat: { freq: "daily", interval: 1, count: 1 } },
      meta,
    );
    const done = await provider.complete(t.id);
    expect(done.recurrence?.next).toBeNull();
    expect([...tasks.store.values()].filter((x) => x.status === "pending")).toHaveLength(0);
    expect(tables.task_recurrences![0]!.status).toBe("ended");
  });

  it("'solo esta' changes the occurrence; 'toda la serie' what the next ones copy", async () => {
    const { provider, tables } = setup();
    const t = await provider.create(
      { title: "Regar", dueDate: MONDAY, repeat: { freq: "daily", interval: 1 } },
      meta,
    );
    await provider.update({ taskId: t.id, title: "Regar el balcón", repeatScope: "this" });
    expect((tables.task_recurrences![0]!.template as { title: string }).title).toBe("Regar");
    await provider.update({ taskId: t.id, title: "Regar las plantas", repeatScope: "all" });
    expect((tables.task_recurrences![0]!.template as { title: string }).title).toBe(
      "Regar las plantas",
    );
  });

  it("'esta y las siguientes' ends the series here and starts a new one", async () => {
    const { provider, tables } = setup();
    const t = await provider.create(
      { title: "Gym", dueDate: MONDAY, repeat: { freq: "weekly", interval: 1, days: ["mo"] } },
      meta,
    );
    await provider.update({
      taskId: t.id,
      repeat: { freq: "weekly", interval: 1, days: ["mo", "we", "fr"] },
      repeatScope: "following",
    });
    expect(tables.task_recurrences!.map((r) => [r.status, r.rrule])).toEqual([
      ["ended", "FREQ=WEEKLY;BYDAY=MO"],
      ["active", "FREQ=WEEKLY;BYDAY=MO,WE,FR"],
    ]);
  });

  it("'que no se repita más' ends it and keeps the task", async () => {
    const { provider, tables, tasks } = setup();
    const t = await provider.create(
      { title: "Vitaminas", dueDate: MONDAY, repeat: { freq: "daily", interval: 1 } },
      meta,
    );
    const after = await provider.update({ taskId: t.id, repeat: null });
    expect(tables.task_recurrences![0]!.status).toBe("ended");
    expect(after.recurrence).toBeUndefined();
    expect(tasks.store.get(t.id)?.status).toBe("pending");
  });

  it("a task without a date starts at the rule's first date", async () => {
    const { provider } = setup();
    const t = await provider.create(
      { title: "Backup", repeat: { freq: "weekly", interval: 1, days: ["fr"] } },
      meta,
    );
    expect(t.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${t.dueDate}T00:00:00Z`).getUTCDay()).toBe(5);
  });
});
