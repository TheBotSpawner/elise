import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import {
  inTaskView,
  matchTaskLists,
  taskCounts,
  type CreateTaskInput,
  type Task,
} from "@/core/capabilities/tasks";
import { makeExternalRef } from "@/core/providers/refs";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import { GoogleTasksProvider, normalizeTask } from "@/infrastructure/providers/google/tasks";

import {
  binding,
  InMemoryTaskProvider,
  makeCtx,
  makePorts,
  NATIVE_BINDING,
} from "../../fixtures/core-fakes";

const PERSONAL = "11111111-1111-4111-8111-111111111111";
const FIRBOT = "22222222-2222-4222-8222-222222222222";
const TODAY = "2026-09-29"; // makeCtx: 2026-09-29 in Buenos Aires

function seed(p: InMemoryTaskProvider, n: number, over: Partial<Task>) {
  for (let i = 0; i < n; i++) {
    void p
      .create({ title: `${over.title ?? "t"} ${i}` } as CreateTaskInput)
      .then((t) => Object.assign(t, over, { title: t.title }));
  }
}

async function setup() {
  const personal = new InMemoryTaskProvider(PERSONAL, "Personal", "google");
  const firbot = new InMemoryTaskProvider(FIRBOT, "Firbot Academy", "google");
  const bindings = [
    NATIVE_BINDING,
    binding({ connectionId: PERSONAL, providerKey: "google", label: "Personal" }),
    binding({
      connectionId: FIRBOT,
      providerKey: "google",
      label: "Firbot Academy",
      contextLabel: "Firbot",
    }),
  ];
  const { ports, tasks: native } = makePorts(bindings, { [PERSONAL]: personal, [FIRBOT]: firbot });
  // Lots of completed work must never crowd out open tasks.
  seed(native, 60, { status: "completed", completedAt: "2026-09-01T00:00:00Z" });
  seed(native, 4, { dueDate: "2026-09-20", title: "native overdue" });
  seed(personal, 3, { dueDate: TODAY, title: "personal today" });
  seed(personal, 2, { dueDate: "2026-09-10", title: "personal overdue" });
  seed(firbot, 4, { dueDate: "2026-09-01", title: "firbot overdue" });
  seed(firbot, 40, { status: "completed", completedAt: "2026-09-02T00:00:00Z" });
  await new Promise((r) => setTimeout(r, 0));
  return { ports, native, personal, firbot };
}

async function list(ports: Awaited<ReturnType<typeof setup>>["ports"], args: object) {
  const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args });
  if (out.status !== "succeeded" || out.display?.kind !== "task_list")
    throw new Error("list failed");
  return out.display.tasks;
}

describe("unified tasks (ELISE + two Google accounts)", () => {
  it("lists every open task across accounts, each once, with its own provenance", async () => {
    const { ports } = await setup();
    const open = await list(ports, { status: "open", limit: 500 });
    expect(open).toHaveLength(13);
    expect(new Set(open.map((t) => t.id)).size).toBe(13);
    const bySource = open.reduce<Record<string, number>>((m, t) => {
      m[t.provenance.source] = (m[t.provenance.source] ?? 0) + 1;
      return m;
    }, {});
    expect(bySource).toEqual({ ELISE: 4, Personal: 5, "Firbot Academy": 4 });
    expect(
      open.filter((t) => t.provenance.providerKey === "google").every((t) => t.id.startsWith("x:")),
    ).toBe(true);
  });

  it("counts today and overdue with the same definitions the list uses", async () => {
    const { ports } = await setup();
    const open = await list(ports, { status: "open", limit: 500 });
    const counts = taskCounts(open, TODAY);
    expect(counts).toEqual({ open: 13, dueToday: 3, overdue: 10 });
    // The Overdue view shows exactly what the Home counter counts.
    expect(open.filter((t) => inTaskView(t, "overdue", TODAY))).toHaveLength(counts.overdue);
    const overdue = await list(ports, { status: "open", due: "overdue", limit: 500 });
    expect(overdue).toHaveLength(counts.overdue);
  });

  it("returns recent completed tasks newest first only when asked", async () => {
    const { ports } = await setup();
    const done = await list(ports, { status: "completed", limit: 50 });
    expect(done).toHaveLength(50);
    expect(done.every((t) => t.status === "completed")).toBe(true);
    expect(done[0]!.completedAt! >= done.at(-1)!.completedAt!).toBe(true);
  });

  it("routes a new task to the account its list belongs to", async () => {
    const { ports, native, personal, firbot } = await setup();
    const before = { n: native.tasks.size, p: personal.tasks.size, f: firbot.tasks.size };
    const out = await executeToolCall(ports, makeCtx({ origin: "user_ui" }), {
      name: "tasks.create",
      args: { title: "Test Firbot task", list: makeExternalRef(FIRBOT, "list", "clients") },
    });
    expect(out.status).toBe("succeeded");
    expect(firbot.tasks.size).toBe(before.f + 1);
    expect(native.tasks.size + personal.tasks.size).toBe(before.n + before.p);
    // By account name, as said in chat ("add this to Personal").
    await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "Test Personal task", destination: "Personal" },
    });
    expect(personal.tasks.size).toBe(before.p + 1);
  });
});

describe("task lists", () => {
  it("matches a named list by id, exact name, then partial name", () => {
    const lists = [
      { id: "a", name: "My Tasks" },
      { id: "b", name: "Clients" },
      { id: "c", name: "Clients 2025" },
    ];
    expect(matchTaskLists(lists, "b").map((l) => l.id)).toEqual(["b"]);
    expect(matchTaskLists(lists, "clients").map((l) => l.id)).toEqual(["b"]);
    expect(matchTaskLists(lists, "client").map((l) => l.id)).toEqual(["b", "c"]);
    expect(matchTaskLists(lists, "trips")).toEqual([]);
  });

  it("keeps Google's list identity scoped to the connection", () => {
    const t = normalizeTask(
      { id: "g1", title: "Call RSFA", status: "needsAction" },
      { id: "L1", title: "Clients" },
      { connectionId: FIRBOT, label: "Firbot Academy" },
    );
    expect(t.provenance).toMatchObject({
      providerKey: "google",
      connectionId: FIRBOT,
      source: "Firbot Academy",
      listName: "Clients",
      listId: makeExternalRef(FIRBOT, "list", "L1"),
    });
  });

  it("reads every Google list and page, and resolves a list by name when creating", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/users/@me/lists")) {
        const page2 = url.includes("pageToken=p2");
        return Response.json(
          page2
            ? { items: [{ id: "L2", title: "Clients" }] }
            : { items: [{ id: "L1", title: "General" }], nextPageToken: "p2" },
        );
      }
      if (init?.method === "POST") return Response.json({ id: "new", title: "Send proposal" });
      const second = url.includes("pageToken=t2");
      if (url.includes("/lists/L1/"))
        return Response.json(
          second
            ? { items: [{ id: "b", title: "Two", status: "needsAction" }] }
            : { items: [{ id: "a", title: "One", status: "needsAction" }], nextPageToken: "t2" },
        );
      return Response.json({ items: [{ id: "c", title: "Three", status: "needsAction" }] });
    });
    const provider = new GoogleTasksProvider(
      { connectionId: FIRBOT, label: "Firbot Academy" },
      new GoogleHttp({ accessToken: async () => "token" }, fetchImpl),
    );
    const lists = await provider.listLists();
    expect(lists.map((l) => [l.name, l.isDefault])).toEqual([
      ["General", true],
      ["Clients", false],
    ]);
    const tasks = await provider.list({ status: "open", limit: 500 });
    expect(tasks.map((t) => t.title).sort()).toEqual(["One", "Three", "Two"]);
    const created = await provider.create({ title: "Send proposal", list: "clients" });
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/lists/L2/tasks"))).toBe(true);
    expect(created.provenance.listName).toBe("Clients");
    await expect(provider.create({ title: "x", list: "Trips" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});
