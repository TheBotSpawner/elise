import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { AppError } from "@/core/errors";
import { makeExternalRef } from "@/core/providers/refs";
import { resolveBindings } from "@/core/providers/resolver";

import {
  binding,
  InMemoryTaskProvider,
  makeCtx,
  makePorts,
  NATIVE_BINDING,
} from "../../fixtures/core-fakes";

const PERSONAL = "11111111-1111-4111-8111-111111111111";
const NORTHWIND = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE = "33333333-3333-4333-8333-333333333333";

function setup(overrides: { northwindStatus?: "connected" | "needs_reauthorization" } = {}) {
  const personal = new InMemoryTaskProvider(PERSONAL, "Personal", "google");
  const northwind = new InMemoryTaskProvider(NORTHWIND, "Northwind", "google");
  const bindings = [
    NATIVE_BINDING,
    binding({
      connectionId: PERSONAL,
      providerKey: "google",
      label: "Personal",
      accountLabel: "leo@gmail.com",
    }),
    binding({
      connectionId: NORTHWIND,
      providerKey: "google",
      label: "Northwind",
      accountLabel: "leo@northwind.com",
      contextLabel: "Northwind",
      connectionStatus: overrides.northwindStatus ?? "connected",
    }),
  ];
  const {
    ports,
    tasks: native,
    log,
  } = makePorts(bindings, { [PERSONAL]: personal, [NORTHWIND]: northwind });
  return { ports, native, personal, northwind, log, bindings };
}

describe("Tasks across ELISE and Google", () => {
  it("writes to the configured default (ELISE) when no account is named", async () => {
    const { ports, native, personal, northwind } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "Review the proposal" },
    });
    expect(out.status).toBe("succeeded");
    expect(native.tasks.size).toBe(1);
    expect(personal.tasks.size + northwind.tasks.size).toBe(0);
  });

  it("resolves an explicitly named provider or account", async () => {
    const { ports, personal, northwind, native } = setup();
    await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "A", destination: "Northwind" },
    });
    expect(northwind.tasks.size).toBe(1);
    await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "B", destination: "Google Personal" },
    });
    expect(personal.tasks.size).toBe(1);
    await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "C", destination: "ELISE" },
    });
    expect(native.tasks.size).toBe(1);
  });

  it("asks which account when a named write destination is ambiguous", async () => {
    const { ports, personal, northwind } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "X", destination: "Google" },
    });
    expect(out).toMatchObject({
      status: "clarification_required",
      options: [
        { label: "Personal", account: "leo@gmail.com" },
        { label: "Northwind", account: "leo@northwind.com" },
      ],
    });
    expect(personal.tasks.size + northwind.tasks.size).toBe(0);
  });

  it("reports unknown destinations with the available account names", async () => {
    const { ports } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "X", destination: "Notion" },
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
    expect(out.status === "failed" && out.error.message).toContain("Personal");
  });

  it("aggregates safe reads across accounts and preserves provenance", async () => {
    const { ports, native, personal, northwind } = setup();
    await native.create({ title: "Native" });
    await personal.create({ title: "Personal task" });
    await northwind.create({ title: "Northwind task" });
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out.status).toBe("succeeded");
    const tasks =
      out.status === "succeeded" && out.display?.kind === "task_list" ? out.display.tasks : [];
    expect(tasks.map((t) => t.provenance.source).sort()).toEqual([
      "ELISE",
      "Northwind",
      "Personal",
    ]);
  });

  it("keeps partial results when one account fails, and says which", async () => {
    const { ports, personal, northwind } = setup();
    await personal.create({ title: "Still visible" });
    northwind.list = async () => {
      throw new AppError("AUTH_EXPIRED", "revoked");
    };
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out).toMatchObject({
      status: "succeeded",
      output: { unavailable: [{ account: "Northwind", error: "AUTH_EXPIRED" }] },
    });
  });

  it("routes follow-up writes to the account an existing task lives in", async () => {
    const { ports, northwind, native } = setup();
    const task = await northwind.create({ title: "Northwind task" });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.complete",
      args: { taskId: task.id },
    });
    expect(out.status).toBe("succeeded");
    expect(northwind.tasks.get(task.id)?.status).toBe("completed");
    expect(native.tasks.size).toBe(0);
  });

  it("never touches a connection outside the workspace, even with a forged id", async () => {
    const { ports } = setup();
    const forged = makeExternalRef(OTHER_WORKSPACE, "task", "default", "abc");
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.complete",
      args: { taskId: forged },
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "NOT_FOUND" } });
  });

  it("fails closed on a revoked account instead of writing elsewhere", async () => {
    const { ports, native, personal } = setup({ northwindStatus: "needs_reauthorization" });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "X", destination: "Northwind" },
    });
    expect(out).toMatchObject({
      status: "failed",
      error: { code: "AUTH_EXPIRED", recovery: "reconnect" },
    });
    expect(native.tasks.size + personal.tasks.size).toBe(0);
  });

  it("excludes revoked accounts from aggregated reads", () => {
    const { bindings } = setup({ northwindStatus: "needs_reauthorization" });
    const r = resolveBindings(bindings, { capability: "tasks", operationKind: "read" });
    expect(r.kind === "resolved" && r.bindings.map((b) => b.label)).toEqual(["ELISE", "Personal"]);
  });
});
