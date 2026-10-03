import { decidePolicy, type ApprovalReason } from "./policy";
import type {
  AnyToolDefinition,
  ProviderFactory,
  ToolContext,
  ToolDisplay,
  ToolRegistry,
  ToolRunEnv,
  ToolRunResult,
} from "./tools";
import { getCapability, getOperation } from "../capabilities/registry";
import type {
  ApprovalMode,
  OperationDefinition,
  OperationKind,
  RiskLevel,
} from "../capabilities/types";
import { AppError, toPublicError, type PublicError } from "../errors";
import { readDestination } from "../providers/destination";
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
  /**
   * The same request (tool, pinned input, account) already waiting for the user's approval.
   * Asking again — "yes, do it", said instead of pressing Approve — must not create a
   * second approval for the same action.
   */
  findPendingApproval?(
    ctx: ToolContext,
    payloadHash: string,
  ): Promise<{ approvalId: string; actionId: string } | null>;
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
      /** The resource a write acted on (the Canvas reconciles what shows it, ADR-029). */
      target?: { type: string; id: string };
    }
  | {
      status: "approval_required";
      approvalId: string;
      actionId: string;
      summary: string;
      reason: ApprovalReason;
      preview?: ToolDisplay;
    }
  | {
      status: "clarification_required";
      question: "which_account";
      options: {
        connectionId: string;
        providerKey: string;
        label: string;
        account: string | null;
      }[];
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
  const baseOperation = getOperation(tool.capability, tool.operation);
  if (!baseOperation)
    return fail(new AppError("INTERNAL_ERROR", `Tool ${tool.name} has no operation definition`));
  let operation = baseOperation;

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

  // ELISE-internal capabilities (Recall, proposing a Schedule, ELISE's own settings) have no
  // provider to resolve. Reads run directly; writes (ELISE changing its own settings) take the
  // normal path below — policy, recorded action, audit — without a provider connection.
  const internal = Boolean(getCapability(tool.capability).internal);
  if (internal && operation.kind === "read") {
    try {
      const result = await tool.run(input, {
        ctx,
        binding: INTERNAL_BINDING,
        providers: ports.providers,
        invoke: nestedReads(ports, ctx),
      });
      return trace(null, null, {
        status: "succeeded",
        output: result.output,
        display: result.display,
        actionId: null,
        providerLabel: "elise",
      });
    } catch (error) {
      return trace(null, null, fail(error));
    }
  }

  const allBindings = internal ? [] : await ports.loadBindings();
  let route: ReturnType<NonNullable<AnyToolDefinition["route"]>> = null;
  try {
    route = internal ? null : (tool.route?.(input) ?? null);
  } catch (error) {
    return trace(null, null, fail(error));
  }
  const resolution: ReturnType<typeof resolveBindings> = internal
    ? {
        kind: "resolved",
        bindings: [{ ...INTERNAL_BINDING, capability: tool.capability }],
        reason: "explicit",
      }
    : resolveBindings(allBindings, {
        capability: tool.capability,
        operationKind: operation.kind,
        connectionId: call.connectionId ?? route?.connectionId ?? null,
        providerKey: route?.providerKey ?? null,
        // An existing item already names its account; a named destination only picks new ones.
        destination: route ? null : readDestination(input),
        strict: operation.kind !== "read" && Boolean(tool.strictDestination),
      });
  if (resolution.kind === "unavailable") {
    return trace(
      null,
      null,
      fail(unavailableError(tool.capability, resolution.reason, allBindings)),
    );
  }
  if (resolution.kind === "clarify") {
    return trace(null, null, {
      status: "clarification_required",
      question: "which_account",
      options: resolution.candidates.map((c) => ({
        connectionId: c.connectionId,
        providerKey: c.providerKey,
        label: c.label,
        account: c.accountLabel,
      })),
    });
  }
  const binding = resolution.bindings[0]!;
  const env: ToolRunEnv = {
    ctx,
    binding,
    providers: ports.providers,
    invoke: nestedReads(ports, ctx),
  };

  if (operation.kind !== "read" && tool.assess) {
    try {
      operation = escalate(operation, await tool.assess(input, env));
    } catch (error) {
      return trace(binding, null, fail(error));
    }
  }

  const decision = decidePolicy({
    operation,
    origin: ctx.origin,
    // The user's own ELISE settings belong to the user: writable, still under policy + audit.
    permission: internal ? "write" : await ports.permissionFor(binding),
  });
  if (decision.kind === "reject")
    return trace(binding, null, { status: "rejected", reason: decision.reason });

  if (operation.kind === "read") {
    try {
      const result =
        resolution.bindings.length > 1 && tool.merge
          ? await aggregateRead(tool, input, ctx, resolution.bindings, ports.providers)
          : await tool.run(input, env);
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

  let described: Awaited<ReturnType<AnyToolDefinition["describe"]>>;
  let pinned: unknown = input;
  try {
    if (tool.pin) pinned = await tool.pin(input, env);
    described = await tool.describe(pinned, env);
  } catch (error) {
    // e.g. the item no longer exists or the times are impossible: a fixable error, not a crash.
    return trace(binding, null, fail(error));
  }
  const { summary, target, preview } = described;
  const inputHash = await sha256(
    stableStringify({ tool: tool.name, input: pinned, connectionId: binding.connectionId }),
  );
  if (decision.kind === "require_approval" && ports.log.findPendingApproval) {
    const pending = await ports.log.findPendingApproval(ctx, inputHash);
    if (pending)
      return trace(binding, pending.actionId, {
        status: "approval_required",
        approvalId: pending.approvalId,
        actionId: pending.actionId,
        summary,
        reason: decision.reason,
        preview,
      });
  }

  const recorded = await ports.log.recordAction(ctx, {
    toolName: tool.name,
    capability: tool.capability,
    operation: tool.operation,
    providerKey: binding.providerKey,
    connectionId: binding.connectionId,
    riskLevel: operation.risk,
    input: pinned,
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
      payload: { input: pinned, summary, target, preview },
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
      preview,
    });
  }

  return runWrite(ports, ctx, actionId, tool.name, pinned, { ...env, actionId }, trace);

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
 * Safe multi-account read: every resolved account is queried in parallel and merged with
 * provenance. Accounts that fail are reported (not hidden); if all fail, the read fails.
 */
async function aggregateRead(
  tool: AnyToolDefinition,
  input: unknown,
  ctx: ToolContext,
  bindings: CapabilityBinding[],
  providers: ProviderFactory,
): Promise<ToolRunResult<unknown>> {
  const settled = await Promise.allSettled(
    bindings.map((b) => tool.run(input, { ctx, binding: b, providers })),
  );
  const ok: { binding: CapabilityBinding; result: ToolRunResult<unknown> }[] = [];
  const unavailable: { account: string; error: string }[] = [];
  let firstError: unknown = null;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push({ binding: bindings[i]!, result: r.value });
    else {
      firstError ??= r.reason;
      unavailable.push({ account: bindings[i]!.label, error: toPublicError(r.reason).code });
    }
  });
  if (ok.length === 0) throw firstError;
  const merged = tool.merge!(ok, input, ctx);
  if (unavailable.length === 0) return merged;
  // Partial failures stay visible to the model and the user, never silently dropped.
  const display =
    merged.display?.kind === "email_list"
      ? { ...merged.display, unavailable: unavailable.map((u) => u.account) }
      : merged.display;
  return { ...merged, display, output: { ...(merged.output as object), unavailable } };
}

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];
const KIND_ORDER: OperationKind[] = [
  "read",
  "write",
  "destructive",
  "sensitive",
  "external_communication",
];
const APPROVAL_ORDER: ApprovalMode[] = ["allow_automatically", "ask_when_uncertain", "always_ask"];

/** Content-aware risk can only make an operation stricter, never looser. */
export function escalate(
  base: OperationDefinition,
  extra: Partial<OperationDefinition> | null,
): OperationDefinition {
  if (!extra) return base;
  const max = <T>(order: T[], current: T, candidate: T | undefined) =>
    candidate !== undefined && order.indexOf(candidate) > order.indexOf(current)
      ? candidate
      : current;
  return {
    kind: max(KIND_ORDER, base.kind, extra.kind),
    risk: max(RISK_ORDER, base.risk, extra.risk),
    defaultApproval: max(APPROVAL_ORDER, base.defaultApproval, extra.defaultApproval),
  };
}

function unavailableError(
  capability: string,
  reason: string,
  bindings: CapabilityBinding[],
): AppError {
  if (reason === "connection_unhealthy") {
    return new AppError("AUTH_EXPIRED", `The ${capability} account needs to be reconnected`, {
      recovery: "reconnect",
    });
  }
  if (reason === "destination_not_found" || reason === "connection_not_found") {
    const names = [
      ...new Set(
        bindings.filter((b) => b.capability === capability && b.enabled).map((b) => b.label),
      ),
    ];
    return new AppError(
      "NOT_FOUND",
      names.length
        ? `No ${capability} account matches. Available: ${names.join(", ")}`
        : `No ${capability} account is connected`,
      { recovery: "review" },
    );
  }
  return new AppError("CAPABILITY_UNAVAILABLE", `${capability} is not connected`, {
    recovery: "configure",
  });
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

  const resolution: ReturnType<typeof resolveBindings> = getCapability(tool.capability).internal
    ? {
        kind: "resolved",
        bindings: [{ ...INTERNAL_BINDING, capability: tool.capability }],
        reason: "explicit",
      }
    : resolveBindings(await ports.loadBindings(), {
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
  const env: ToolRunEnv = { ctx, binding, providers: ports.providers, actionId: approved.actionId };

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
  env: ToolRunEnv,
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
      ...(result.target ? { target: result.target } : {}),
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

/** Stand-in binding for ELISE-internal tools; they never touch a provider. */
const INTERNAL_BINDING: CapabilityBinding = {
  id: "internal",
  capability: "schedules",
  connectionId: "internal",
  providerKey: "elise_native",
  connectionStatus: "connected",
  contextType: null,
  contextId: null,
  priority: 0,
  isDefault: true,
  enabled: true,
  label: "ELISE",
  accountLabel: null,
  contextLabel: null,
};

/**
 * Orchestrations (meeting prep) read other capabilities through this same path, so each read
 * keeps its own resolution, permissions and trace. Writes and presentation tools are refused.
 */
function nestedReads(ports: ExecutorPorts, ctx: ToolContext) {
  return async (name: string, args: unknown): Promise<ToolCallOutcome> => {
    const tool = ports.registry.get(name);
    const op = tool ? getOperation(tool.capability, tool.operation) : undefined;
    if (!tool || !op || op.kind !== "read" || tool.capability === "workspace")
      return fail(
        new AppError("VALIDATION_ERROR", `${name} can't be used inside an orchestration`),
      );
    return executeToolCall(ports, ctx, { name, args });
  };
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
