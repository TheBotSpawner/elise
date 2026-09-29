import { describe, expect, it } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { runElise, toolNotes, type RuntimeEvent } from "@/core/agents/runtime";
import { toTaskQuery } from "@/core/capabilities/tasks";
import { TASK_TOOLS } from "@/core/tools/tasks";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

async function collect(gen: AsyncGenerator<RuntimeEvent>) {
  const events: RuntimeEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("runElise (vertical slice with a scripted model)", () => {
  it("creates a task from natural language and confirms only after the provider result", async () => {
    const { ports, tasks } = makePorts();
    const ai = new ScriptedAI([
      () => [
        {
          type: "tool_call",
          callId: "c1",
          name: "tasks.create",
          arguments: '{"title":"Comprar pasta dental","dueDate":"2026-09-30"}',
        },
        { type: "completed", model: "test", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      (req) => {
        // The model sees the verified tool result before answering.
        const result = req.input.at(-1);
        expect(result).toMatchObject({ type: "tool_result", callId: "c1" });
        expect(JSON.parse((result as { output: string }).output)).toMatchObject({ ok: true });
        return [
          { type: "text_delta", delta: "Listo, agregué " },
          { type: "text_delta", delta: "“Comprar pasta dental” para mañana." },
          { type: "completed", model: "test", usage: { inputTokens: 20, outputTokens: 8 } },
        ];
      },
    ]);

    const events = await collect(
      runElise({ ai, ports, ctx: makeCtx(), instructions: "x", input: [], tools: TASK_TOOLS }),
    );

    expect(tasks.tasks.size).toBe(1);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      text: "Listo, agregué “Comprar pasta dental” para mañana.",
      usage: { inputTokens: 30, outputTokens: 13 },
    });
    expect(events.map((e) => e.type)).toEqual([
      "status",
      "status",
      "tool_started",
      "tool_finished",
      "status",
      "text",
      "text",
      "done",
    ]);
    expect(done?.type === "done" && toolNotes(done.tools)[0]).toMatch(
      /tasks.create ✓ created "Comprar pasta dental"/,
    );
  });

  it("tells the model a destructive action is waiting for approval instead of executing it", async () => {
    const { ports, tasks } = makePorts();
    const task = await tasks.create({ title: "Borrar esto" });
    const ai = new ScriptedAI([
      () => [
        {
          type: "tool_call",
          callId: "c1",
          name: "tasks.delete",
          arguments: JSON.stringify({ taskId: task.id }),
        },
        { type: "completed", model: "test", usage: null },
      ],
      (req) => {
        const output = JSON.parse((req.input.at(-1) as { output: string }).output);
        expect(output).toEqual({
          ok: false,
          waitingForUserApproval: true,
          summary: "Delete task “Borrar esto” (ELISE)",
        });
        return [
          { type: "text_delta", delta: "Necesito tu aprobación." },
          { type: "completed", model: "test", usage: null },
        ];
      },
    ]);
    const events = await collect(
      runElise({ ai, ports, ctx: makeCtx(), instructions: "x", input: [], tools: TASK_TOOLS }),
    );
    expect(tasks.tasks.has(task.id)).toBe(true);
    expect(events.find((e) => e.type === "tool_finished")).toMatchObject({
      outcome: { status: "approval_required" },
    });
  });

  it("stops runaway loops and reports an error event", async () => {
    const { ports } = makePorts();
    const loop = () => [
      {
        type: "tool_call" as const,
        callId: crypto.randomUUID(),
        name: "tasks.list",
        arguments: "{}",
      },
      { type: "completed" as const, model: "test", usage: null },
    ];
    const ai = new ScriptedAI([loop, loop, loop]);
    const events = await collect(
      runElise({
        ai,
        ports,
        ctx: makeCtx(),
        instructions: "x",
        input: [],
        tools: TASK_TOOLS,
        limits: { maxModelTurns: 3, maxToolCalls: 10 },
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "RATE_LIMITED" } });
  });

  it("surfaces AI provider failures as a public error without leaking internals", async () => {
    const { ports } = makePorts();
    const ai = new ScriptedAI([
      () => {
        throw new Error("socket hang up at 10.0.0.1");
      },
    ]);
    const events = await collect(
      runElise({ ai, ports, ctx: makeCtx(), instructions: "x", input: [], tools: [] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
    });
  });
});

describe("buildContextPackage", () => {
  it("includes time, language, capabilities and only the recent history", () => {
    const pkg = buildContextPackage({
      user: { displayName: "Leo", locale: "es", timezone: "America/Argentina/Buenos_Aires" },
      now: new Date("2026-09-29T15:00:00Z"),
      availableCapabilities: ["tasks"],
      history: Array.from(
        { length: 30 },
        (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }) as const,
      ),
      userMessage: "hola",
    });
    expect(pkg.instructions).toContain(
      "Tuesday, 2026-09-29 12:00 (America/Argentina/Buenos_Aires)",
    );
    expect(pkg.instructions).toContain("Spanish");
    expect(pkg.instructions).toContain("Capabilities available right now: tasks.");
    expect(pkg.input).toHaveLength(21);
    expect(pkg.input.at(-1)).toEqual({ type: "message", role: "user", content: "hola" });
  });
});

describe("toTaskQuery", () => {
  it("resolves relative due filters in the user's timezone", () => {
    // 01:30 UTC on the 30th is still the 29th in Buenos Aires.
    const now = new Date("2026-09-30T01:30:00Z");
    const tz = "America/Argentina/Buenos_Aires";
    const base = { status: "open", limit: 20 } as const;
    expect(toTaskQuery({ ...base, due: "today" }, tz, now)).toMatchObject({
      dueFrom: "2026-09-29",
      dueTo: "2026-09-29",
    });
    expect(toTaskQuery({ ...base, due: "overdue" }, tz, now)).toMatchObject({
      dueTo: "2026-09-28",
    });
    expect(toTaskQuery({ ...base, due: "this_week" }, tz, now)).toMatchObject({
      dueFrom: "2026-09-29",
      dueTo: "2026-10-05",
    });
  });
});
