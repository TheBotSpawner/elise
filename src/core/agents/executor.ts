import { decidePolicy, type ApprovalReason } from "./policy";
import type { ProviderFactory, ToolContext, ToolDisplay, ToolRegistry } from "./tools";
import { getOperation } from "../capabilities/registry";
import type { RiskLevel } from "../capabilities/types";
import { AppError, toPublicError, type PublicError } from "../errors";
import { resolveBindings } from "../providers/resolver";
import type { CapabilityBinding } from "../providers/types";

export interface NewAction {
  toolName: string;
  capability: string;
  operation: string;
  providerKey: string;
  connectionId: string;
  riskLevel: RiskLevel;
  input: unknown;
  inputHash: string;
  idempotencyKey: string | null;
  status: "executing" | "waiting_for_approval";
  target?: { type: string; id: string };
}

export interface StoredAction {
  id: string;
  status: string;
  resultReference: Record<string, unknown> | null;
}

/** Persistence port for actions, approvals, traces and audit. Implemented in infrastructure. */
export interface ActionLog {
  /** Returns the existing action instead of inserting when the idempotency key was seen. */
  recordAction(
    ctx: ToolContext,
    action: NewAction,
  ): Promise<{ action: StoredAction; duplicate: boolean }>;
  finishAction(
    ctx: ToolContext,
    actionId: string,
    result: {
      status: "completed" | "failed";
      resultReference?: Record<string, unknown>;
      errorCode?: string;
    },
  ): Promise<void>;
  requestApproval(
    ctx: ToolContext,
    approval: {
      actionId: string;
      capability: string;
      operation: string;
      providerKey: string;
      connectionId: string;
      riskLevel: RiskLevel;
      payload: unknown;
      payloadHash: string;
      summary: string;
      reason: ApprovalReason;
    },
  ): Promise<{ id: string }>;
  recordToolExecution(
    ctx: ToolContext,
    execution: {
      toolName: string;
      actionId: string | null;
      providerKey: string | null;
      connectionId: string | null;
      status: ToolCallOutcome["status"];
      latencyMs: number;
      errorCode: string | null;
      startedAt: Date;
    },
  ): Promise<void>;
  audit(
    ctx: ToolContext,
    event: {
      eventType: string;
      resourceType?: string;
      resourceId?: string;
      actionId?: string;
      approvalId?: string;
      providerKey?: string;
      connectionId?: string;
      result: "success" | "failure" | "pending";
      metadata?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export interface ExecutorPorts {
  registry: ToolRegistry;
  providers: ProviderFactory;
  log: ActionLog;
  loadBindings(): Promise<CapabilityBinding[]>;
  /** Permission level granted to a connection for a capability. */
  permissionFor(binding: CapabilityBinding): Promise<"understand" | "read" | "write">;
}

export type ToolCallOutcome =
  | {
      status: "succeeded";
      output: unknown;
      display?: ToolDisplay;
      actionId: string | null;
      providerLabel: string;
    }
  | {
      status: "approval_required";
      approvalId: string;
      actionId: string;
      summary: string;
      reason: ApprovalReason;
    }
  | {
      status: "clarification_required";
      question: "which_account";
      options: { connectionId: string; providerKey: string }[];
    }
  | { status: "rejected"; reason: "not_permitted" }
  | { status: "failed"; error: PublicError };

export interface ToolCall {
  name: string;
  args: unknown;
  /** Stable per logical request: retries with the same key never duplicate a write. */
  idempotencyKey?: string | null;
  connectionId?: string | null;
}

/**
 * The single path every tool call takes, whether it comes from the model, the UI or a Schedule:
 * registry → schema validation → provider resolution → permission → policy/approval → execution
 * → trace + audit. The model never reaches a provider directly.
 */
export async function executeToolCall(
  ports: ExecutorPorts,
  ctx: ToolContext,
  call: ToolCall,
): Promise<ToolCallOutcome> {
  const startedAt = new Date();
  const tool = ports.registry.get(call.name);
  if (!tool) {
    // Hallucinated tool names are rejected and traced as an evaluation signal.
    return trace(null, null, fail(new AppError("VALIDATION_ERROR", `Unknown tool "${call.name}"`)));
  }
  const operation = getOperation(tool.capability, tool.operation);
  if (!operation)
    return fail(new AppError("INTERNAL_ERROR", `Tool ${tool.name} has no operation definition`));

  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return trace(
      null,
      null,
      fail(new AppError("VALIDATION_ERROR", `Invalid input: ${issues}`, { recovery: "review" })),
    );
  }
  const input: unknown = parsed.data;

  const resolution = resolveBindings(await ports.loadBindings(), {
    capability: tool.capability,
    operationKind: operation.kind,
    connectionId: call.connectionId,
  });
  if (resolution.kind === "unavailable") {
    const code =
      resolution.reason === "connection_unhealthy" ? "AUTH_EXPIRED" : "CAPABILITY_UNAVAILABLE";
    return trace(
      null,
      null,
      fail(new AppError(code, `${tool.capability} is not available`, { recovery: "reconnect" })),
    );
  }
  if (resolution.kind === "clarify") {
    return trace(null, null, {
      status: "clarification_required",
      question: "which_account",
      options: resolution.candidates.map((b) => ({
        connectionId: b.connectionId,
        providerKey: b.providerKey,
      })),
    });
  }
  // ponytail: reads use the first resolved binding; aggregate multi-account reads arrive with
  // the first multi-account provider (Google), where results are merged preserving provenance.
  const binding = resolution.bindings[0]!;
  const env = { ctx, binding, providers: ports.providers };

  const decision = decidePolicy({
    operation,
    origin: ctx.origin,
    permission: await ports.permissionFor(binding),
  });
  if (decision.kind === "reject")
    return trace(binding, null, { status: "rejected", reason: decision.reason });

  if (operation.kind === "read") {
    try {
      const result = await tool.run(input, env);
      return trace(binding, null, {
        status: "succeeded",
        output: result.output,
        display: result.display,
        actionId: null,
        providerLabel: binding.providerKey,
      });
    } catch (error) {
      return trace(binding, null, fail(error));
    }
  }

  const { summary, target } = await tool.describe(input, env);
  const inputHash = await sha256(
    stableStringify({ tool: tool.name, input, connectionId: binding.connectionId }),
  );
  const recorded = await ports.log.recordAction(ctx, {
    toolName: tool.name,
    capability: tool.capability,
    operation: tool.operation,
    providerKey: binding.providerKey,
    connectionId: binding.connectionId,
    riskLevel: operation.risk,
    input,
    inputHash,
    idempotencyKey: call.idempotencyKey ?? null,
    status: decision.kind === "require_approval" ? "waiting_for_approval" : "executing",
    target,
  });

  if (recorded.duplicate) {
    const previous = recorded.action;
    if (previous.status === "completed") {
      return {
        status: "succeeded",
        output: previous.resultReference?.output ?? null,
        actionId: previous.id,
        providerLabel: binding.providerKey,
      };
    }
    return fail(
      new AppError("CONFLICT", "This action is already being processed", { recovery: "review" }),
    );
  }
  const actionId = recorded.action.id;

  if (decision.kind === "require_approval") {
    const approval = await ports.log.requestApproval(ctx, {
      actionId,
      capability: tool.capability,
      operation: tool.operation,
      providerKey: binding.providerKey,
      connectionId: binding.connectionId,
      riskLevel: operation.risk,
      payload: { input, summary, target },
      payloadHash: inputHash,
      summary,
      reason: decision.reason,
    });
    await ports.log.audit(ctx, {
      eventType: "approval.requested",
      actionId,
      approvalId: approval.id,
      providerKey: binding.providerKey,
      connectionId: binding.connectionId,
      result: "pending",
      metadata: { tool: tool.name },
    });
    return trace(binding, actionId, {
      status: "approval_required",
      approvalId: approval.id,
      actionId,
      summary,
      reason: decision.reason,
    });
  }

  return runWrite(ports, ctx, actionId, tool.name, input, env, trace);

  async function trace(
    b: CapabilityBinding | null,
    aId: string | null,
    outcome: ToolCallOutcome,
  ): Promise<ToolCallOutcome> {
    await ports.log.recordToolExecution(ctx, {
      toolName: call.name,
      actionId: aId,
      providerKey: b?.providerKey ?? null,
      connectionId: b?.connectionId ?? null,
      status: outcome.status,
      latencyMs: Date.now() - startedAt.getTime(),
      errorCode: outcome.status === "failed" ? outcome.error.code : null,
      startedAt,
    });
    return outcome;
  }
}

/**
 * Executes an action whose approval was granted. Revalidates everything against current state
 * (docs/architecture/15 §33): the payload must match what the user saw, and the provider is
 * resolved again so revoked connections fail closed.
 */
export async function executeApprovedAction(
  ports: ExecutorPorts,
  ctx: ToolContext,
  approved: {
    actionId: string;
    approvalId: string;
    toolName: string;
    input: unknown;
    connectionId: string;
    payloadHash: string;
  },
): Promise<ToolCallOutcome> {
  const startedAt = new Date();
  const tool = ports.registry.get(approved.toolName);
  if (!tool) return fail(new AppError("VALIDATION_ERROR", `Unknown tool "${approved.toolName}"`));

  const hash = await sha256(
    stableStringify({
      tool: tool.name,
      input: approved.input,
      connectionId: approved.connectionId,
    }),
  );
  if (hash !== approved.payloadHash) {
    return fail(
      new AppError("CONFLICT", "The action changed after it was approved", { recovery: "review" }),
    );
  }
  const parsed = tool.input.safeParse(approved.input);
  if (!parsed.success)
    return fail(new AppError("VALIDATION_ERROR", "Stored action input is no longer valid"));

  const resolution = resolveBindings(await ports.loadBindings(), {
    capability: tool.capability,
    operationKind: "write",
    connectionId: approved.connectionId,
  });
  if (resolution.kind !== "resolved") {
    return fail(
      new AppError("PROVIDER_UNAVAILABLE", "The account for this action is no longer available", {
        recovery: "reconnect",
      }),
    );
  }
  const binding = resolution.bindings[0]!;
  const env = { ctx, binding, providers: ports.providers };

  return runWrite(
    ports,
    ctx,
    approved.actionId,
    tool.name,
    parsed.data,
    env,
    async (b, aId, outcome) => {
      await ports.log.recordToolExecution(ctx, {
        toolName: tool.name,
        actionId: aId,
        providerKey: b?.providerKey ?? null,
        connectionId: b?.connectionId ?? null,
        status: outcome.status,
        latencyMs: Date.now() - startedAt.getTime(),
        errorCode: outcome.status === "failed" ? outcome.error.code : null,
        startedAt,
      });
      return outcome;
    },
  );
}

async function runWrite(
  ports: ExecutorPorts,
  ctx: ToolContext,
  actionId: string,
  toolName: string,
  input: unknown,
  env: { ctx: ToolContext; binding: CapabilityBinding; providers: ProviderFactory },
  trace: (
    b: CapabilityBinding | null,
    actionId: string | null,
    o: ToolCallOutcome,
  ) => Promise<ToolCallOutcome>,
): Promise<ToolCallOutcome> {
  const tool = ports.registry.get(toolName)!;
  const { binding } = env;
  try {
    const result = await tool.run(input, env);
    // Confirmation is based on the provider's actual result, never on the model's intent.
    await ports.log.finishAction(ctx, actionId, {
      status: "completed",
      resultReference: { output: result.output, target: result.target ?? null },
    });
    await ports.log.audit(ctx, {
      eventType: `${toolName}`,
      resourceType: result.target?.type,
      resourceId: result.target?.id,
      actionId,
      providerKey: binding.providerKey,
      connectionId: binding.connectionId,
      result: "success",
    });
    return trace(binding, actionId, {
      status: "succeeded",
      output: result.output,
      display: result.display,
      actionId,
      providerLabel: binding.providerKey,
    });
  } catch (error) {
    const publicError = toPublicError(error);
    await ports.log.finishAction(ctx, actionId, { status: "failed", errorCode: publicError.code });
    await ports.log.audit(ctx, {
      eventType: `${toolName}`,
      actionId,
      providerKey: binding.providerKey,
      connectionId: binding.connectionId,
      result: "failure",
      metadata: { errorCode: publicError.code },
    });
    return trace(binding, actionId, { status: "failed", error: publicError });
  }
}

function fail(error: unknown): ToolCallOutcome {
  return { status: "failed", error: toPublicError(error) };
}

/** Deterministic JSON (sorted keys) so equal payloads always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
