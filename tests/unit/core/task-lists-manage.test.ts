import { describe, expect, it, vi } from "vitest";

import type { Task, TaskList, TaskProvider } from "@/core/capabilities/tasks";
import { makeExternalRef } from "@/core/providers/refs";
import {
  EnrichedTaskProvider,
  TaskEnrichmentStore,
} from "@/infrastructure/providers/task-enrichment";

/**
 * Deleting a list: an ELISE list is deleted; a Google Tasks list is only removed from ELISE
 * (hidden for this user) and Google is never asked to delete it.
 */

type Row = Record<string, unknown>;

function memoryDb() {
  const tables: Record<string, Row[]> = {
    labels: [],
    task_enrichments: [],
    label_assignments: [],
    user_preferences: [],
  };
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let op: "select" | "upsert" = "select";
    let payload: Row = {};
    let single = false;
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      upsert: (row: Row) => ((op = "upsert"), (payload = row), q),
      maybeSingle: () => ((single = true), q),
      then(resolve: (v: unknown) => unknown) {
        const rows = tables[table]!;
        if (op === "upsert") {
          const i = rows.findIndex((r) => r.key === payload.key && r.user_id === payload.user_id);
          if (i >= 0) rows[i] = payload;
          else rows.push(payload);
          return resolve({ data: null, error: null });
        }
        const data = rows.filter((r) => filters.every((f) => f(r)));
        return resolve({ data: single ? (data[0] ?? null) : data, error: null });
      },
    };
    return q;
  };
  return { db: { from } as never, tables };
}

const CONN = "11111111-1111-4111-8111-111111111111";
const L1 = makeExternalRef(CONN, "list", "L1");
const L2 = makeExternalRef(CONN, "list", "L2");

const list = (id: string, name: string): TaskList => ({
  id,
  name,
  isDefault: false,
  provenance: { providerKey: "google", connectionId: CONN, source: "Personal" },
});

const task = (id: string, listId: string): Task => ({
  id: makeExternalRef(CONN, "task", listId, id),
  title: id,
  description: null,
  notes: null,
  status: "pending",
  priority: null,
  category: null,
  dueDate: null,
  completedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  provenance: {
    providerKey: "google",
    connectionId: CONN,
    externalId: id,
    source: "Personal",
    listId,
  },
});

describe("removing a Google Tasks list from ELISE", () => {
  it("hides the list and its tasks for this user; Google is never asked to delete", async () => {
    const { db } = memoryDb();
    const inner: TaskProvider = {
      listLists: async () => [list(L1, "Pagos"), list(L2, "Shopping")],
      list: async () => [task("a", L1), task("b", L2)],
      get: async () => null,
      create: vi.fn(),
      update: vi.fn(),
      complete: vi.fn(),
      reopen: vi.fn(),
      archive: vi.fn(),
      deleteList: vi.fn(),
    };
    const p = new EnrichedTaskProvider(
      inner,
      new TaskEnrichmentStore(db, "ws1", "user1"),
      "google",
      CONN,
    );
    expect(await p.deleteList(L1)).toEqual({ removedFrom: "elise" });
    expect(inner.deleteList).not.toHaveBeenCalled();

    // A new request (fresh store) reads the preference.
    const again = new EnrichedTaskProvider(
      inner,
      new TaskEnrichmentStore(db, "ws1", "user1"),
      "google",
      CONN,
    );
    expect((await again.listLists()).map((l) => l.name)).toEqual(["Shopping"]);
    expect((await again.list({ status: "open", limit: 50 })).map((t) => t.title)).toEqual(["b"]);
    // Another user still sees it.
    const other = new EnrichedTaskProvider(
      inner,
      new TaskEnrichmentStore(db, "ws1", "user2"),
      "google",
      CONN,
    );
    expect(await other.listLists()).toHaveLength(2);
  });

  it("an ELISE list is deleted by its own provider", async () => {
    const { db } = memoryDb();
    const deleteList = vi.fn(async () => ({ removedFrom: "everywhere" as const }));
    const inner = { listLists: async () => [], deleteList } as unknown as TaskProvider;
    const p = new EnrichedTaskProvider(
      inner,
      new TaskEnrichmentStore(db, "ws1", "user1"),
      "elise_native",
      CONN,
    );
    expect(await p.deleteList("list-uuid")).toEqual({ removedFrom: "everywhere" });
    expect(deleteList).toHaveBeenCalledWith("list-uuid");
  });
});
