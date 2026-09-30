import { describe, expect, it } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession } from "@/application/workspace-service";
import type { Task } from "@/core/capabilities/tasks";
import { emptyWorkspace, type WorkspaceOp } from "@/core/workspace/model";

const AT = "2026-09-29T15:00:00.000Z";

function task(id: string, status: Task["status"] = "pending"): Task {
  return {
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
    provenance: {
      providerKey: "elise_native",
      connectionId: "conn-native",
      externalId: id,
      source: "ELISE",
    },
  };
}

function fakeAuth() {
  const saved: unknown[] = [];
  const auth = {
    userId: "user-1",
    workspaceId: "ws-1",
    db: {
      from: () => ({
        upsert: async (row: unknown) => {
          saved.push(row);
          return { error: null };
        },
      }),
    },
  } as unknown as AuthContext;
  return { auth, saved };
}

describe("workspace session (one chat turn)", () => {
  it("buffers ops until the stream opens, then streams every change and saves it", async () => {
    const { auth, saved } = fakeAuth();
    const session = new WorkspaceSession(auth, "conv-1", emptyWorkspace());
    session.apply([{ op: "turn", at: AT }]);
    const streamed: { ops: WorkspaceOp[]; version: number }[] = [];
    session.attach(
      (ops, version) => streamed.push({ ops, version }),
      () => {},
    );
    expect(streamed).toEqual([{ ops: [{ op: "turn", at: AT }], version: 1 }]);

    const ids = session.present("tasks.list", "call-1", {
      status: "succeeded",
      display: { kind: "task_list", tasks: [task("t1"), task("t2")] },
      output: null,
      actionId: null,
      providerLabel: "elise_native",
    });
    expect(ids).toHaveLength(1);
    expect(streamed.at(-1)?.version).toBe(2);
    await session.flush();
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)).toMatchObject({ conversation_id: "conv-1", version: 2 });
  });

  it("completing a visible task updates it in place instead of adding a duplicate", () => {
    const { auth } = fakeAuth();
    const session = new WorkspaceSession(auth, "conv-1", emptyWorkspace());
    session.present("tasks.list", "call-1", {
      status: "succeeded",
      display: { kind: "task_list", tasks: [task("t1"), task("t2")] },
      output: null,
      actionId: null,
      providerLabel: "elise_native",
    });
    session.present("tasks.complete", "call-2", {
      status: "succeeded",
      display: { kind: "task", task: task("t1", "completed"), change: "completed" },
      output: null,
      actionId: "a1",
      providerLabel: "elise_native",
    });
    const state = session.state();
    expect(state.surfaces).toHaveLength(1);
    const items = (state.surfaces[0]!.payload as { items: { id: string; status: string }[] }).items;
    expect(items.find((i) => i.id === "t1")?.status).toBe("completed");
  });

  it("attributes orchestration steps to the tool call running now", () => {
    const { auth } = fakeAuth();
    const session = new WorkspaceSession(auth, "conv-1", emptyWorkspace());
    const steps: [string, string | null][] = [];
    session.attach(
      () => {},
      (step, parent) => steps.push([step.tool, parent]),
    );
    session.current = "call-meeting";
    session.activity({ id: "email:1", tool: "email.search", status: "running" });
    session.current = null;
    session.activity({ id: "x", tool: "tasks.list", status: "done" });
    expect(steps).toEqual([
      ["email.search", "call-meeting"],
      ["tasks.list", null],
    ]);
  });
});
