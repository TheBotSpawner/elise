import { describe, expect, it } from "vitest";

import { executeApprovedAction, executeToolCall, stableStringify } from "@/core/agents/executor";

import { makeCtx, makePorts, NATIVE_BINDING } from "../../fixtures/core-fakes";

describe("executeToolCall", () => {
  it("validates input strictly and never reaches the provider with bad data", async () => {
    const { ports, tasks } = makePorts();
    const outcome = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "", extra: 1 },
    });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(tasks.tasks.size).toBe(0);
  });

  it("rejects hallucinated tools", async () => {
    const { ports, log } = makePorts();
    const outcome = await executeToolCall(ports, makeCtx(), { name: "gmail.nuke", args: {} });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(log.executions).toEqual([{ toolName: "gmail.nuke", status: "failed" }]);
  });

  it("creates through the resolved provider, records the action and audits it", async () => {
    const { ports, tasks, log } = makePorts();
    const outcome = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "Revisar presupuesto", dueDate: "2026-09-30" },
      idempotencyKey: "run-1:call-1",
    });
    expect(outcome).toMatchObject({
      status: "succeeded",
      display: { kind: "task", change: "created" },
    });
    expect([...tasks.tasks.values()].map((t) => t.title)).toEqual(["Revisar presupuesto"]);
    expect(log.auditEvents).toEqual([{ eventType: "tasks.create", result: "success" }]);
  });

  it("is idempotent: replaying the same call does not duplicate the write", async () => {
    const { ports, tasks } = makePorts();
    const call = { name: "tasks.create", args: { title: "Once" }, idempotencyKey: "run-1:call-1" };
    await executeToolCall(ports, makeCtx(), call);
    const again = await executeToolCall(ports, makeCtx(), call);
    expect(again.status).toBe("succeeded");
    expect(tasks.tasks.size).toBe(1);
  });

  it("fails closed when the capability has no healthy connection", async () => {
    const { ports } = makePorts([{ ...NATIVE_BINDING, connectionStatus: "needs_reauthorization" }]);
    const outcome = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(outcome).toMatchObject({
      status: "failed",
      error: { code: "AUTH_EXPIRED", recovery: "reconnect" },
    });
  });

  it("turns an AI delete into a pending approval, then executes exactly the approved payload", async () => {
    const { ports, tasks, log } = makePorts();
    const task = await tasks.create({ title: "Old task" });

    const outcome = await executeToolCall(ports, makeCtx(), {
      name: "tasks.delete",
      args: { taskId: task.id },
    });
    expect(outcome).toMatchObject({
      status: "approval_required",
      summary: "Delete task “Old task” (ELISE)",
    });
    expect(tasks.tasks.has(task.id)).toBe(true);

    const approval = log.approvals[0]!;
    const action = log.actions.get(approval.actionId)!;
    const approved = {
      actionId: approval.actionId,
      approvalId: approval.id,
      toolName: "tasks.delete",
      input: action.input,
      connectionId: NATIVE_BINDING.connectionId,
      payloadHash: approval.payloadHash,
    };

    const tampered = await executeApprovedAction(ports, makeCtx({ origin: "user_ui" }), {
      ...approved,
      input: { taskId: crypto.randomUUID() },
    });
    expect(tampered).toMatchObject({ status: "failed", error: { code: "CONFLICT" } });
    expect(tasks.tasks.has(task.id)).toBe(true);

    const done = await executeApprovedAction(ports, makeCtx({ origin: "user_ui" }), approved);
    expect(done).toMatchObject({ status: "succeeded", display: { change: "deleted" } });
    expect(tasks.tasks.has(task.id)).toBe(false);
  });

  it("lets the user delete directly from the UI without an approval round-trip", async () => {
    const { ports, tasks, log } = makePorts();
    const task = await tasks.create({ title: "Mine" });
    const outcome = await executeToolCall(ports, makeCtx({ origin: "user_ui", aiRunId: null }), {
      name: "tasks.delete",
      args: { taskId: task.id },
    });
    expect(outcome.status).toBe("succeeded");
    expect(log.approvals).toHaveLength(0);
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
  });
});
