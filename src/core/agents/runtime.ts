import { AppError, toPublicError, type PublicError } from "../errors";
import type { AIInputItem, AIProvider, AIUsage, ModelTier } from "./ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "./executor";
import { ToolRegistry, type AnyToolDefinition, type ToolContext } from "./tools";

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
  | { type: "tool_finished"; callId: string; name: string; outcome: ToolCallOutcome }
  | { type: "done"; text: string; tools: ToolTrace[]; usage: AIUsage; model: string | null }
  | { type: "error"; error: PublicError; text: string; tools: ToolTrace[] };

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
}

/**
 * ELISE Core runtime: one intelligence, one loop (docs/architecture/12 §3, §30).
 * Model → tool calls → deterministic execution → results → model, until a final answer.
 */
export async function* runElise(run: RunInput): AsyncGenerator<RuntimeEvent> {
  const limits = run.limits ?? DEFAULT_LIMITS;
  const specs = run.tools.map(ToolRegistry.toSpec);
  const items: AIInputItem[] = [...run.input];
  const traces: ToolTrace[] = [];
  const usage: AIUsage = { inputTokens: 0, outputTokens: 0 };
  let text = "";
  let model: string | null = null;

  try {
    for (let turn = 0; turn < limits.maxModelTurns; turn++) {
      yield { type: "status", state: "thinking" };
      const calls: { callId: string; name: string; arguments: string }[] = [];

      for await (const event of run.ai.streamTurn({
        instructions: run.instructions,
        input: items,
        tools: specs,
        tier: run.tier ?? "standard",
        signal: run.signal,
      })) {
        if (event.type === "text_delta") {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool_call") {
          calls.push(event);
        } else {
          model = event.model;
          usage.inputTokens += event.usage?.inputTokens ?? 0;
          usage.outputTokens += event.usage?.outputTokens ?? 0;
        }
      }

      if (calls.length === 0) {
        yield { type: "done", text, tools: traces, usage, model };
        return;
      }

      yield { type: "status", state: "using_tools" };
      for (const call of calls) {
        items.push({
          type: "tool_call",
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
        yield { type: "tool_started", callId: call.callId, name: call.name };

        const outcome =
          traces.length >= limits.maxToolCalls
            ? ({
                status: "failed",
                error: toPublicError(
                  new AppError("RATE_LIMITED", "Tool call limit reached for this request"),
                ),
              } as const)
            : await executeToolCall(run.ports, run.ctx, {
                name: call.name,
                args: parseArguments(call.arguments),
                // Same run + same call id never duplicates a write.
                idempotencyKey: run.ctx.aiRunId ? `${run.ctx.aiRunId}:${call.callId}` : null,
              });

        traces.push({ callId: call.callId, name: call.name, outcome });
        items.push({
          type: "tool_result",
          callId: call.callId,
          output: JSON.stringify(forModel(outcome)),
        });
        yield { type: "tool_finished", callId: call.callId, name: call.name, outcome };
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
        needsClarification: "Ask the user which account to use",
        options: outcome.options.length,
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
    return `${name} ${outcome.status}`;
  });
}
