import "server-only";

import {
  executeApprovedAction,
  INTERNAL_CONNECTION_ID,
  type ToolCallOutcome,
} from "@/core/agents/executor";
import type { ActionOrigin, ToolDisplay } from "@/core/agents/tools";
import { getCapability } from "@/core/capabilities/registry";
import { AppError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import type { PendingForVoice } from "@/core/voice/approval";

import type { AuthContext } from "./auth-context";
import { resumeScheduleRunAfterApproval } from "./background";
import { createExecutorPorts, toolContext } from "./elise";

export interface PendingApproval {
  id: string;
  summary: string;
  reason: string;
  capability: string;
  createdAt: string;
  expiresAt: string | null;
  preview?: ToolDisplay;
}

export async function listPendingApprovals(auth: AuthContext): Promise<PendingApproval[]> {
  const { data, error } = await auth.db
    .from("approvals")
    .select("id, summary, reason, capability_key, created_at, expires_at, payload_snapshot")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load approvals", { cause: error });
  return data.map((a) => ({
    id: a.id,
    summary: a.summary,
    reason: a.reason,
    capability: a.capability_key,
    createdAt: a.created_at,
    expiresAt: a.expires_at,
    preview: (a.payload_snapshot as { preview?: ToolDisplay } | null)?.preview,
  }));
}

/**
 * Resolves an approval exactly once (compare-and-set on status = 'pending'), then executes the
 * approved payload after revalidating it (docs/architecture/15 §33, §87).
 */
export async function resolveApproval(
  auth: AuthContext,
  approvalId: string,
  decision: "approved" | "rejected",
  /** How the user decided (the audit trail says "voice" for a spoken "sí"). */
  channel: "ui" | "voice" = "ui",
): Promise<ToolCallOutcome | null> {
  const now = new Date().toISOString();
  const { data: approval, error } = await auth.db
    .from("approvals")
    .update({ status: decision, resolved_at: now, resolved_by_user_id: auth.userId })
    .eq("id", approvalId)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "pending")
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .select("id, action_id, payload_hash, connection_id")
    .maybeSingle();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not resolve the approval", { cause: error });
  if (!approval) {
    await expireIfNeeded(auth, approvalId, now);
    throw new AppError("CONFLICT", "This approval was already resolved or has expired", {
      recovery: "review",
    });
  }

  const { data: action, error: actionError } = await auth.db
    .from("actions")
    .select("id, tool_name, input_snapshot, origin, ai_run_id")
    .eq("id", approval.action_id)
    .eq("workspace_id", auth.workspaceId)
    .single();
  if (actionError)
    throw new AppError("NOT_FOUND", "The approved action no longer exists", { cause: actionError });

  const ports = createExecutorPorts(auth);
  const ctx = toolContext(auth, action.origin as ActionOrigin, action.ai_run_id);
  await ports.log.audit(ctx, {
    eventType: `approval.${decision}`,
    actionId: action.id,
    approvalId,
    result: "success",
    metadata: { channel },
  });

  if (decision === "rejected") {
    await auth.db.from("actions").update({ status: "cancelled" }).eq("id", action.id);
    await resumeRun(approvalId, { approved: false, succeeded: false });
    return null;
  }
  // ELISE's own capabilities (archiving a Knowledge Space…) have no provider account: their
  // approval runs through the internal binding the action was hashed with.
  const tool = ports.registry.get(action.tool_name);
  const internal = tool ? Boolean(getCapability(tool.capability).internal) : false;
  const connectionId = approval.connection_id ?? (internal ? INTERNAL_CONNECTION_ID : null);
  if (!connectionId) throw new AppError("CONFLICT", "The approved action has no destination");

  await auth.db.from("actions").update({ status: "executing" }).eq("id", action.id);
  const outcome = await executeApprovedAction(ports, ctx, {
    actionId: action.id,
    approvalId,
    toolName: action.tool_name,
    input: action.input_snapshot,
    connectionId,
    payloadHash: approval.payload_hash,
  });
  await resumeRun(approvalId, {
    approved: true,
    succeeded: outcome.status === "succeeded",
    errorCode: outcome.status === "failed" ? outcome.error.code : null,
  });
  return outcome;
}

/**
 * Pending approvals as a spoken answer may bind to them (ADR-017 §16): whether each was
 * requested in this same interaction, and by its most recent reply.
 */
export async function pendingForInteraction(
  auth: AuthContext,
  thread: ThreadRef,
  /** Read before this turn's run exists (in parallel with the rest of the turn's setup). */
  currentRunId: string | null = null,
): Promise<PendingForVoice[]> {
  const { data: pending } = await auth.db
    .from("approvals")
    .select("id, summary, created_at, action_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(10);
  if (!pending?.length) return [];
  const { data: actions } = await auth.db
    .from("actions")
    .select("id, ai_run_id")
    .eq("workspace_id", auth.workspaceId)
    .in(
      "id",
      pending.map((p) => p.action_id),
    );
  const column = thread.kind === "conversation" ? "conversation_id" : "interaction_session_id";
  let runsQuery = auth.db
    .from("ai_runs")
    .select("id, started_at")
    .eq("workspace_id", auth.workspaceId)
    .eq(column, thread.id);
  if (currentRunId) runsQuery = runsQuery.neq("id", currentRunId);
  const { data: runs } = await runsQuery.order("started_at", { ascending: false }).limit(20);
  const inThread = new Set((runs ?? []).map((r) => r.id));
  const lastRun = runs?.[0]?.id ?? null;
  const runOf = new Map((actions ?? []).map((a) => [a.id, a.ai_run_id]));
  return pending.map((p) => {
    const run = runOf.get(p.action_id) ?? null;
    return {
      id: p.id,
      summary: p.summary,
      createdAt: p.created_at,
      sameInteraction: Boolean(run && inThread.has(run)),
      fromLastReply: Boolean(run && run === lastRun),
    };
  });
}

/** A schedule run waiting on this approval (if any) finishes with the decision. */
async function resumeRun(
  approvalId: string,
  decision: Parameters<typeof resumeScheduleRunAfterApproval>[1],
) {
  // Best effort: the approval itself is already resolved and executed.
  await resumeScheduleRunAfterApproval(approvalId, decision).catch(() => undefined);
}

async function expireIfNeeded(auth: AuthContext, approvalId: string, now: string) {
  await auth.db
    .from("approvals")
    .update({ status: "expired", resolved_at: now })
    .eq("id", approvalId)
    .eq("status", "pending")
    .lte("expires_at", now);
}
