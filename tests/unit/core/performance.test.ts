import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildContextPackage } from "@/core/agents/context";
import { escalateAfter, routeTurn } from "@/core/agents/model-policy";
import { runElise, type RuntimeEvent } from "@/core/agents/runtime";
import { CORE_GROUPS, selectTools, toolsInNotes } from "@/core/agents/tool-selection";
import { ToolRegistry, type ToolDefinition } from "@/core/agents/tools";
import { CAPABILITY_KEYS } from "@/core/capabilities/registry";
import { percentile, TurnPerf } from "@/core/perf";
import { effortFor, parseProfile, resolveProfiles } from "@/infrastructure/ai/profiles";

import { makeCtx, makePorts, ScriptedAI } from "../../fixtures/core-fakes";

/**
 * Performance guards (ADR-025): deterministic properties only — profile selection, effort
 * mapping, tool exposure, parallel reads, no extra model calls. Never network latency.
 */

describe("AI profiles", () => {
  it("parses model[:effort[:tier]] and falls back to the benchmarked defaults when unset", () => {
    const legacy = { model: "gpt-5-mini", reasoning: null, serviceTier: null };
    expect(parseProfile(undefined, legacy)).toEqual(legacy);
    expect(parseProfile("gpt-6-luna:low", legacy)).toEqual({
      model: "gpt-6-luna",
      reasoning: "low",
      serviceTier: null,
    });
    expect(parseProfile("gpt-6-sol:medium:fast", legacy).serviceTier).toBe("fast");
    const p = resolveProfiles({});
    expect(p.fast).toEqual({ model: "gpt-6-luna", reasoning: "low", serviceTier: null });
    expect(p.deep).toEqual({ model: "gpt-6-luna", reasoning: "medium", serviceTier: null });
    // The previous setup, by configuration only.
    expect(resolveProfiles({ AI_PROFILE_STANDARD: "gpt-5-mini" }).standard).toEqual({
      model: "gpt-5-mini",
      reasoning: null,
      serviceTier: null,
    });
  });

  it("maps reasoning effort to what each model family accepts", () => {
    expect(effortFor("gpt-6-luna", "minimal")).toBe("none");
    expect(effortFor("gpt-6-luna", "none")).toBe("none");
    expect(effortFor("gpt-6.1-sol", "none")).toBe("low");
    expect(effortFor("gpt-6-astra", "minimal")).toBe("low");
    expect(effortFor("gpt-5-mini", "none")).toBe("minimal");
    expect(effortFor("gpt-4.1-mini", "low")).toBeNull();
    expect(effortFor("gpt-6-sol", null)).toBeNull();
  });
});

describe("adaptive routing", () => {
  it("everyday requests run fast; open-ended asks start deep", () => {
    for (const m of [
      "¿Qué tengo hoy?",
      "Cambiá tu color a verde.",
      "Mostrame mis tareas.",
      "¿Cuánto tardo de A a B?",
      "Buscame la conversación donde hablamos de X.",
    ])
      expect(routeTurn(m).tier, m).toBe("fast");
    for (const m of [
      "Investigá qué cambió en la API de Notion",
      "Compará estas dos propuestas",
      "Explicame la regla de la cadena",
      "Poneme al día con la UTN",
    ])
      expect(routeTurn(m).tier, m).toBe("deep");
  });

  it("the call after a deep-synthesis tool escalates; simple tools don't", () => {
    expect(escalateAfter(["meeting.prepare"])).toEqual({ tier: "deep" });
    expect(escalateAfter(["calendar.listEvents", "tasks.list"])).toBeNull();
  });
});

describe("tool exposure", () => {
  const all = makePorts([]).ports.registry.available(new Set(CAPABILITY_KEYS));

  it("a settings change sees the core, not finance, email, web or study", () => {
    const s = selectTools(all, { message: "Cambiá tu color a verde." });
    const groups = new Set(s.tools.map((t) => t.name.split(".")[0]));
    expect(groups.has("appearance")).toBe(true);
    for (const g of ["finance", "email", "web", "study", "structured"])
      expect(groups.has(g)).toBe(false);
    expect(s.tools.length + s.rest.length).toBe(all.length);
    expect(s.tools.length).toBeLessThan(all.length / 2);
  });

  it("signals, visible Surfaces and recent turns add their groups", () => {
    const names = (s: ReturnType<typeof selectTools>) =>
      new Set(s.tools.map((t) => t.name.split(".")[0]));
    expect(names(selectTools(all, { message: "¿Tengo mails nuevos?" })).has("email")).toBe(true);
    expect(names(selectTools(all, { message: "¿cuánto gasté este mes?" })).has("finance")).toBe(
      true,
    );
    expect(
      names(selectTools(all, { message: "abrí el segundo", surfaceTypes: ["email_list"] })).has(
        "email",
      ),
    ).toBe(true);
    expect(
      names(
        selectTools(all, {
          message: "¿y el otro?",
          recentTools: toolsInNotes(["finance.query ✓ 3 rows"]),
        }),
      ).has("finance"),
    ).toBe(true);
  });

  it("the core comes first in a fixed order (stable prompt-cache prefix)", () => {
    const a = selectTools(all, { message: "¿Tengo mails nuevos?" }).tools.map((t) => t.name);
    const b = selectTools(all, { message: "¿cuánto gasté?" }).tools.map((t) => t.name);
    const core = all.filter((t) => CORE_GROUPS.has(t.name.split(".")[0]!)).length;
    expect(a.slice(0, core)).toEqual(b.slice(0, core));
  });
});

describe("prompt caching order", () => {
  it("per-turn data (time, visible Surfaces) comes after every stable block", () => {
    const text = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "UTC" },
      now: new Date("2026-10-02T15:00:00Z"),
      availableCapabilities: ["calendar", "tasks", "knowledge"],
      history: [],
      userMessage: "x",
      workspace: "S1 meeting",
    }).instructions;
    const time = text.indexOf("Current date and time");
    for (const stable of [
      "Knowledge (the user's documents",
      "Live Workspace (Home",
      "Recall (past",
    ])
      expect(text.indexOf(stable), stable).toBeLessThan(time);
    expect(text.indexOf("Visible now")).toBeGreaterThan(time);
  });
});

// ── Runtime: parallel reads, sequential writes, on-demand tools ─────────────

const delayTool = (
  name: string,
  capability: "history" | "tasks",
  operation: string,
  ms: number,
  log: string[],
): ToolDefinition => ({
  name,
  capability,
  operation,
  description: name,
  input: z.object({}).strict(),
  async describe() {
    return { summary: name };
  },
  async run() {
    log.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${name}`);
    return { output: { ok: true } };
  },
});

async function collect(gen: AsyncGenerator<RuntimeEvent>) {
  const events: RuntimeEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const call = (callId: string, name: string) => ({
  type: "tool_call" as const,
  callId,
  name,
  arguments: "{}",
});
const done = { type: "completed" as const, model: "m", usage: { inputTokens: 1, outputTokens: 1 } };

describe("runtime", () => {
  it("runs independent reads together and shows each as soon as it lands", async () => {
    const log: string[] = [];
    const slow = delayTool("history.search", "history", "search", 40, log);
    const fast = delayTool("history.getRecent", "history", "getRecent", 5, log);
    const { ports } = makePorts([]);
    ports.registry = new ToolRegistry().register(slow, fast);
    const ai = new ScriptedAI([
      () => [call("a", "history.search"), call("b", "history.getRecent"), done],
      () => [{ type: "text_delta", delta: "ok" }, done],
    ]);
    const events = await collect(
      runElise({ ai, ports, ctx: makeCtx(), instructions: "x", input: [], tools: [slow, fast] }),
    );
    expect(log.slice(0, 2)).toEqual(["start:history.search", "start:history.getRecent"]);
    const finished = events.filter((e) => e.type === "tool_finished").map((e) => e.name);
    expect(finished).toEqual(["history.getRecent", "history.search"]);
    expect(ai.requests).toHaveLength(2);
  });

  it("keeps writes sequential, in the model's order", async () => {
    const log: string[] = [];
    const w1 = delayTool("tasks.create", "tasks", "create", 30, log);
    const w2 = delayTool("tasks.complete", "tasks", "complete", 1, log);
    const { ports } = makePorts();
    ports.registry = new ToolRegistry().register(w1, w2);
    const ai = new ScriptedAI([
      () => [call("a", "tasks.create"), call("b", "tasks.complete"), done],
      () => [{ type: "text_delta", delta: "ok" }, done],
    ]);
    await collect(
      runElise({ ai, ports, ctx: makeCtx(), instructions: "x", input: [], tools: [w1, w2] }),
    );
    expect(log).toEqual([
      "start:tasks.create",
      "end:tasks.create",
      "start:tasks.complete",
      "end:tasks.complete",
    ]);
  });

  it("loads a missing tool group on demand and uses it in the same answer", async () => {
    const log: string[] = [];
    const core = delayTool("history.search", "history", "search", 1, log);
    const later = delayTool("tasks.create", "tasks", "create", 1, log);
    const { ports } = makePorts();
    ports.registry = new ToolRegistry().register(core, later);
    const ai = new ScriptedAI([
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(["history.search", "tools.more"]);
        return [
          { type: "tool_call", callId: "m", name: "tools.more", arguments: '{"groups":["tasks"]}' },
          done,
        ];
      },
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(["history.search", "tasks.create"]);
        return [call("c", "tasks.create"), done];
      },
      () => [{ type: "text_delta", delta: "ok" }, done],
    ]);
    const events = await collect(
      runElise({
        ai,
        ports,
        ctx: makeCtx(),
        instructions: "x",
        input: [],
        tools: [core],
        moreTools: [later],
      }),
    );
    expect(log).toEqual(["start:tasks.create", "end:tasks.create"]);
    // tools.more is the runtime's own step: never shown as a user-facing tool.
    expect(events.some((e) => e.type === "tool_started" && e.name === "tools.more")).toBe(false);
  });

  it("escalates only the call after a deep-synthesis tool, and reports every model call", async () => {
    const log: string[] = [];
    const prep = delayTool("meeting.prepare", "history", "search", 1, log);
    const { ports } = makePorts([]);
    ports.registry = new ToolRegistry().register(prep);
    const ai = new ScriptedAI([
      () => [call("a", "meeting.prepare"), done],
      () => [{ type: "text_delta", delta: "brief" }, done],
    ]);
    const events = await collect(
      runElise({
        ai,
        ports,
        ctx: makeCtx(),
        instructions: "x",
        input: [],
        tools: [prep],
        tier: "fast",
        escalate: escalateAfter,
      }),
    );
    expect(ai.requests.map((r) => r.tier)).toEqual(["fast", "deep"]);
    const calls = events.filter((e) => e.type === "model_call");
    expect(calls).toHaveLength(2);
  });
});

describe("turn performance record", () => {
  it("summarizes marks, spans, model calls and tools; numbers only", async () => {
    let t = 1000;
    const perf = new TurnPerf(1000, "voice", () => t);
    t = 1200;
    perf.mark("stream_start");
    await perf.time("history", async () => {
      t += 50;
    });
    perf.model({
      model: "m",
      profile: "fast",
      reasoning: "low",
      serviceTier: null,
      start: 200,
      firstEvent: 600,
      firstText: 700,
      end: 900,
      inputTokens: 1000,
      cachedTokens: 800,
      outputTokens: 50,
      reasoningTokens: 10,
      toolsExposed: 40,
      toolCalls: 0,
    });
    perf.mark("first_text", 700);
    perf.mark("first_text", 900);
    perf.mark("complete", 950);
    const s = perf.summary();
    expect(s.spans.history).toBe(50);
    expect(s.metrics).toMatchObject({
      ttfbServer: 200,
      ttft: 700,
      total: 950,
      modelCalls: 1,
      cachedTokens: 800,
      toolsExposed: 40,
    });
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
  });
});

describe("quality guards kept by the fast profile", () => {
  it("never creates a task titled with a placeholder", async () => {
    const { createTaskInput, isPlaceholderTitle } = await import("@/core/capabilities/tasks");
    for (const t of ["Tarea", "nueva tarea", "Task", "TODO", "Recordatorio"])
      expect(isPlaceholderTitle(t), t).toBe(true);
    expect(isPlaceholderTitle("Revisar correos")).toBe(false);
    expect(createTaskInput.safeParse({ title: "Tarea" }).success).toBe(false);
    expect(createTaskInput.safeParse({ title: "Comprar pasta dental" }).success).toBe(true);
  });

  it("per-turn context travels last, after history, so the prefix stays cacheable", () => {
    const pkg = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "UTC" },
      now: new Date("2026-10-02T15:00:00Z"),
      availableCapabilities: ["calendar"],
      history: [
        { role: "user", content: "hola" },
        { role: "assistant", content: "¡Hola!" },
      ],
      userMessage: "¿Qué tengo hoy?",
      workspace: "S1 meeting",
    });
    expect(pkg.cached.instructions).not.toContain("Current date and time");
    expect(pkg.cached.instructions).not.toContain("Visible now");
    const roles = pkg.cached.input.map((i) => (i.type === "message" ? i.role : i.type));
    expect(roles).toEqual(["user", "assistant", "developer", "user"]);
    const ctx = pkg.cached.input[2] as { content: string };
    expect(ctx.content).toContain("Current date and time");
    expect(ctx.content).toContain("Visible now");
    // Same stable part for a different moment and screen.
    const later = buildContextPackage({
      user: { displayName: null, locale: "es", timezone: "UTC" },
      now: new Date("2026-10-02T15:07:00Z"),
      availableCapabilities: ["calendar"],
      history: [],
      userMessage: "¿Y mañana?",
    });
    expect(later.cached.instructions).toBe(pkg.cached.instructions);
  });
});
