import type { ActionLog, NewAction, StoredAction } from "@/core/agents/executor";
import type { ToolContext } from "@/core/agents/tools";
import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

import type { Json } from "../database.types";
import type { ServerSupabase } from "../server";

const APPROVAL_TTL_HOURS = 24;

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

/**
 * Supabase-backed persistence for actions, approvals, tool traces and audit.
 * Trace/audit failures are logged, never allowed to break the user's request.
 */
export class SupabaseActionLog implements ActionLog {
  constructor(private readonly db: ServerSupabase) {}

  async recordAction(
    ctx: ToolContext,
    action: NewAction,
  ): Promise<{ action: StoredAction; duplicate: boolean }> {
    const { data, error } = await this.db
      .from("actions")
      .insert({
        workspace_id: ctx.workspaceId,
        user_id: ctx.userId,
        ai_run_id: ctx.aiRunId,
        tool_name: action.toolName,
        capability_key: action.capability,
        operation: action.operation,
        provider_key: action.providerKey,
        connection_id: action.connectionId,
        target_type: action.target?.type ?? null,
        target_id: action.target?.id ?? null,
        risk_level: action.riskLevel,
        origin: ctx.origin,
        status: action.status,
        input_snapshot: asJson(action.input),
        input_hash: action.inputHash,
        idempotency_key: action.idempotencyKey,
      })
      .select("id, status, result_reference")
      .single();

    if (error?.code === "23505" && action.idempotencyKey) {
      const existing = await this.db
        .from("actions")
        .select("id, status, result_reference")
        .eq("workspace_id", ctx.workspaceId)
        .eq("idempotency_key", action.idempotencyKey)
        .single();
      if (existing.error)
        throw new AppError("INTERNAL_ERROR", "Could not load action", { cause: existing.error });
      return { action: toStored(existing.data), duplicate: true };
    }
    if (error) throw new AppError("INTERNAL_ERROR", "Could not record action", { cause: error });
    return { action: toStored(data), duplicate: false };
  }

  async finishAction(
    ctx: ToolContext,
    actionId: string,
    result: {
      status: "completed" | "failed";
      resultReference?: Record<string, unknown>;
      errorCode?: string;
    },
  ): Promise<void> {
    const { error } = await this.db
      .from("actions")
      .update({
        status: result.status,
        result_reference: result.resultReference ? asJson(result.resultReference) : null,
        error_code: result.errorCode ?? null,
        executed_at: new Date().toISOString(),
      })
      .eq("id", actionId)
      .eq("workspace_id", ctx.workspaceId);
    if (error) logger.error("action.finish_failed", { actionId, dbCode: error.code });
  }

  async requestApproval(
    ctx: ToolContext,
    a: Parameters<ActionLog["requestApproval"]>[1],
  ): Promise<{ id: string }> {
    const { data, error } = await this.db
      .from("approvals")
      .insert({
        workspace_id: ctx.workspaceId,
        user_id: ctx.userId,
        action_id: a.actionId,
        capability_key: a.capability,
        operation: a.operation,
        provider_key: a.providerKey,
        connection_id: a.connectionId,
        risk_level: a.riskLevel,
        payload_snapshot: asJson(a.payload),
        payload_hash: a.payloadHash,
        summary: a.summary,
        reason: a.reason,
        expires_at: new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw new AppError("INTERNAL_ERROR", "Could not request approval", { cause: error });
    return data;
  }

  async recordToolExecution(
    ctx: ToolContext,
    e: Parameters<ActionLog["recordToolExecution"]>[1],
  ): Promise<void> {
    const { error } = await this.db.from("tool_executions").insert({
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      ai_run_id: ctx.aiRunId,
      action_id: e.actionId,
      tool_name: e.toolName,
      provider_key: e.providerKey,
      connection_id: e.connectionId,
      status: e.status,
      latency_ms: e.latencyMs,
      error_code: e.errorCode,
      started_at: e.startedAt.toISOString(),
    });
    logger.info("tool.executed", {
      tool: e.toolName,
      status: e.status,
      latency_ms: e.latencyMs,
      error_code: e.errorCode,
      workspace_id: ctx.workspaceId,
      run_id: ctx.aiRunId,
      origin: ctx.origin,
    });
    if (error) logger.error("tool_execution.record_failed", { dbCode: error.code });
  }

  async audit(ctx: ToolContext, e: Parameters<ActionLog["audit"]>[1]): Promise<void> {
    const { error } = await this.db.from("audit_events").insert({
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      event_type: e.eventType,
      resource_type: e.resourceType ?? null,
      resource_id: e.resourceId ?? null,
      action_id: e.actionId ?? null,
      approval_id: e.approvalId ?? null,
      provider_key: e.providerKey ?? null,
      connection_id: e.connectionId ?? null,
      origin: ctx.origin,
      result: e.result,
      metadata: asJson(e.metadata ?? {}),
    });
    if (error) logger.error("audit.record_failed", { eventType: e.eventType, dbCode: error.code });
  }
}

function toStored(row: {
  id: string;
  status: string;
  result_reference: Json | null;
}): StoredAction {
  return {
    id: row.id,
    status: row.status,
    resultReference: (row.result_reference as Record<string, unknown> | null) ?? null,
  };
}
