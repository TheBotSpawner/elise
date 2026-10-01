import { AppError, toPublicError, type PublicError } from "../errors";
import type { AIInputItem, AIProvider, AITurnRequest, AIUsage, ModelTier } from "./ai-provider";
import { executeToolCall, type ExecutorPorts, type ToolCallOutcome } from "./executor";
import { ToolRegistry, type AnyToolDefinition, type ToolContext, type ToolDisplay } from "./tools";

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
  /**
   * Calls decided deterministically before the model (a Shortcut's steps, ADR-017 §12). They
   * run through the same executor — validation, resolution, policy, approvals, audit — as if
   * the model had asked; the model then only writes the answer from their results.
   */
  preset?: { name: string; args: unknown }[];
  /** A latency hint for reasoning models (spoken turns favour speed, ADR-017 §18). */
  reasoning?: AITurnRequest["reasoning"];
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
        yield { type: "tool_finished", callId, name: call.name, outcome };
      }
    }
    for (let turn = 0; turn < limits.maxModelTurns; turn++) {
      yield { type: "status", state: "thinking" };
      const calls: { callId: string; name: string; arguments: string }[] = [];

      for await (const event of run.ai.streamTurn({
        instructions: run.instructions,
        input: items,
        tools: specs,
        tier: run.tier ?? "standard",
        ...(run.reasoning ? { reasoning: run.reasoning } : {}),
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
