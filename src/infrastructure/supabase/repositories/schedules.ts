import type { SupabaseClient } from "@supabase/supabase-js";

import { AppError } from "@/core/errors";
import type {
  RunPatch,
  RunRecord,
  RunResult,
  ScheduleRecord,
  ScheduleStore,
} from "@/core/schedules/runner";
import {
  deliverySchema,
  scheduleDefinitionSchema,
  type RunStatus,
  type ScheduleStatus,
} from "@/core/schedules/schedule";

import type { Database, Json, ScheduleRow, ScheduleRunRow } from "../database.types";

type Db = SupabaseClient<Database>;

export function toScheduleRecord(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerUserId: row.created_by_user_id,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    definition: scheduleDefinitionSchema.parse(row.schedule_definition),
    actionType: row.action_type,
    configuration: row.configuration,
    instructions: row.instructions,
    delivery: deliverySchema.parse(row.delivery_config ?? {}),
    nextRunAt: row.next_run_at ? new Date(row.next_run_at) : null,
    archived: row.archived_at !== null || row.status === "archived",
  };
}

function toRunRecord(row: ScheduleRunRow): RunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scheduleId: row.schedule_id,
    jobId: row.background_job_id ?? "",
    trigger: row.trigger,
    status: row.status,
    scheduledFor: new Date(row.scheduled_for),
  };
}

const JOB_STATUS: Partial<
  Record<RunStatus, Database["public"]["Tables"]["background_jobs"]["Row"]["status"]>
> = {
  queued: "queued",
  running: "running",
  waiting_for_approval: "waiting_for_approval",
  completed: "completed",
  completed_with_warning: "completed_with_warning",
  failed: "failed",
  cancelled: "cancelled",
};

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

/**
 * Schedule runs, jobs and results for background execution. Uses the service role (there is
 * no user session in the background), so every statement is scoped by workspace explicitly.
 */
export class SupabaseScheduleStore implements ScheduleStore {
  constructor(private readonly db: Db) {}

  async dueSchedules(now: Date, limit: number): Promise<ScheduleRecord[]> {
    const { data, error } = await this.db
      .from("schedules")
      .select("*")
      .eq("status", "active")
      .is("archived_at", null)
      .lte("next_run_at", now.toISOString())
      .order("next_run_at")
      .limit(limit);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not load due schedules", { cause: error });
    return data.flatMap((row) => {
      try {
        return [toScheduleRecord(row)];
      } catch {
        return [];
      }
    });
  }

  async advance(
    scheduleId: string,
    expected: Date,
    next: Date | null,
    patch: { status?: ScheduleStatus; lastRunAt: Date },
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from("schedules")
      .update({
        next_run_at: next?.toISOString() ?? null,
        last_run_at: patch.lastRunAt.toISOString(),
        ...(patch.status ? { status: patch.status } : {}),
      })
      .eq("id", scheduleId)
      .eq("status", "active")
      .eq("next_run_at", expected.toISOString())
      .select("id");
    if (error) throw new AppError("INTERNAL_ERROR", "Could not advance schedule", { cause: error });
    return data.length === 1;
  }

  async createRun(
    schedule: ScheduleRecord,
    run: { trigger: RunRecord["trigger"]; scheduledFor: Date; status: RunStatus },
  ): Promise<RunRecord | null> {
    const terminal = run.status !== "queued";
    const { data: job, error: jobError } = await this.db
      .from("background_jobs")
      .insert({
        workspace_id: schedule.workspaceId,
        user_id: schedule.ownerUserId,
        job_type: "schedule.run",
        status: JOB_STATUS[run.status] ?? "cancelled",
        ...(terminal ? { completed_at: new Date().toISOString() } : {}),
      })
      .select("id")
      .single();
    if (jobError) throw new AppError("INTERNAL_ERROR", "Could not create job", { cause: jobError });

    const { data, error } = await this.db
      .from("schedule_runs")
      .insert({
        workspace_id: schedule.workspaceId,
        schedule_id: schedule.id,
        background_job_id: job.id,
        trigger: run.trigger,
        status: run.status,
        scheduled_for: run.scheduledFor.toISOString(),
        ...(terminal ? { completed_at: new Date().toISOString() } : {}),
      })
      .select("*")
      .single();
    if (error) {
      await this.db.from("background_jobs").delete().eq("id", job.id);
      // 23505: this occurrence already has a run, or another run is still active.
      if (error.code === "23505") return null;
      throw new AppError("INTERNAL_ERROR", "Could not create run", { cause: error });
    }
    return toRunRecord(data);
  }

  async loadRun(workspaceId: string, runId: string) {
    const { data: run } = await this.db
      .from("schedule_runs")
      .select("*")
      .eq("id", runId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!run) return null;
    const { data: schedule } = await this.db
      .from("schedules")
      .select("*")
      .eq("id", run.schedule_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!schedule) return null;
    return { run: toRunRecord(run), schedule: toScheduleRecord(schedule) };
  }

  async runByApproval(approvalId: string): Promise<RunRecord | null> {
    const { data } = await this.db
      .from("schedule_runs")
      .select("*")
      .eq("approval_id", approvalId)
      .maybeSingle();
    return data ? toRunRecord(data) : null;
  }

  async ownerIsActiveMember(workspaceId: string, userId: string): Promise<boolean> {
    const [{ data: member }, { data: workspace }] = await Promise.all([
      this.db
        .from("workspace_members")
        .select("status")
        .eq("workspace_id", workspaceId)
        .eq("user_id", userId)
        .maybeSingle(),
      this.db.from("workspaces").select("archived_at").eq("id", workspaceId).maybeSingle(),
    ]);
    return member?.status === "active" && Boolean(workspace) && workspace?.archived_at === null;
  }

  async updateRun(run: RunRecord, patch: RunPatch): Promise<void> {
    const iso = (d?: Date) => d?.toISOString();
    const runUpdate: Database["public"]["Tables"]["schedule_runs"]["Update"] = {};
    if (patch.status) runUpdate.status = patch.status;
    if (patch.startedAt) runUpdate.started_at = iso(patch.startedAt);
    if (patch.completedAt) runUpdate.completed_at = iso(patch.completedAt);
    if (patch.warnings) runUpdate.warnings = json(patch.warnings);
    if (patch.errorCode !== undefined) runUpdate.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) runUpdate.error_message = patch.errorMessage;
    if (patch.approvalId !== undefined) runUpdate.approval_id = patch.approvalId;
    if (patch.resultId !== undefined) runUpdate.result_id = patch.resultId;
    if (patch.runtimeJobId) runUpdate.runtime_metadata = json({ runtimeJobId: patch.runtimeJobId });

    const jobUpdate: Database["public"]["Tables"]["background_jobs"]["Update"] = {};
    if (patch.status) jobUpdate.status = JOB_STATUS[patch.status] ?? "cancelled";
    if (patch.startedAt) jobUpdate.started_at = iso(patch.startedAt);
    if (patch.completedAt) jobUpdate.completed_at = iso(patch.completedAt);
    if (patch.errorCode !== undefined) jobUpdate.error_code = patch.errorCode;
    if (patch.errorMessage !== undefined) jobUpdate.error_message = patch.errorMessage;
    if (patch.attempts !== undefined) jobUpdate.attempts = patch.attempts;
    if (patch.runtimeJobId) jobUpdate.runtime_job_id = patch.runtimeJobId;
    if (patch.resultId) jobUpdate.result_reference = json({ scheduledResultId: patch.resultId });

    const [runRes, jobRes] = await Promise.all([
      Object.keys(runUpdate).length
        ? this.db
            .from("schedule_runs")
            .update(runUpdate)
            .eq("id", run.id)
            .eq("workspace_id", run.workspaceId)
        : null,
      run.jobId && Object.keys(jobUpdate).length
        ? this.db
            .from("background_jobs")
            .update(jobUpdate)
            .eq("id", run.jobId)
            .eq("workspace_id", run.workspaceId)
        : null,
    ]);
    const error = runRes?.error ?? jobRes?.error;
    if (error) throw new AppError("INTERNAL_ERROR", "Could not update run", { cause: error });
  }

  async saveResult(run: RunRecord, schedule: ScheduleRecord, result: RunResult): Promise<string> {
    const { data, error } = await this.db
      .from("scheduled_results")
      .upsert(
        {
          workspace_id: run.workspaceId,
          user_id: schedule.ownerUserId,
          schedule_id: schedule.id,
          schedule_run_id: run.id,
          result_type: result.type,
          title: result.title,
          content: json(result.content),
          metadata: json(result.metadata ?? {}),
        },
        { onConflict: "schedule_run_id" },
      )
      .select("id")
      .single();
    if (error) throw new AppError("INTERNAL_ERROR", "Could not save the result", { cause: error });
    return data.id;
  }

  async notify(
    run: RunRecord,
    schedule: ScheduleRecord,
    n: { type: string; title: string; url: string },
  ): Promise<void> {
    // Unique per (run, type): a retry never notifies twice. Titles never carry content.
    const { error } = await this.db.from("notifications").insert({
      workspace_id: run.workspaceId,
      user_id: schedule.ownerUserId,
      notification_type: n.type,
      title: n.title,
      source_type: "schedule_run",
      source_id: run.id,
      action_url: n.url,
      metadata: json({ scheduleId: schedule.id, browser: schedule.delivery.notify === "browser" }),
    });
    if (error && error.code !== "23505") {
      throw new AppError("INTERNAL_ERROR", "Could not notify", { cause: error });
    }
  }

  async expireStaleRuns(before: Date): Promise<number> {
    const { data, error } = await this.db
      .from("schedule_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_code: "TIMEOUT",
        error_message: "The run did not finish in time",
      })
      .in("status", ["queued", "running"])
      .lt("created_at", before.toISOString())
      .select("background_job_id");
    if (error) throw new AppError("INTERNAL_ERROR", "Could not expire runs", { cause: error });
    const jobs = data.map((r) => r.background_job_id).filter((id): id is string => Boolean(id));
    if (jobs.length) {
      await this.db
        .from("background_jobs")
        .update({ status: "failed", error_code: "TIMEOUT", completed_at: new Date().toISOString() })
        .in("id", jobs);
    }
    return data.length;
  }

  async setScheduleStatus(schedule: ScheduleRecord, status: ScheduleStatus): Promise<void> {
    await this.db
      .from("schedules")
      .update({ status })
      .eq("id", schedule.id)
      .eq("workspace_id", schedule.workspaceId);
  }
}
