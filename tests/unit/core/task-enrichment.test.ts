import { describe, expect, it, vi } from "vitest";

import {
  taskCapabilities,
  type Task,
  type TaskProvider,
  type TaskQuery,
} from "@/core/capabilities/tasks";
import { makeExternalRef } from "@/core/providers/refs";
import {
  EnrichedTaskProvider,
  TaskEnrichmentStore,
} from "@/infrastructure/providers/task-enrichment";

/**
 * ADR-050: ELISE's enrichment over provider tasks — priority and labels for Google tasks live in
 * ELISE, keyed by the provider's identity; the provider task itself is never copied or changed.
 */

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST: the operations the enrichment store uses, workspace-scoped. */
function memoryDb(opts: { missing?: boolean } = {}) {
  const tables: Record<string, Row[]> = { labels: [], task_enrichments: [], label_assignments: [] };
  let seq = 0;
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row | Row[] = {};
    let single = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      insert: (rows: Row | Row[]) => ((op = "insert"), (payload = rows), q),
      upsert: (row: Row) => ((op = "upsert"), (payload = row), q),
      update: (patch: Row) => ((op = "update"), (payload = patch), q),
      delete: () => ((op = "delete"), q),
      single: () => ((single = true), q),
      then(resolve: (v: unknown) => unknown) {
        if (opts.missing) return resolve({ data: null, error: { code: "PGRST205", message: "" } });
        const rows = tables[table]!;
        const match = (r: Row) => filters.every((f) => f(r));
        let data: Row[] = [];
        if (op === "select") data = rows.filter(match);
        if (op === "insert" || op === "upsert") {
          for (const r of ([] as Row[]).concat(payload)) {
            const existing =
              op === "upsert"
                ? rows.find(
                    (x) =>
                      x.workspace_id === r.workspace_id &&
                      x.connection_id === r.connection_id &&
                      x.provider_task_id === r.provider_task_id,
                  )
                : undefined;
            if (existing) data.push(Object.assign(existing, r));
            else {
              const row = { id: `id-${++seq}`, priority: null, ...r };
              rows.push(row);
              data.push(row);
            }
          }
        }
        if (op === "update") data = rows.filter(match).map((r) => Object.assign(r, payload));
        if (op === "delete") {
          data = rows.filter(match);
          tables[table] = rows.filter((r) => !match(r));
          // ON DELETE CASCADE
          if (table === "task_enrichments")
            tables.label_assignments = tables.label_assignments!.filter(
              (a) => !data.some((e) => e.id === a.enrichment_id),
            );
        }
        return resolve({ data: single ? (data[0] ?? null) : data, error: null });
      },
    };
    return q;
  };
  return { db: { from } as never, tables };
}

const CONN = "11111111-1111-4111-8111-111111111111";

function googleTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id: makeExternalRef(CONN, "task", "L1", id),
    title,
    description: null,
    notes: null,
    status: "pending",
    priority: null,
    category: null,
    parentId: null,
    dueDate: null,
    completedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    provenance: {
      providerKey: "google",
      connectionId: CONN,
      externalId: id,
      source: "Firbot Academy",
      listId: makeExternalRef(CONN, "list", "L1"),
      listName: "General",
    },
    ...extra,
  };
}

/** A fake Google provider that refuses what Google can't store, like the real adapter. */
function fakeGoogle(tasks: Task[]) {
  const store = new Map(tasks.map((t) => [t.id, t]));
  const inner: TaskProvider = {
    listLists: async () => [],
    list: async (q: TaskQuery) =>
      [...store.values()].filter((t) => (q.status === "open" ? t.status === "pending" : true)),
    get: async (id) => store.get(id) ?? null,
    create: vi.fn(async (input) => {
      if (input.priority) throw new Error("Google has no priority");
      const t = googleTask(`n${store.size}`, input.title);
      store.set(t.id, t);
      return t;
    }),
    update: vi.fn(async (input) => {
      if (input.priority !== undefined) throw new Error("Google has no priority");
      const t = { ...store.get(input.taskId)!, ...(input.title ? { title: input.title } : {}) };
      store.set(t.id, t);
      return t;
    }),
    complete: async (id) => store.get(id)!,
    reopen: async (id) => store.get(id)!,
    archive: async (id) => {
      const t = store.get(id)!;
      store.delete(id);
      return t;
    },
  };
  return { inner, store };
}

function setup(tasks: Task[], opts: { missing?: boolean } = {}) {
  const { db, tables } = memoryDb(opts);
  const google = fakeGoogle(tasks);
  const store = new TaskEnrichmentStore(db, "ws1");
  const provider = new EnrichedTaskProvider(google.inner, store, "google", CONN);
  return { provider, tables, google };
}

describe("ELISE enrichment over Google tasks (ADR-050)", () => {
  it("P1 and a label on a Google task stay in ELISE: Google's task is untouched, not copied", async () => {
    const { provider, tables, google } = setup([googleTask("g1", "Preparar propuesta Larrea")]);
    const id = makeExternalRef(CONN, "task", "L1", "g1");
    const task = await provider.update({ taskId: id, priority: "high", addLabels: ["Ventas"] });
    expect(task).toMatchObject({
      priority: "high",
      labels: ["Ventas"],
      title: "Preparar propuesta Larrea",
    });
    // Google never received a priority or a label.
    expect(google.inner.update).not.toHaveBeenCalled();
    // One enrichment row with only identity + priority; no title/status/due copied.
    expect(tables.task_enrichments).toHaveLength(1);
    expect(Object.keys(tables.task_enrichments![0]!).sort()).toEqual(
      [
        "connection_id",
        "id",
        "priority",
        "provider_key",
        "provider_list_id",
        "provider_task_id",
        "workspace_id",
      ].sort(),
    );
    expect(tables.task_enrichments![0]).toMatchObject({
      provider_task_id: "g1",
      provider_list_id: "L1",
    });
  });

  it("enrichment survives provider changes (rename in Google) while the identity exists", async () => {
    const { provider, google } = setup([googleTask("g1", "Old")]);
    const id = makeExternalRef(CONN, "task", "L1", "g1");
    await provider.update({ taskId: id, addLabels: ["Esperando"] });
    google.store.set(id, { ...google.store.get(id)!, title: "Renamed in Google" });
    const [t] = await provider.list({ status: "open", limit: 20 });
    expect(t).toMatchObject({ title: "Renamed in Google", labels: ["Esperando"] });
  });

  it("filters by ELISE priority and label, and search covers labels", async () => {
    const { provider } = setup([googleTask("g1", "Uno"), googleTask("g2", "Dos")]);
    await provider.update({ taskId: makeExternalRef(CONN, "task", "L1", "g1"), priority: "high" });
    await provider.update({
      taskId: makeExternalRef(CONN, "task", "L1", "g2"),
      addLabels: ["Ventas"],
    });
    expect(
      (await provider.list({ status: "open", limit: 20, priority: "high" })).map((t) => t.title),
    ).toEqual(["Uno"]);
    expect(
      (await provider.list({ status: "open", limit: 20, label: "ventas" })).map((t) => t.title),
    ).toEqual(["Dos"]);
    expect(
      (await provider.list({ status: "open", limit: 20, search: "venta" })).map((t) => t.title),
    ).toEqual(["Dos"]);
  });

  it("creating with a priority on Google stores it in ELISE, never sends it to Google", async () => {
    const { provider, google } = setup([]);
    const t = await provider.create(
      { title: "Llamar a Rod", priority: "high", labels: ["Trabajo"] },
      {
        userId: "u",
        source: "ai",
      },
    );
    expect(google.inner.create).toHaveBeenCalledWith({ title: "Llamar a Rod" }, expect.anything());
    expect(t).toMatchObject({ priority: "high", labels: ["Trabajo"] });
  });

  it("deleting the provider task removes its ELISE metadata (labels cascade)", async () => {
    const { provider, tables } = setup([googleTask("g1", "Uno")]);
    const id = makeExternalRef(CONN, "task", "L1", "g1");
    await provider.update({ taskId: id, priority: "low", addLabels: ["Casa"] });
    await provider.archive(id);
    expect(tables.task_enrichments).toHaveLength(0);
    expect(tables.label_assignments).toHaveLength(0);
    // The label itself stays reusable.
    expect(tables.labels).toHaveLength(1);
  });

  it("a task deleted in Google is cleaned up after a full read (sweep)", async () => {
    const { provider, tables, google } = setup([googleTask("g1", "Uno")]);
    const id = makeExternalRef(CONN, "task", "L1", "g1");
    await provider.update({ taskId: id, addLabels: ["Casa"] });
    google.store.delete(id); // deleted outside ELISE
    expect(await provider.list({ status: "open", limit: 20 })).toEqual([]);
    await vi.waitFor(() => expect(tables.task_enrichments).toHaveLength(0));
  });

  it("labels are reused case-insensitively and never duplicated", async () => {
    const { provider, tables } = setup([googleTask("g1", "Uno"), googleTask("g2", "Dos")]);
    await provider.update({
      taskId: makeExternalRef(CONN, "task", "L1", "g1"),
      addLabels: ["Ventas"],
    });
    await provider.update({
      taskId: makeExternalRef(CONN, "task", "L1", "g2"),
      addLabels: ["ventas "],
    });
    expect(tables.labels).toHaveLength(1);
    const labels = await provider.manageLabels({ action: "list" });
    expect(labels).toEqual([{ name: "Ventas", count: 2 }]);
  });

  it("before the migration is applied, tasks still list (unenriched) and label writes say why", async () => {
    const { provider } = setup([googleTask("g1", "Uno")], { missing: true });
    expect(await provider.list({ status: "open", limit: 20 })).toMatchObject([
      { title: "Uno", labels: [] },
    ]);
    await expect(
      provider.update({ taskId: makeExternalRef(CONN, "task", "L1", "g1"), addLabels: ["X"] }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("task capability matrix", () => {
  it("Google: no native priority, labels or due time; subtasks and list moves are real", () => {
    expect(taskCapabilities("google")).toMatchObject({
      priority: "elise",
      labels: "elise",
      dueTime: false,
      subtasks: true,
      moveBetweenLists: true,
    });
    expect(taskCapabilities("elise_native").priority).toBe("provider");
    expect(taskCapabilities("someday").subtasks).toBe(false);
  });
});
