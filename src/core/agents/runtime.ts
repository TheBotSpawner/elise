import { AppError, toPublicError, type PublicError } from "../errors";
import type { AIInputItem, AIProvider, AITurnRequest, AIUsage, ModelTier } from "./ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "./executor";
import { ToolRegistry, type AnyToolDefinition, type ToolContext, type ToolDisplay } from "./tools";
import { getCapability } from "../capabilities/registry";

export interface RuntimeLimits {
  maxModelTurns: number;
  maxToolCalls: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = { maxModelTurns: 6, maxToolCalls: 12 };

export interface ToolTrace {
  callId: string;
  name: string;
  outcome: ToolCallOutcome;
}

export type RuntimeEvent =
  | { type: "status"; state: "thinking" | "using_tools" }
  | { type: "text"; delta: string }
  | { type: "tool_started"; callId: string; name: string }
  | {
      type: "tool_finished";
      callId: string;
      name: string;
      outcome: ToolCallOutcome;
      /** The call's arguments (a read is re-run with them to refresh its Surface, ADR-029). */
      args?: unknown;
    }
  | { type: "done"; text: string; tools: ToolTrace[]; usage: AIUsage; model: string | null }
  /** Timing and tokens of one model call (performance telemetry; no content). */
  | { type: "model_call"; stats: ModelCallTiming }
  | { type: "error"; error: PublicError; text: string; tools: ToolTrace[] };

/** Absolute times (Date.now()) of one model call, plus what it consumed. */
export interface ModelCallTiming {
  model: string | null;
  tier: ModelTier;
  reasoning: string | null;
  serviceTier: string | null;
  start: number;
  firstEvent: number | null;
  firstText: number | null;
  end: number;
  usage: AIUsage | null;
  toolsExposed: number;
  toolCalls: number;
}

export interface RunInput {
  ai: AIProvider;
  ports: ExecutorPorts;
  ctx: ToolContext;
  instructions: string;
  input: AIInputItem[];
  tools: AnyToolDefinition[];
  tier?: ModelTier;
  limits?: RuntimeLimits;
  signal?: AbortSignal;
  /**
   * Calls decided deterministically before the model (a Shortcut's steps, ADR-017 §12). They
   * run through the same executor — validation, resolution, policy, approvals, audit — as if
   * the model had asked; the model then only writes the answer from their results.
   */
  preset?: { name: string; args: unknown }[];
  /** A latency hint for reasoning models (spoken turns favour speed, ADR-017 §18). */
  reasoning?: AITurnRequest["reasoning"];
  /**
   * Per model call: a different profile once certain tools have run (e.g. the synthesis after
   * meeting.prepare runs deep while the routing call stayed fast). Null keeps the turn's own.
   */
  /**
   * Tools this turn doesn't see up front (ADR-025): loadable by group with `tools.more`, so a
   * capability the selection missed costs one round trip, never an "I can't".
   */
  moreTools?: AnyToolDefinition[];
  escalate?: (
    toolNames: string[],
  ) => { tier: ModelTier; reasoning?: AITurnRequest["reasoning"] } | null;
}

/**
 * ELISE Core runtime: one intelligence, one loop (docs/architecture/12 §3, §30).
 * Model → tool calls → deterministic execution → results → model, until a final answer.
 */
export async function* runElise(run: RunInput): AsyncGenerator<RuntimeEvent> {
  const limits = run.limits ?? DEFAULT_LIMITS;
  let more = [...(run.moreTools ?? [])];
  let specs = run.tools.map(ToolRegistry.toSpec);
  if (more.length) specs.push(moreToolsSpec(more));
  const items: AIInputItem[] = [...run.input];
  const traces: ToolTrace[] = [];
  const usage: AIUsage = { inputTokens: 0, outputTokens: 0 };
  let text = "";
  let model: string | null = null;

  try {
    if (run.preset?.length) {
      yield { type: "status", state: "using_tools" };
      for (const [i, call] of run.preset.entries()) {
        const callId = `preset_${i}`;
        const args = JSON.stringify(call.args ?? {});
        items.push({ type: "tool_call", callId, name: call.name, arguments: args });
        yield { type: "tool_started", callId, name: call.name };
        const outcome = await executeToolCall(run.ports, run.ctx, {
          name: call.name,
          args: call.args,
          idempotencyKey: run.ctx.aiRunId ? `${run.ctx.aiRunId}:${callId}` : null,
        });
        traces.push({ callId, name: call.name, outcome });
        items.push({ type: "tool_result", callId, output: JSON.stringify(forModel(outcome)) });
        yield { type: "tool_finished", callId, name: call.name, outcome, args: call.args };
      }
    }
    for (let turn = 0; turn < limits.maxModelTurns; turn++) {
      yield { type: "status", state: "thinking" };
      const calls: { callId: string; name: string; arguments: string }[] = [];
      let spoke = false;
      const escalated = run.escalate?.(traces.map((t) => t.name)) ?? null;
      const tier = escalated?.tier ?? run.tier ?? "standard";
      const reasoning = escalated ? escalated.reasoning : run.reasoning;
      const timing: ModelCallTiming = {
        model: null,
        tier,
        reasoning: reasoning ?? null,
        serviceTier: null,
        start: Date.now(),
        firstEvent: null,
        firstText: null,
        end: 0,
        usage: null,
        toolsExposed: specs.length,
        toolCalls: 0,
      };

      for await (const event of run.ai.streamTurn({
        instructions: run.instructions,
        input: items,
        tools: specs,
        tier,
        ...(reasoning ? { reasoning } : {}),
        signal: run.signal,
      })) {
        timing.firstEvent ??= Date.now();
        if (event.type === "text_delta") {
          timing.firstText ??= Date.now();
          text += event.delta;
          spoke = true;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool_call") {
          calls.push(event);
        } else {
          model = event.model;
          timing.model = event.model;
          timing.usage = event.usage;
          timing.serviceTier = event.serviceTier ?? null;
          timing.reasoning = event.effort ?? timing.reasoning;
          usage.inputTokens += event.usage?.inputTokens ?? 0;
          usage.outputTokens += event.usage?.outputTokens ?? 0;
          usage.cachedTokens = (usage.cachedTokens ?? 0) + (event.usage?.cachedTokens ?? 0);
        }
      }
      timing.end = Date.now();
      timing.toolCalls = calls.length;
      yield { type: "model_call", stats: timing };

      if (calls.length === 0) {
        yield { type: "done", text, tools: traces, usage, model };
        return;
      }

      yield { type: "status", state: "using_tools" };
      // Loading more tools is the runtime's own business: no executor, no trace.
      for (const call of calls.filter((c) => c.name === MORE_TOOLS)) {
        const wanted = new Set(
          ((parseArguments(call.arguments) as { groups?: unknown }).groups as string[]) ?? [],
        );
        const added = more.filter((t) => wanted.has(t.name.split(".")[0] ?? ""));
        more = more.filter((t) => !added.includes(t));
        specs = [...specs.filter((s) => s.name !== MORE_TOOLS), ...added.map(ToolRegistry.toSpec)];
        if (more.length) specs.push(moreToolsSpec(more));
        items.push({ type: "tool_call", ...call });
        items.push({
          type: "tool_result",
          callId: call.callId,
          output: JSON.stringify({ loaded: added.map((t) => t.name) }),
        });
      }
      const real = calls.filter((c) => c.name !== MORE_TOOLS);
      const execute = (call: (typeof calls)[number], index: number) =>
        traces.length + index >= limits.maxToolCalls
          ? Promise.resolve<ToolCallOutcome>({
              status: "failed",
              error: toPublicError(
                new AppError("RATE_LIMITED", "Tool call limit reached for this request"),
              ),
            })
          : executeToolCall(run.ports, run.ctx, {
              name: call.name,
              args: parseArguments(call.arguments),
              // Same run + same call id never duplicates a write.
              idempotencyKey: run.ctx.aiRunId ? `${run.ctx.aiRunId}:${call.callId}` : null,
            });
      for (const call of real) items.push({ type: "tool_call", ...call });

      // Independent reads requested together run together, and each result is shown as soon as
      // it lands. Anything that changes data keeps the model's order, one at a time.
      const outcomes = new Map<string, ToolCallOutcome>();
      if (real.length > 1 && real.every((c) => isRead(run.tools, c.name))) {
        for (const call of real)
          yield { type: "tool_started", callId: call.callId, name: call.name };
        const pending = new Map(
          real.map((call, i) => [
            call.callId,
            execute(call, i).then((outcome) => ({ call, outcome })),
          ]),
        );
        while (pending.size) {
          const { call, outcome } = await Promise.race(pending.values());
          pending.delete(call.callId);
          outcomes.set(call.callId, outcome);
          yield {
            type: "tool_finished",
            callId: call.callId,
            name: call.name,
            outcome,
            args: parseArgs(call.arguments),
          };
        }
      } else {
        for (const [i, call] of real.entries()) {
          yield { type: "tool_started", callId: call.callId, name: call.name };
          const outcome = await execute(call, i);
          outcomes.set(call.callId, outcome);
          yield {
            type: "tool_finished",
            callId: call.callId,
            name: call.name,
            outcome,
            args: parseArgs(call.arguments),
          };
        }
      }
      for (const call of real) {
        const outcome = outcomes.get(call.callId)!;
        traces.push({ callId: call.callId, name: call.name, outcome });
        items.push({
          type: "tool_result",
          callId: call.callId,
          output: JSON.stringify(forModel(outcome)),
        });
      }

      // No model call just to say "done" (ADR-025):
      // - the answer is already written and the only calls arranged the screen (ui.*);
      // - every call succeeded with a result that confirms itself (e.g. a new accent color).
      const loaded = calls.some((c) => c.name === MORE_TOOLS);
      // Only when they worked: a rejected chart goes back to the model to fix, never vanishes.
      if (
        !loaded &&
        real.length &&
        spoke &&
        real.every(
          (c) => c.name.startsWith("ui.") && outcomes.get(c.callId)?.status === "succeeded",
        )
      ) {
        yield { type: "done", text, tools: traces, usage, model };
        return;
      }
      const confirmations = loaded
        ? []
        : real.map((c) => {
            const outcome = outcomes.get(c.callId)!;
            const tool = run.tools.find((t) => t.name === c.name);
            return outcome.status === "succeeded" && tool?.confirm
              ? tool.confirm(outcome.output, run.ctx.locale)
              : null;
          });
      if (confirmations.length && confirmations.every(Boolean)) {
        // After a spoken "what I'm checking" line, the confirmation is still the answer.
        const answer = (spoke ? " " : "") + confirmations.join(" ");
        text += answer;
        yield { type: "text", delta: answer };
        yield { type: "done", text, tools: traces, usage, model };
        return;
      }
    }
    throw new AppError(
      "RATE_LIMITED",
      "Elise needed too many steps for this request. Try splitting it.",
    );
  } catch (error) {
    yield { type: "error", error: toPublicError(error), text, tools: traces };
  }
}

const MORE_TOOLS = "tools.more";

const parseArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

/** The fallback tool listing the groups not loaded yet. */
function moreToolsSpec(rest: readonly AnyToolDefinition[]) {
  const groups = [...new Set(rest.map((t) => t.name.split(".")[0] ?? t.name))];
  return {
    name: MORE_TOOLS,
    description: `Load more of ELISE's tools when this request needs a capability you don't have tools for yet. Groups: ${groups.join(", ")}. Load them, then use them in the same answer.`,
    parameters: {
      type: "object",
      properties: { groups: { type: "array", items: { type: "string", enum: groups } } },
      required: ["groups"],
      additionalProperties: false,
    },
  };
}

/** Reads (search, list, get) never change data: safe to run side by side. */
function isRead(tools: readonly AnyToolDefinition[], name: string): boolean {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return false;
  return getCapability(tool.capability).operations[tool.operation]?.kind === "read";
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { __invalid_json__: raw.slice(0, 200) };
  }
}

/** What the model learns from a tool outcome: results, never internal IDs of approvals' payloads. */
function forModel(outcome: ToolCallOutcome): unknown {
  switch (outcome.status) {
    case "succeeded":
      return { ok: true, result: outcome.output };
    case "approval_required":
      return { ok: false, waitingForUserApproval: true, summary: outcome.summary };
    case "clarification_required":
      return {
        ok: false,
        needsClarification:
          "Several accounts could receive this. Ask the user which one, then call the tool again with destination set to their choice.",
        options: outcome.options.map((o) => (o.account ? `${o.label} (${o.account})` : o.label)),
      };
    case "rejected":
      return { ok: false, error: "This action is not permitted with the current permissions." };
    case "failed":
      return { ok: false, error: outcome.error.code, message: outcome.error.message };
  }
}

/** One-line notes stored with the assistant message so later turns keep continuity. */
export function toolNotes(traces: readonly ToolTrace[]): string[] {
  return traces.map(({ name, outcome }) => {
    if (outcome.status === "succeeded" && outcome.display?.kind === "task") {
      return `${name} ✓ ${outcome.display.change} "${outcome.display.task.title}" (id ${outcome.display.task.id})`;
    }
    if (outcome.status === "succeeded" && outcome.display?.kind === "task_list") {
      return `${name} ✓ ${outcome.display.tasks.length} tasks`;
    }
    if (outcome.status === "succeeded" && outcome.display?.kind === "event") {
      const e = outcome.display.event;
      return `${name} ✓ ${outcome.display.change} "${e.title}" ${e.start} (id ${e.id})`;
    }
    if (outcome.status === "succeeded" && outcome.display?.kind === "event_list") {
      return `${name} ✓ ${outcome.display.events.length} events`;
    }
    if (outcome.status === "succeeded" && outcome.display) {
      const note = emailNote(outcome.display);
      if (note) return `${name} ✓ ${note}`;
    }
    return `${name} ${outcome.status}`;
  });
}

/** Email notes keep the ids later turns need ("summarize that thread", "send it"). */
function emailNote(display: ToolDisplay): string | null {
  switch (display.kind) {
    case "email_list":
      return `${display.messages.length} emails: ${display.messages
        .slice(0, 5)
        .map(
          (m) =>
            `"${m.subject}" from ${m.from?.email ?? "?"} (message ${m.id}, thread ${m.threadId})`,
        )
        .join("; ")}`;
    case "email_thread":
      return `thread "${display.thread.subject}" (thread ${display.thread.id}, latest message ${display.thread.messages.at(-1)?.id ?? "?"})`;
    case "email_draft":
      return `draft ${display.change} "${display.draft.subject}" to ${display.draft.to.map((a) => a.email).join(", ")} (draft ${display.draft.id})`;
    case "native_list":
      return `list "${display.list.name}" (list ${display.list.id})`;
    case "note":
      return `note ${display.change} "${display.note.title}" (note ${display.note.id})`;
    case "knowledge_evidence":
      return `${display.evidence.length} Knowledge passages${display.enough ? "" : " (not enough evidence)"}: ${[
        ...new Map(
          display.evidence.map((e) => [e.itemId, `"${e.title}" (item ${e.itemId})`]),
        ).values(),
      ]
        .slice(0, 5)
        .join("; ")}`;
    case "email_followups":
      return `${display.items.length} ${display.followUp}: ${display.items
        .slice(0, 5)
        .map((f) => `"${f.subject}" (thread ${f.threadId})`)
        .join("; ")}`;
    default:
      return null;
  }
}
