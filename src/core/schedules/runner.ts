import type { BackgroundRuntime } from "../background/runtime";
import { AppError, toAppError } from "../errors";
import {
  isMissed,
  nextOccurrence,
  type ActionType,
  type Delivery,
  type RunStatus,
  type ScheduleDefinition,
  type ScheduleStatus,
} from "./schedule";

/**
 * Schedule execution (docs/architecture/13 §37, 14 §22). Pure orchestration over ports:
 * the store (Supabase), the background runtime (Trigger.dev) and one handler per action type
 * (Morning Brief). Dispatch and Run Now share the same path: occurrence → ScheduleRun →
 * background job → handler → result.
 */

export interface ScheduleRecord {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  status: ScheduleStatus;
  timezone: string;
  definition: ScheduleDefinition;
  actionType: ActionType;
  configuration: unknown;
  instructions: string | null;
  delivery: Delivery;
  nextRunAt: Date | null;
  archived: boolean;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  scheduleId: string;
  jobId: string;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  scheduledFor: Date;
}

export interface RunWarning {
  block: string;
  code: string;
  account?: string;
}

export interface RunPatch {
  status?: RunStatus;
  startedAt?: Date;
  completedAt?: Date;
  warnings?: RunWarning[];
  errorCode?: string | null;
  errorMessage?: string | null;
  approvalId?: string | null;
  resultId?: string | null;
  attempts?: number;
  runtimeJobId?: string;
}

/** Persistence port. Implemented over Supabase with the service role, always workspace-scoped. */
export interface ScheduleStore {
  dueSchedules(now: Date, limit: number): Promise<ScheduleRecord[]>;
  /** Compare-and-set on next_run_at: true only for the one caller that advanced it. */
  advance(
    scheduleId: string,
    expected: Date,
    next: Date | null,
    patch: { status?: ScheduleStatus; lastRunAt: Date },
  ): Promise<boolean>;
  /**
   * Inserts the run and its background job. Returns null when the occurrence already exists
   * or (for queued runs) another run of this schedule is still active.
   */
  createRun(
    schedule: ScheduleRecord,
    run: { trigger: RunRecord["trigger"]; scheduledFor: Date; status: RunStatus },
  ): Promise<RunRecord | null>;
  loadRun(
    workspaceId: string,
    runId: string,
  ): Promise<{ run: RunRecord; schedule: ScheduleRecord } | null>;
  runByApproval(approvalId: string): Promise<RunRecord | null>;
  ownerIsActiveMember(workspaceId: string, userId: string): Promise<boolean>;
  updateRun(run: RunRecord, patch: RunPatch): Promise<void>;
  /** Idempotent per run: a retried run never stores a second result. */
  saveResult(run: RunRecord, schedule: ScheduleRecord, result: RunResult): Promise<string>;
  /** Idempotent per run and type. */
  notify(
    run: RunRecord,
    schedule: ScheduleRecord,
    notification: { type: string; title: string; url: string },
  ): Promise<void>;
  setScheduleStatus(schedule: ScheduleRecord, status: ScheduleStatus): Promise<void>;
  /** Marks queued/running runs created before `before` as failed; returns how many. */
  expireStaleRuns(before: Date): Promise<number>;
}

export type { BackgroundRuntime };

export interface RunResult {
  type: ActionType;
  title: string;
  content: unknown;
  metadata?: Record<string, unknown>;
  /** The conversation the run opened (ADR-041): where its result lives and is opened. */
  conversationId?: string | null;
}

export type HandlerOutcome =
  | { kind: "result"; result: RunResult; warnings: RunWarning[] }
  /** A tool asked for the user's approval: the run pauses until it is decided. */
  | { kind: "waiting_for_approval"; approvalId: string };

export type ActionHandler = (input: {
  schedule: ScheduleRecord;
  run: RunRecord;
  now: Date;
}) => Promise<HandlerOutcome>;

export interface RunnerPorts {
  store: ScheduleStore;
  runtime: BackgroundRuntime;
  handlers: Record<ActionType, ActionHandler>;
  now(): Date;
  log?(event: string, fields: Record<string, unknown>): void;
}

export const MAX_ATTEMPTS = 3;
/** Longer than any run can take with retries; a run still active after this was lost. */
export const STALE_RUN_MINUTES = 45;
const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "completed",
  "completed_with_warning",
  "failed",
  "cancelled",
  "missed",
  "skipped",
]);

async function enqueue(ports: RunnerPorts, run: RunRecord): Promise<RunRecord> {
  try {
    const { runtimeJobId } = await ports.runtime.enqueue({
      type: "schedule.run",
      payload: { workspaceId: run.workspaceId, scheduleRunId: run.id },
      idempotencyKey: `schedule-run:${run.id}`,
    });
    await ports.store.updateRun(run, { runtimeJobId });
    return run;
  } catch (error) {
    const e = toAppError(error);
    await ports.store.updateRun(run, {
      status: "failed",
      completedAt: ports.now(),
      errorCode: "BACKGROUND_ERROR",
      errorMessage: e.message,
    });
    throw new AppError("BACKGROUND_ERROR", "The run could not be started", { cause: error });
  }
}

/**
 * Claims every due occurrence exactly once (compare-and-set on next_run_at, plus a unique
 * run per occurrence) and hands it to the background runtime. Occurrences that are too late
 * for their type are recorded as missed; one that overlaps an active run is skipped.
 */
export async function dispatchDue(ports: RunnerPorts, limit = 50): Promise<{ started: number }> {
  const now = ports.now();
  let started = 0;
  // A run the runtime never started (or lost) must not block the schedule forever.
  await ports.store.expireStaleRuns(new Date(now.getTime() - STALE_RUN_MINUTES * 60_000));
  for (const schedule of await ports.store.dueSchedules(now, limit)) {
    const scheduledFor = schedule.nextRunAt;
    if (!scheduledFor) continue;
    // After an outage, jump to the next future occurrence instead of replaying every one.
    const next = nextOccurrence(schedule.definition, schedule.timezone, now);
    const won = await ports.store.advance(schedule.id, scheduledFor, next, {
      lastRunAt: scheduledFor,
      ...(next === null ? { status: "completed" } : {}),
    });
    if (!won) continue;

    if (isMissed(schedule.actionType, scheduledFor, now)) {
      await ports.store.createRun(schedule, {
        trigger: "scheduled",
        scheduledFor,
        status: "missed",
      });
      ports.log?.("schedule.run_missed", { schedule_id: schedule.id });
      continue;
    }
    const run = await ports.store.createRun(schedule, {
      trigger: "scheduled",
      scheduledFor,
      status: "queued",
    });
    if (!run) {
      await ports.store.createRun(schedule, {
        trigger: "scheduled",
        scheduledFor,
        status: "skipped",
      });
      continue;
    }
    await enqueue(ports, run).then(
      () => started++,
      () => undefined,
    );
  }
  return { started };
}

/** Run Now: the same run + background path as a scheduled occurrence. */
export async function runNow(ports: RunnerPorts, schedule: ScheduleRecord): Promise<RunRecord> {
  if (schedule.archived) throw new AppError("NOT_FOUND", "Schedule not found");
  const run = await ports.store.createRun(schedule, {
    trigger: "manual",
    scheduledFor: ports.now(),
    status: "queued",
  });
  if (!run) {
    throw new AppError("CONFLICT", "This schedule is already running", { recovery: "review" });
  }
  return enqueue(ports, run);
}

/**
 * Executes one run inside the background runtime. Revalidates everything at run time (the
 * schedule, its owner's membership); providers, permissions and policies are resolved again
 * by the handler through the normal tool path. A schedule is never a standing authorization.
 *
 * Throws only for transient failures that the runtime should retry.
 */
export async function executeRun(
  ports: RunnerPorts,
  job: { workspaceId: string; scheduleRunId: string; attempt: number },
): Promise<RunStatus> {
  const loaded = await ports.store.loadRun(job.workspaceId, job.scheduleRunId);
  if (!loaded) return "failed";
  const { run, schedule } = loaded;
  // Duplicate delivery or a retry after completion: nothing to do.
  if (TERMINAL.has(run.status) || run.status === "waiting_for_approval") return run.status;

  const stop = async (status: RunStatus, errorCode: string | null, errorMessage: string | null) => {
    await ports.store.updateRun(run, { status, completedAt: ports.now(), errorCode, errorMessage });
    return status;
  };
  if (schedule.archived) return stop("cancelled", "NOT_FOUND", "The schedule was deleted");
  if (
    run.trigger === "scheduled" &&
    schedule.status !== "active" &&
    schedule.status !== "completed"
  ) {
    return stop("cancelled", null, "The schedule is paused");
  }
  if (!(await ports.store.ownerIsActiveMember(schedule.workspaceId, schedule.ownerUserId))) {
    return stop("failed", "PERMISSION_DENIED", "The schedule owner no longer has access");
  }

  await ports.store.updateRun(run, {
    status: "running",
    startedAt: ports.now(),
    attempts: job.attempt,
  });
  const started = Date.now();

  let outcome: HandlerOutcome;
  try {
    outcome = await ports.handlers[schedule.actionType]({ schedule, run, now: ports.now() });
  } catch (error) {
    const e = toAppError(error);
    if (e.retryable && job.attempt < MAX_ATTEMPTS) {
      await ports.store.updateRun(run, { status: "queued", errorCode: e.code });
      ports.log?.("schedule.run_retry", {
        schedule_run_id: run.id,
        attempt: job.attempt,
        code: e.code,
      });
      throw e;
    }
    ports.log?.("schedule.run_failed", { schedule_run_id: run.id, code: e.code });
    return stop("failed", e.code, e.message);
  }

  if (outcome.kind === "waiting_for_approval") {
    await ports.store.updateRun(run, {
      status: "waiting_for_approval",
      approvalId: outcome.approvalId,
    });
    await ports.store.notify(run, schedule, {
      type: "schedule.approval_requested",
      title: `${schedule.name} needs your approval`,
      url: "/approvals",
    });
    return "waiting_for_approval";
  }

  // Cooperative cancellation: a run cancelled meanwhile does not publish a result.
  const current = await ports.store.loadRun(job.workspaceId, run.id);
  if (current?.run.status === "cancelled") return "cancelled";

  const resultId = await ports.store.saveResult(run, schedule, outcome.result);
  const status: RunStatus = outcome.warnings.length ? "completed_with_warning" : "completed";
  await ports.store.updateRun(run, {
    status,
    completedAt: ports.now(),
    warnings: outcome.warnings,
    resultId,
    errorCode: null,
    errorMessage: null,
  });
  if (schedule.delivery.notify !== "none") {
    await ports.store.notify(run, schedule, {
      type: "schedule.result_ready",
      title: schedule.name,
      // The result's stable link: it opens the run's conversation (or the legacy view).
      url: `/schedules/results/${resultId}`,
    });
  }
  ports.log?.("schedule.run_completed", {
    schedule_run_id: run.id,
    status,
    warnings: outcome.warnings.length,
    duration_ms: Date.now() - started,
  });
  return status;
}

/** Resume point: a run waiting for approval finishes once the user decides. */
export async function resumeAfterApproval(
  ports: RunnerPorts,
  approvalId: string,
  decision: { approved: boolean; succeeded: boolean; errorCode?: string | null },
): Promise<void> {
  const run = await ports.store.runByApproval(approvalId);
  if (!run || run.status !== "waiting_for_approval") return;
  await ports.store.updateRun(run, {
    status: !decision.approved ? "cancelled" : decision.succeeded ? "completed" : "failed",
    completedAt: ports.now(),
    errorCode: decision.succeeded ? null : (decision.errorCode ?? null),
  });
}

/** Cancel pending work where feasible; completed external actions are not undone. */
export async function cancelRun(ports: RunnerPorts, run: RunRecord, runtimeJobId: string | null) {
  if (TERMINAL.has(run.status)) return;
  if (runtimeJobId) await ports.runtime.cancel(runtimeJobId).catch(() => undefined);
  await ports.store.updateRun(run, { status: "cancelled", completedAt: ports.now() });
}
