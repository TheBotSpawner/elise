import { describe, expect, it } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession, type ReadRunner } from "@/application/workspace-service";
import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import {
  checkInDate,
  habitProgress,
  type Habit,
  type HabitEntry,
} from "@/core/capabilities/habits";
import type { Task } from "@/core/capabilities/tasks";
import { changeOf } from "@/core/workspace/lifecycle";
import { applyOps, emptyWorkspace, type Surface, type SurfaceDraft } from "@/core/workspace/model";
import { parseWorkspace, type SurfacePayloads } from "@/core/workspace/registry";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * The Canvas is the current work (ADR-031): the same data in another form replaces the old view,
 * "mostramelo" is the thing just changed, "mostralas" the collection being discussed. And past
 * Habit days are the user's to correct. Synthetic data; no providers.
 */

const AT = "2026-10-03T15:00:00.000Z";
const TODAY = "2026-10-03"; // a Saturday

const auth = {
  userId: "user-1",
  workspaceId: "ws-1",
  profile: { locale: "es", timezone: "America/Argentina/Buenos_Aires" },
  db: { from: () => ({ upsert: async () => ({ error: null }) }) },
} as unknown as AuthContext;

const task = (id: string, title: string, dueDate: string | null): Task =>
  ({
    id,
    title,
    description: null,
    notes: null,
    status: "pending",
    priority: null,
    category: null,
    dueDate,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    listName: "Personal",
    provenance: { providerKey: "elise_native", connectionId: "c", externalId: id, source: "ELISE" },
  }) as unknown as Task;

const listed = (tasks: Task[]): ToolCallOutcome => ({
  status: "succeeded",
  output: {},
  display: { kind: "task_list", tasks },
  actionId: null,
  providerLabel: "elise_native",
});

const overdueQuery = { tool: "tasks.list", args: { due: "overdue" } };

function draft(id: string, dataset: string, over: Partial<SurfaceDraft> = {}): SurfaceDraft {
  return {
    id,
    type: "links",
    title: id,
    state: "ready",
    priority: 50,
    size: "medium",
    source: null,
    ref: null,
    payload: { links: [] },
    actions: [],
    intentId: null,
    dataset,
    ...over,
  } as SurfaceDraft;
}

describe("same data, another form: replace, never accumulate", () => {
  it("a new view of the same dataset replaces the old one — its place, handle and Focus", () => {
    let s = applyOps(emptyWorkspace(), [
      { op: "present", surface: draft("other", "x"), at: AT },
      { op: "present", surface: draft("list", "tasks:overdue"), at: AT },
    ]);
    s = applyOps(s, [{ op: "focus", id: "list", at: AT }]);
    s = applyOps(s, [{ op: "present", surface: draft("timeline", "tasks:overdue"), at: AT }]);
    expect(s.surfaces.map((x) => x.id)).toEqual(["other", "timeline"]);
    expect(s.surfaces[1]!.handle).toBe("S2");
    expect(s.focusId).toBe("timeline");
  });

  it("keep shows both; a pinned view stays (and is still a live view)", () => {
    const base = applyOps(emptyWorkspace(), [
      { op: "present", surface: draft("list", "d"), at: AT },
    ]);
    expect(
      applyOps(base, [{ op: "present", surface: draft("tl", "d"), at: AT, keep: true }]).surfaces,
    ).toHaveLength(2);
    const pinned = applyOps(base, [{ op: "pin", id: "list", pinned: true, at: AT }]);
    expect(
      applyOps(pinned, [{ op: "present", surface: draft("tl", "d"), at: AT }]).surfaces.map(
        (x) => x.id,
      ),
    ).toEqual(["list", "tl"]);
  });

  it("different datasets coexist; reload never resurrects a replaced view", () => {
    const s = applyOps(emptyWorkspace(), [
      { op: "present", surface: draft("a", "d1"), at: AT },
      { op: "present", surface: draft("b", "d2"), at: AT },
      { op: "present", surface: draft("c", "d1"), at: AT },
    ]);
    const restored = parseWorkspace(JSON.parse(JSON.stringify(s)));
    expect(restored.surfaces.map((x) => [x.id, x.dataset])).toEqual([
      ["c", "d1"],
      ["b", "d2"],
    ]);
  });
});

/** The reported flow: overdue → create → "mostramelo" → "como línea de tiempo" → "como tabla". */
describe("the task flow", () => {
  const overdue = [
    task("t1", "Pagar luz", "2026-09-28"),
    task("t2", "Llamar al banco", "2026-09-30"),
  ];
  const created = task("t3", "Preparar bohíos", TODAY);

  async function setup() {
    const session = new WorkspaceSession(auth, { kind: "conversation", id: "c" }, emptyWorkspace());
    session.apply([{ op: "turn", at: AT }]);
    session.present("tasks.list", "call-1", listed(overdue), overdueQuery);
    return session;
  }
  const read: ReadRunner = async () => listed(overdue);
  const ui = (session: WorkspaceSession, args: unknown) => {
    // The task backend: a re-read of the collection finds the same overdue tasks.
    const { ports, tasks } = makePorts();
    for (const t of overdue) tasks.tasks.set(t.id, t);
    return executeToolCall(ports, makeCtx({ workspace: session, now: new Date(AT) }), {
      name: "ui.show",
      args,
    });
  };
  const visible = (session: WorkspaceSession) =>
    session.state().surfaces.map((s) => `${s.type}${s.presentation ? `:${s.presentation}` : ""}`);

  it("a task created outside the visible collection gets its card (it was suppressed before)", async () => {
    const session = await setup();
    const change = changeOf(
      "tasks.create",
      { name: "create", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "t3" } },
    )!;
    await session.reconcile(change, read);
    session.present(
      "tasks.create",
      "call-2",
      {
        status: "succeeded",
        output: {},
        display: { kind: "task", task: created, change: "created" },
        actionId: "a",
        providerLabel: "elise_native",
      },
      null,
      change,
    );
    expect(visible(session)).toEqual(["task_list:list", "task"]);

    // "Mostramelo" → the task just created, not the old overdue list.
    await ui(session, { what: "last_changed" });
    const focused = session.state().surfaces.find((s) => s.id === session.state().focusId)!;
    expect(focused.type).toBe("task");

    // "Mostrame estas tareas como línea de tiempo" → the overdue list becomes a timeline.
    const listHandle = session.state().surfaces[0]!.handle;
    const out = await ui(session, { what: "collection", as: "timeline" });
    expect(out).toMatchObject({ status: "succeeded", output: { shown: "timeline", items: 2 } });
    expect(visible(session)).toEqual(["visualization:timeline", "task"]);
    expect(session.state().surfaces[0]!.handle).toBe(listHandle);

    // "Como tabla" → the timeline becomes a table of the same two tasks.
    await ui(session, { what: "collection", as: "table" });
    expect(visible(session)).toEqual(["visualization:table", "task"]);
    const spec = (session.state().surfaces[0]!.payload as SurfacePayloads["visualization"]).spec;
    expect(spec.type === "table" && spec.rows.map((r) => r[0])).toEqual([
      "Pagar luz",
      "Llamar al banco",
    ]);
  });

  it("a timeline keeps its form when its tasks change (refreshed, not reverted to a list)", async () => {
    const session = await setup();
    await ui(session, { what: "collection", as: "timeline" });
    const remaining = [overdue[1]!];
    const change = changeOf(
      "tasks.update",
      { name: "update", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "t1" } },
    )!;
    // t1's due date moved to the future: it leaves the overdue dataset.
    await session.reconcile(change, async () => listed(remaining));
    const s = session.state().surfaces[0]!;
    expect(s.presentation).toBe("timeline");
    const spec = (s.payload as SurfacePayloads["visualization"]).spec;
    expect(spec.type === "temporal" && spec.events.map((e) => e.title)).toEqual([
      "Llamar al banco",
    ]);
  });

  it("a task created into a visible collection is shown there — no extra card; deletes get none", async () => {
    const session = new WorkspaceSession(auth, { kind: "conversation", id: "c" }, emptyWorkspace());
    session.present("tasks.list", "call-1", listed([task("a", "A", TODAY)]), {
      tool: "tasks.list",
      args: { due: "today" },
    });
    const change = changeOf(
      "tasks.create",
      { name: "create", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "b" } },
    )!;
    await session.reconcile(change, async () =>
      listed([task("a", "A", TODAY), task("b", "B", TODAY)]),
    );
    session.present(
      "tasks.create",
      "x",
      {
        status: "succeeded",
        output: {},
        display: { kind: "task", task: task("b", "B", TODAY), change: "created" },
        actionId: "a",
        providerLabel: "p",
      },
      null,
      change,
    );
    const surfaces: Surface[] = session.state().surfaces;
    expect(surfaces).toHaveLength(1);
    expect((surfaces[0]!.payload as SurfacePayloads["task_list"]).items.map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
    expect(surfaces[0]!.focusItem).toBe("b");
    expect(surfaces[0]!.changedAt).toBeTruthy();

    const del = changeOf(
      "tasks.delete",
      { name: "delete", kind: "destructive" },
      { status: "succeeded", target: { type: "task", id: "b" } },
    )!;
    session.present(
      "tasks.delete",
      "y",
      {
        status: "succeeded",
        output: {},
        display: { kind: "task", task: task("b", "B", TODAY), change: "deleted" },
        actionId: "a",
        providerLabel: "p",
      },
      null,
      del,
    );
    expect(session.state().surfaces.filter((s) => s.type === "task")).toHaveLength(0);
  });

  it("reading the same collection with another page size is the same data: one view", () => {
    const session = new WorkspaceSession(auth, { kind: "conversation", id: "c" }, emptyWorkspace());
    session.present("tasks.list", "a", listed(overdue), {
      tool: "tasks.list",
      args: { status: "open", limit: 20 },
    });
    const handle = session.state().surfaces[0]!.handle;
    session.present("tasks.list", "b", listed(overdue), {
      tool: "tasks.list",
      args: { status: "open", limit: 500 },
    });
    expect(visible(session)).toEqual(["task_list:list"]);
    expect(session.state().surfaces[0]!.handle).toBe(handle);
  });

  it("the same holds when the collection is shown as a table (its rows carry no ids)", async () => {
    const session = await setup();
    await ui(session, { what: "collection", as: "table" });
    expect(session.state().surfaces[0]!.members).toEqual(["t1", "t2"]);
    const change = changeOf(
      "tasks.create",
      { name: "create", kind: "write" },
      { status: "succeeded", target: { type: "task", id: "t3" } },
    )!;
    await session.reconcile(change, async () => listed([...overdue, created]));
    session.present(
      "tasks.create",
      "x",
      {
        status: "succeeded",
        output: {},
        display: { kind: "task", task: created, change: "created" },
        actionId: "a",
        providerLabel: "p",
      },
      null,
      change,
    );
    expect(visible(session)).toEqual(["visualization:table"]);
    expect(session.state().surfaces[0]).toMatchObject({
      members: ["t1", "t2", "t3"],
      focusItem: "t3",
    });
    // Persisted with the Surface: a reload knows what the table holds.
    expect(parseWorkspace(session.state()).surfaces[0]!.members).toEqual(["t1", "t2", "t3"]);
  });
});

// ── Habit history belongs to the user ───────────────────────────────────────

const habit = (over: Partial<Habit> = {}): Habit =>
  ({
    id: "h1",
    name: "Workout",
    frequency: "daily",
    preferredDays: [],
    target: 1,
    unit: null,
    startDate: TODAY,
    active: true,
    ...over,
  }) as unknown as Habit;
const done = (date: string, value = 1): HabitEntry =>
  ({ habitId: "h1", date, value, status: "done" }) as unknown as HabitEntry;

describe("habit history", () => {
  it("relative days resolve in the user's day: ayer, anteayer, the most recent weekday", () => {
    expect(checkInDate(TODAY, { daysAgo: 1 })).toBe("2026-10-02");
    expect(checkInDate(TODAY, { daysAgo: 2 })).toBe("2026-10-01");
    expect(checkInDate(TODAY, { weekday: 3 })).toBe("2026-09-30"); // "el miércoles"
    expect(checkInDate(TODAY, { weekday: 6 })).toBe(TODAY); // "el sábado" (today)
    expect(checkInDate(TODAY, { date: "2026-09-29" })).toBe("2026-09-29");
  });

  it("days before the habit was created can be backfilled and they count", () => {
    const p = habitProgress(habit(), [done("2026-10-01"), done("2026-10-02")], TODAY);
    const thu = p.week.days.find((d) => d.date === "2026-10-01")!;
    expect(thu).toMatchObject({ scheduled: true, met: true });
    expect(p.week.done).toBe(2);
    // An empty day before the start is not a miss.
    expect(p.week.days.find((d) => d.date === "2026-09-29")!.scheduled).toBe(false);
  });

  it("the streak is recomputed from the entries: a backfilled gap joins it, removing it breaks it", () => {
    const gap = [done("2026-09-29", 1), done("2026-10-01"), done("2026-10-02"), done(TODAY)];
    const start = habit({ startDate: "2026-09-28" });
    expect(habitProgress(start, gap, TODAY).streak.count).toBe(3);
    const filled = [...gap, done("2026-09-30")];
    expect(habitProgress(start, filled, TODAY).streak.count).toBe(5);
    expect(habitProgress(start, gap, TODAY).streak.count).toBe(3);
  });

  it("a measured habit's past day is corrected, not duplicated (one entry per day)", () => {
    const water = habit({ unit: "litros", target: 2 });
    const before = habitProgress(water, [done("2026-10-02", 2)], TODAY);
    const after = habitProgress(water, [done("2026-10-02", 1.5)], TODAY);
    expect(before.week.days.find((d) => d.date === "2026-10-02")).toMatchObject({
      value: 2,
      met: true,
    });
    expect(after.week.days.find((d) => d.date === "2026-10-02")).toMatchObject({
      value: 1.5,
      met: false,
    });
  });

  it("specific-weekday habits: an off-day check-in is recorded history, not a missed day", () => {
    const mwf = habit({
      frequency: "specific_days",
      preferredDays: [1, 3, 5],
      startDate: "2026-09-01",
    });
    const p = habitProgress(mwf, [done("2026-09-30"), done("2026-10-01")], TODAY);
    const thu = p.week.days.find((d) => d.date === "2026-10-01")!;
    expect(thu.scheduled).toBe(false);
    expect(thu.met).toBe(true);
    expect(p.week.goal).toBe(3);
  });
});
