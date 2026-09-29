import "server-only";

import type { MorningBrief } from "@/core/briefs/morning-brief";
import { AppError } from "@/core/errors";
import { cancelRun, runNow, type RunWarning } from "@/core/schedules/runner";
import {
  briefCapabilities,
  nextOccurrence,
  scheduleInputSchema,
  type RunStatus,
  type ScheduleDefinition,
  type ScheduleInput,
  type ScheduleStatus,
} from "@/core/schedules/schedule";
import { isBackgroundConfigured } from "@/infrastructure/background/trigger/runtime";
import type { Json } from "@/infrastructure/supabase/database.types";
import { toScheduleRecord } from "@/infrastructure/supabase/repositories/schedules";

import type { AuthContext } from "./auth-context";
import { runnerPorts } from "./background";

export interface ScheduleView {
  id: string;
  name: string;
  status: ScheduleStatus;
  timezone: string;
  definition: ScheduleDefinition;
  input: ScheduleInput;
  capabilities: string[];
  nextRunAt: string | null;
  lastRun: RunView | null;
}

export interface RunView {
  id: string;
  status: RunStatus;
  trigger: "scheduled" | "manual";
  scheduledFor: string;
  completedAt: string | null;
  warnings: RunWarning[];
  errorCode: string | null;
  resultId: string | null;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

function computeNext(input: ScheduleInput, now = new Date()): Date | null {
  return nextOccurrence(input.definition, input.timezone, now);
}

function toRunView(r: {
  id: string;
  status: RunStatus;
  trigger: "scheduled" | "manual";
  scheduled_for: string;
  completed_at: string | null;
  warnings: Json;
  error_code: string | null;
  result_id: string | null;
}): RunView {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    scheduledFor: r.scheduled_for,
    completedAt: r.completed_at,
    warnings: (Array.isArray(r.warnings) ? r.warnings : []) as unknown as RunWarning[],
    errorCode: r.error_code,
    resultId: r.result_id,
  };
}

export async function listSchedules(auth: AuthContext): Promise<{
  schedules: ScheduleView[];
  backgroundAvailable: boolean;
}> {
  const { data, error } = await auth.db
    .from("schedules")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("created_by_user_id", auth.userId)
    .is("archived_at", null)
    .order("created_at");
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load schedules", { cause: error });

  const ids = data.map((s) => s.id);
  const { data: runs } = ids.length
    ? await auth.db
        .from("schedule_runs")
        .select(
          "id, schedule_id, status, trigger, scheduled_for, completed_at, warnings, error_code, result_id",
        )
        .in("schedule_id", ids)
        .order("scheduled_for", { ascending: false })
        .limit(ids.length * 5)
    : { data: [] };

  const schedules = data.flatMap((row): ScheduleView[] => {
    try {
      const record = toScheduleRecord(row);
      const input = scheduleInputSchema.parse({
        name: row.name,
        actionType: row.action_type,
        definition: row.schedule_definition,
        timezone: row.timezone,
        configuration: row.configuration,
        instructions: row.instructions,
        delivery: row.delivery_config,
      });
      const last = (runs ?? []).find((r) => r.schedule_id === row.id);
      return [
        {
          id: row.id,
          name: row.name,
          status: record.status,
          timezone: row.timezone,
          definition: record.definition,
          input,
          capabilities: row.capabilities,
          nextRunAt: row.status === "active" ? row.next_run_at : null,
          lastRun: last ? toRunView(last) : null,
        },
      ];
    } catch {
      return [];
    }
  });
  return { schedules, backgroundAvailable: isBackgroundConfigured() };
}

export async function createSchedule(auth: AuthContext, raw: unknown): Promise<string> {
  const input = scheduleInputSchema.parse(raw);
  const next = computeNext(input);
  if (!next) {
    throw new AppError("VALIDATION_ERROR", "That time is already in the past", {
      recovery: "review",
    });
  }
  const { data, error } = await auth.db
    .from("schedules")
    .insert({
      workspace_id: auth.workspaceId,
      created_by_user_id: auth.userId,
      name: input.name,
      schedule_type: input.definition.kind === "once" ? "one_time" : "recurring",
      timezone: input.timezone,
      schedule_definition: json(input.definition),
      action_type: input.actionType,
      configuration: json(input.configuration),
      capabilities: briefCapabilities(input.configuration),
      instructions: input.instructions,
      delivery_config: json(input.delivery),
      next_run_at: next.toISOString(),
    })
    .select("id")
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not create the schedule", { cause: error });
  await audit(auth, data.id, "schedule.created");
  return data.id;
}

async function own(auth: AuthContext, id: string) {
  const { data } = await auth.db
    .from("schedules")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .eq("created_by_user_id", auth.userId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Schedule not found");
  return data;
}

/** Editing recalculates the next run; a run already in progress continues. */
export async function updateSchedule(auth: AuthContext, id: string, raw: unknown): Promise<void> {
  const row = await own(auth, id);
  const input = scheduleInputSchema.parse(raw);
  const next = computeNext(input);
  const { error } = await auth.db
    .from("schedules")
    .update({
      name: input.name,
      schedule_type: input.definition.kind === "once" ? "one_time" : "recurring",
      timezone: input.timezone,
      schedule_definition: json(input.definition),
      configuration: json(input.configuration),
      capabilities: briefCapabilities(input.configuration),
      instructions: input.instructions,
      delivery_config: json(input.delivery),
      next_run_at: next?.toISOString() ?? null,
      status: row.status === "paused" ? "paused" : next ? "active" : "completed",
    })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  if (error)
    throw new AppError("VALIDATION_ERROR", "Could not update the schedule", { cause: error });
  await audit(auth, id, "schedule.updated");
}

/** Pause stops future runs and keeps configuration and history; resume recomputes the next run. */
export async function setSchedulePaused(auth: AuthContext, id: string, paused: boolean) {
  const row = await own(auth, id);
  const record = toScheduleRecord(row);
  const next = paused ? null : nextOccurrence(record.definition, record.timezone, new Date());
  if (!paused && !next) {
    throw new AppError("VALIDATION_ERROR", "This one-time schedule is already in the past", {
      recovery: "review",
    });
  }
  await auth.db
    .from("schedules")
    .update({
      status: paused ? "paused" : "active",
      next_run_at: paused ? row.next_run_at : next!.toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  await audit(auth, id, paused ? "schedule.paused" : "schedule.resumed");
}

/** Delete = archive: no future runs, history and results are kept. */
export async function deleteSchedule(auth: AuthContext, id: string) {
  await own(auth, id);
  await auth.db
    .from("schedules")
    .update({ status: "archived", archived_at: new Date().toISOString(), next_run_at: null })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  await cancelActive(auth, id);
  await audit(auth, id, "schedule.deleted");
}

/** Run Now: same path as a scheduled run (run → background job → handler → result). */
export async function runScheduleNow(auth: AuthContext, id: string): Promise<string> {
  const row = await own(auth, id);
  const run = await runNow(runnerPorts(), toScheduleRecord(row));
  await audit(auth, id, "schedule.run_now");
  return run.id;
}

/** Cancels queued/running work where feasible. Closing the browser never does this. */
export async function cancelActive(auth: AuthContext, scheduleId: string) {
  const { data: runs } = await auth.db
    .from("schedule_runs")
    .select(
      "id, workspace_id, schedule_id, background_job_id, trigger, status, scheduled_for, runtime_metadata",
    )
    .eq("schedule_id", scheduleId)
    .eq("workspace_id", auth.workspaceId)
    .in("status", ["queued", "running"]);
  const ports = runnerPorts();
  for (const r of runs ?? []) {
    const runtimeId =
      (r.runtime_metadata as { runtimeJobId?: string } | null)?.runtimeJobId ?? null;
    await cancelRun(
      ports,
      {
        id: r.id,
        workspaceId: r.workspace_id,
        scheduleId: r.schedule_id,
        jobId: r.background_job_id ?? "",
        trigger: r.trigger,
        status: r.status,
        scheduledFor: new Date(r.scheduled_for),
      },
      runtimeId,
    );
  }
}

export async function listRuns(auth: AuthContext, scheduleId: string): Promise<RunView[]> {
  await own(auth, scheduleId);
  const { data } = await auth.db
    .from("schedule_runs")
    .select("id, status, trigger, scheduled_for, completed_at, warnings, error_code, result_id")
    .eq("schedule_id", scheduleId)
    .eq("workspace_id", auth.workspaceId)
    .order("scheduled_for", { ascending: false })
    .limit(14);
  return (data ?? []).map(toRunView);
}

export interface ResultView {
  id: string;
  title: string;
  createdAt: string;
  readAt: string | null;
  brief: MorningBrief;
  scheduleId: string;
}

export async function getResult(auth: AuthContext, id: string): Promise<ResultView> {
  const { data } = await auth.db
    .from("scheduled_results")
    .select("id, title, created_at, read_at, content, schedule_id")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Result not found");
  return {
    id: data.id,
    title: data.title,
    createdAt: data.created_at,
    readAt: data.read_at,
    brief: data.content as unknown as MorningBrief,
    scheduleId: data.schedule_id,
  };
}

/** The latest brief of the last 18 hours, for the quiet "ready" line on Home. */
export async function latestBrief(
  auth: AuthContext,
): Promise<{ id: string; title: string; read: boolean } | null> {
  const since = new Date(Date.now() - 18 * 3_600_000).toISOString();
  const { data } = await auth.db
    .from("scheduled_results")
    .select("id, title, read_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, title: data.title, read: data.read_at !== null } : null;
}

export async function markResultRead(auth: AuthContext, id: string) {
  await auth.db
    .from("scheduled_results")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", auth.userId)
    .is("read_at", null);
  await auth.db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", auth.userId)
    .eq("action_url", `/schedules/results/${id}`)
    .is("read_at", null);
}

async function audit(auth: AuthContext, scheduleId: string, eventType: string) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: "schedule",
    resource_id: scheduleId,
    origin: "user_ui",
    result: "success",
  });
}
