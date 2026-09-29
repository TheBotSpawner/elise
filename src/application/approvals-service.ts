import "server-only";

import { executeApprovedAction, type ToolCallOutcome } from "@/core/agents/executor";
import type { ActionOrigin } from "@/core/agents/tools";
import { AppError } from "@/core/errors";

import type { AuthContext } from "./auth-context";
import { createExecutorPorts, toolContext } from "./elise";

export interface PendingApproval {
  id: string;
  summary: string;
  reason: string;
  capability: string;
  createdAt: string;
  expiresAt: string | null;
}

export async function listPendingApprovals(auth: AuthContext): Promise<PendingApproval[]> {
  const { data, error } = await auth.db
    .from("approvals")
    .select("id, summary, reason, capability_key, created_at, expires_at")
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
  });

  if (decision === "rejected") {
    await auth.db.from("actions").update({ status: "cancelled" }).eq("id", action.id);
    return null;
  }
  if (!approval.connection_id)
    throw new AppError("CONFLICT", "The approved action has no destination");

  await auth.db.from("actions").update({ status: "executing" }).eq("id", action.id);
  return executeApprovedAction(ports, ctx, {
    actionId: action.id,
    approvalId,
    toolName: action.tool_name,
    input: action.input_snapshot,
    connectionId: approval.connection_id,
    payloadHash: approval.payload_hash,
  });
}

async function expireIfNeeded(auth: AuthContext, approvalId: string, now: string) {
  await auth.db
    .from("approvals")
    .update({ status: "expired", resolved_at: now })
    .eq("id", approvalId)
    .eq("status", "pending")
    .lte("expires_at", now);
}
