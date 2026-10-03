import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { readRunner, WorkspaceSession, type ReadRunner } from "@/application/workspace-service";
import type { ToolCallOutcome } from "@/core/agents/executor";
import type { Habit, HabitEntry } from "@/core/capabilities/habits";
import { habitProgress } from "@/core/capabilities/habits";
import type { Task } from "@/core/capabilities/tasks";
import { changeOf, decide, queryKey, type ResourceChange } from "@/core/workspace/lifecycle";
import { applyOps, emptyWorkspace, type Surface } from "@/core/workspace/model";
import { parseSurface, type SurfacePayloads } from "@/core/workspace/registry";
import { optimisticComplete } from "@/features/workspace/use-workspace";

/**
 * Surface lifecycle (ADR-029): after a write, what's on the Canvas is what's in the backend —
 * the same Surface, recomputed, no duplicates; deleted things leave; pins stay but update.
 * Domain state is in memory; the "read" is the real habits/tasks presentation path.
 */

const AT = "2026-10-02T15:00:00.000Z";
const TODAY = "2026-10-01"; // a Thursday

function fakeAuth() {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    profile: { locale: "en" },
    db: { from: () => ({ upsert: async () => ({ error: null }) }) },
  } as unknown as AuthContext;
}

const habit = (id: string, name: string): Habit =>
  ({
    id,
    name,
    frequency: "daily",
    weekdays: null,
    target: 1,
    unit: null,
    startDate: "2026-01-01",
    status: "active",
  }) as unknown as Habit;

/** A tiny habits backend: the read recomputes progress from the entries, like the real one. */
function habitsBackend() {
  const habits = [habit("h1", "Workout"), habit("h2", "Read")];
  const entries: HabitEntry[] = [];
  const read = vi.fn(async (): Promise<ToolCallOutcome> => ({
    status: "succeeded",
    output: {},
    display: {
      kind: "habits",
      progress: habits.map((h) => habitProgress(h, entries, TODAY)),
    },
    actionId: null,
    providerLabel: "elise_native",
  }));
  const checkIn = (habitId: string) =>
    entries.push({
      habitId,
      date: TODAY,
      value: 1,
      status: "done",
    } as unknown as HabitEntry);
  const undo = () => entries.splice(0);
  return { read, checkIn, undo };
}

const habitsQuery = { tool: "habits.getProgress", args: {} };
const checkInChange = (id: string): ResourceChange =>
  changeOf(
    "habits.checkIn",
    { name: "checkIn", kind: "write" },
    { status: "succeeded", target: { type: "habit", id } },
  )!;

const workout = (s: Surface) => {
  const spec = (s.payload as SurfacePayloads["visualization"]).spec;
  if (spec.type !== "streak") throw new Error(`expected streak, got ${spec.type}`);
  return spec.rows.find((r) => r.label === "Workout")!;
};

async function shownHabits() {
  const backend = habitsBackend();
  const session = new WorkspaceSession(
    fakeAuth(),
    { kind: "conversation", id: "c" },
    emptyWorkspace(),
  );
  session.apply([{ op: "turn", at: AT }]);
  session.present("habits.getProgress", "call-1", await backend.read(), habitsQuery);
  return { backend, session, read: backend.read as unknown as ReadRunner };
}

describe("resource-bound collections", () => {
  it("completing a habit updates the visible weekly Surface in place — counts recomputed, no duplicate", async () => {
    const { backend, session, read } = await shownHabits();
    const before = session.state().surfaces;
    expect(before).toHaveLength(1);
    expect(workout(before[0]!).summary).toMatch(/^0 \/ /);

    backend.checkIn("h1");
    expect(await session.reconcile(checkInChange("h1"), read)).toBe(1);
    // The write's own one-habit display is not added on top.
    session.present("habits.checkIn", "call-2", await backend.read(), null, checkInChange("h1"));

    const after = session.state().surfaces;
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(workout(after[0]!).summary).toMatch(/^1 \/ /);

    // Undo: the same Surface follows again.
    backend.undo();
    await session.reconcile(checkInChange("h1"), read);
    expect(workout(session.state().surfaces[0]!).summary).toMatch(/^0 \/ /);
  });

  it("reading the same collection again updates it instead of adding another", async () => {
    const { backend, session } = await shownHabits();
    session.present("habits.getProgress", "call-9", await backend.read(), habitsQuery);
    expect(session.state().surfaces).toHaveLength(1);
    expect(queryKey("x.y", { b: 1, a: [2] })).toBe(queryKey("x.y", { a: [2], b: 1 }));
  });

  it("pinned and focused Surfaces keep updating (pinned ≠ frozen; Focus is kept)", async () => {
    const { backend, session, read } = await shownHabits();
    const id = session.state().surfaces[0]!.id;
    session.apply([
      { op: "pin", id, pinned: true, at: AT },
      { op: "focus", id, at: AT },
    ]);
    backend.checkIn("h1");
    await session.reconcile(checkInChange("h1"), read);
    const s = session.state();
    expect(workout(s.surfaces[0]!).summary).toMatch(/^1 \/ /);
    expect(s.focusId).toBe(id);
    expect(s.surfaces[0]!.pinned).toBe(true);
  });

  it("a refresh that fails keeps what was shown; unrelated writes touch nothing", async () => {
    const { session } = await shownHabits();
    const before = session.state().surfaces[0]!;
    await session.reconcile(
      checkInChange("h1"),
      async () =>
        ({
          status: "failed",
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "x",
            retryable: true,
            recovery: "retry",
            referenceId: "r",
          },
        }) as ToolCallOutcome,
    );
    expect(session.state().surfaces[0]).toEqual(before);
    const notes: ResourceChange = {
      capability: "notes",
      resourceType: "note",
      resourceId: "n1",
      operation: "updated",
    };
    expect(await session.reconcile(notes, vi.fn())).toBe(0);
  });
});

// ── Tasks: resolved collections, deletions, Focus ────────────────────────────

const task = (id: string, status: Task["status"] = "pending"): Task =>
  ({
    id,
    title: `Task ${id}`,
    description: null,
    notes: null,
    status,
    priority: null,
    category: null,
    dueDate: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    listName: "Today",
    provenance: { providerKey: "elise_native", connectionId: "c", externalId: id, source: "ELISE" },
  }) as unknown as Task;

function tasksSession(open: Task[]) {
  let tasks = open;
  const read: ReadRunner = async () => ({
    status: "succeeded",
    output: {},
    display: { kind: "task_list", tasks: tasks.filter((t) => t.status !== "completed") },
    actionId: null,
    providerLabel: "elise_native",
  });
  const session = new WorkspaceSession(
    fakeAuth(),
    { kind: "conversation", id: "c" },
    emptyWorkspace(),
  );
  session.apply([{ op: "turn", at: AT }]);
  return {
    session,
    read,
    set: (next: Task[]) => (tasks = next),
    show: async () =>
      session.present("tasks.list", "call-1", await read({ tool: "tasks.list", args: {} }), {
        tool: "tasks.list",
        args: { status: "open" },
      }),
  };
}
const taskChange = (op: "complete" | "delete", id: string) =>
  changeOf(
    `tasks.${op}`,
    { name: op, kind: op === "delete" ? "destructive" : "write" },
    { status: "succeeded", target: { type: "task", id } },
  )!;

describe("task collections", () => {
  it("a completed task leaves 'Today's tasks' and the count follows", async () => {
    const t = tasksSession([task("a"), task("b")]);
    await t.show();
    t.set([task("a", "completed"), task("b")]);
    await t.session.reconcile(taskChange("complete", "a"), t.read);
    const p = t.session.state().surfaces[0]!.payload as SurfacePayloads["task_list"];
    expect(p.items.map((i) => i.id)).toEqual(["b"]);
    expect(p.total).toBe(1);
  });

  it("when nothing is left the collection has done its job and leaves — unless pinned", async () => {
    const t = tasksSession([task("a")]);
    await t.show();
    t.set([task("a", "completed")]);
    await t.session.reconcile(taskChange("complete", "a"), t.read);
    expect(t.session.state().surfaces).toHaveLength(0);

    const pinned = tasksSession([task("a")]);
    await pinned.show();
    const id = pinned.session.state().surfaces[0]!.id;
    pinned.session.apply([{ op: "pin", id, pinned: true, at: AT }]);
    pinned.set([task("a", "completed")]);
    await pinned.session.reconcile(taskChange("complete", "a"), pinned.read);
    expect(pinned.session.state().surfaces).toHaveLength(1);
  });

  it("a deleted resource's own card leaves, and Focus with it", () => {
    const card = parseSurface({
      id: "task-card",
      handle: "S1",
      type: "task",
      title: "Task a",
      state: "ready",
      priority: 45,
      size: "small",
      source: null,
      ref: { resource: "task", id: "a" },
      payload: {
        task: {
          id: "a",
          title: "Task a",
          status: "pending",
          priority: null,
          dueDate: null,
          listName: null,
          source: "ELISE",
        },
        change: "created",
      },
      actions: [],
      intentId: null,
      turn: 1,
      createdAt: AT,
      updatedAt: AT,
    });
    if (!card) throw new Error("fixture");
    expect(decide(card, taskChange("delete", "a"))).toBe("dismiss");
    expect(decide(card, taskChange("complete", "a"))).toBe("keep");
    const state = applyOps({ ...emptyWorkspace(), surfaces: [card], focusId: card.id }, [
      { op: "dismiss", id: card.id, at: AT },
    ]);
    expect(state.surfaces).toHaveLength(0);
    expect(state.focusId).toBeNull();
  });

  it("approvals are never dismissed by reconciliation; reads change nothing", () => {
    expect(
      changeOf("tasks.list", { name: "list", kind: "read" }, { status: "succeeded" }),
    ).toBeNull();
    expect(
      changeOf("tasks.complete", { name: "complete", kind: "write" }, { status: "failed" }),
    ).toBeNull();
  });
});

describe("safety", () => {
  it("a stored query is replayed only if it is a read", async () => {
    const run = vi.fn(async () => ({ status: "succeeded" }) as ToolCallOutcome);
    const replay = readRunner(run, (name) => name === "tasks.list");
    await replay({ tool: "tasks.list", args: {} });
    await expect(replay({ tool: "tasks.delete", args: { taskId: "a" } })).rejects.toThrow(
      /Only reads/,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("an optimistic completion is local and complete-only (the server state replaces it)", () => {
    const t = { ...emptyWorkspace() };
    expect(optimisticComplete(t, "missing", "a")).toEqual(t);
  });
});
