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
const FIRBOT = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE = "33333333-3333-4333-8333-333333333333";

function setup(overrides: { firbotStatus?: "connected" | "needs_reauthorization" } = {}) {
  const personal = new InMemoryTaskProvider(PERSONAL, "Personal", "google");
  const firbot = new InMemoryTaskProvider(FIRBOT, "Firbot", "google");
  const bindings = [
    NATIVE_BINDING,
    binding({
      connectionId: PERSONAL,
      providerKey: "google",
      label: "Personal",
      accountLabel: "leo@gmail.com",
    }),
    binding({
      connectionId: FIRBOT,
      providerKey: "google",
      label: "Firbot",
      accountLabel: "leo@firbot.com",
      contextLabel: "Firbot",
      connectionStatus: overrides.firbotStatus ?? "connected",
    }),
  ];
  const {
    ports,
    tasks: native,
    log,
  } = makePorts(bindings, { [PERSONAL]: personal, [FIRBOT]: firbot });
  return { ports, native, personal, firbot, log, bindings };
}

describe("Tasks across ELISE and Google", () => {
  it("writes to the configured default (ELISE) when no account is named", async () => {
    const { ports, native, personal, firbot } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "Review the proposal" },
    });
    expect(out.status).toBe("succeeded");
    expect(native.tasks.size).toBe(1);
    expect(personal.tasks.size + firbot.tasks.size).toBe(0);
  });

  it("resolves an explicitly named provider or account", async () => {
    const { ports, personal, firbot, native } = setup();
    await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "A", destination: "Firbot" },
    });
    expect(firbot.tasks.size).toBe(1);
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
    const { ports, personal, firbot } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "X", destination: "Google" },
    });
    expect(out).toMatchObject({
      status: "clarification_required",
      options: [
        { label: "Personal", account: "leo@gmail.com" },
        { label: "Firbot", account: "leo@firbot.com" },
      ],
    });
    expect(personal.tasks.size + firbot.tasks.size).toBe(0);
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
    const { ports, native, personal, firbot } = setup();
    await native.create({ title: "Native" });
    await personal.create({ title: "Personal task" });
    await firbot.create({ title: "Firbot task" });
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out.status).toBe("succeeded");
    const tasks =
      out.status === "succeeded" && out.display?.kind === "task_list" ? out.display.tasks : [];
    expect(tasks.map((t) => t.provenance.source).sort()).toEqual(["ELISE", "Firbot", "Personal"]);
  });

  it("keeps partial results when one account fails, and says which", async () => {
    const { ports, personal, firbot } = setup();
    await personal.create({ title: "Still visible" });
    firbot.list = async () => {
      throw new AppError("AUTH_EXPIRED", "revoked");
    };
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out).toMatchObject({
      status: "succeeded",
      output: { unavailable: [{ account: "Firbot", error: "AUTH_EXPIRED" }] },
    });
  });

  it("routes follow-up writes to the account an existing task lives in", async () => {
    const { ports, firbot, native } = setup();
    const task = await firbot.create({ title: "Firbot task" });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.complete",
      args: { taskId: task.id },
    });
    expect(out.status).toBe("succeeded");
    expect(firbot.tasks.get(task.id)?.status).toBe("completed");
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
    const { ports, native, personal } = setup({ firbotStatus: "needs_reauthorization" });
    const out = await executeToolCall(ports, makeCtx(), {
      name: "tasks.create",
      args: { title: "X", destination: "Firbot" },
    });
    expect(out).toMatchObject({
      status: "failed",
      error: { code: "AUTH_EXPIRED", recovery: "reconnect" },
    });
    expect(native.tasks.size + personal.tasks.size).toBe(0);
  });

  it("excludes revoked accounts from aggregated reads", () => {
    const { bindings } = setup({ firbotStatus: "needs_reauthorization" });
    const r = resolveBindings(bindings, { capability: "tasks", operationKind: "read" });
    expect(r.kind === "resolved" && r.bindings.map((b) => b.label)).toEqual(["ELISE", "Personal"]);
  });
});
