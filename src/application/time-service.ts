import "server-only";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  AUTO_START,
  completionText,
  DEFAULT_TIME_PREFERENCES,
  endRunDecision,
  isActive,
  settle,
  SOUNDS,
  startState,
  type NewTimer,
  type TimePreferences,
  type Timer,
  type TimerPatch,
  type TimerStore,
} from "@/core/timers/model";
import { timerSnapshot, type TimerPayload } from "@/core/workspace/time";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import { logger } from "@/infrastructure/observability/logger";
import type { TimerRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Native Time (ADR-045): the user's timers, through RLS (owner only).
 *
 * Durability: every change that leaves a timer running schedules a delayed background run at
 * its end (Trigger.dev), keyed by the timer's version. Any read also settles overdue timers, so a
 * missed run, a sleeping laptop or a local setup without the worker still completes them — at
 * their real end time. Writes apply only to the version they were computed from.
 */

const MAX_LIST = 50;
const RECENT_MS = 12 * 3_600_000;

const pomodoroSchema = z.object({
  focusMs: z
    .number()
    .int()
    .min(60_000)
    .max(3 * 3_600_000),
  shortBreakMs: z.number().int().min(60_000).max(3_600_000),
  longBreakMs: z
    .number()
    .int()
    .min(0)
    .max(90 * 60_000),
  cycles: z.number().int().min(1).max(12),
  autoStart: z.enum(AUTO_START),
});

export const timePreferencesSchema = z.object({
  sound: z.enum(SOUNDS),
  notify: z.boolean(),
  pomodoro: pomodoroSchema,
});

const toTimer = (r: TimerRow): Timer => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  state: r.state,
  durationMs: Number(r.duration_ms),
  startedAt: r.started_at,
  endsAt: r.ends_at,
  remainingMs: r.remaining_ms === null ? null : Number(r.remaining_ms),
  elapsedMs: Number(r.elapsed_ms),
  laps: (r.laps ?? []).map(Number),
  pomodoro: r.pomodoro as Timer["pomodoro"],
  version: r.version,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  provenance: {
    conversationId: r.created_from_conversation_id,
    sessionId: r.created_from_session_id,
    scheduleId: r.created_from_schedule_id,
    spaceId: r.created_from_space_id,
  },
});

/** The columns a patch writes (only what changed, plus the next version). */
function toColumns(p: TimerPatch) {
  return {
    ...(p.state !== undefined ? { state: p.state } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.durationMs !== undefined ? { duration_ms: p.durationMs } : {}),
    ...(p.startedAt !== undefined ? { started_at: p.startedAt } : {}),
    ...(p.endsAt !== undefined ? { ends_at: p.endsAt } : {}),
    ...(p.remainingMs !== undefined ? { remaining_ms: p.remainingMs } : {}),
    ...(p.elapsedMs !== undefined ? { elapsed_ms: p.elapsedMs } : {}),
    ...(p.laps !== undefined ? { laps: p.laps } : {}),
    ...(p.pomodoro !== undefined ? { pomodoro: p.pomodoro as TimerRow["pomodoro"] } : {}),
    ...(p.completedAt !== undefined ? { completed_at: p.completedAt } : {}),
  };
}

/** Its end, as a delayed background run (if the worker is configured; reads settle otherwise). */
async function scheduleEnd(auth: AuthContext, t: Timer) {
  if (t.state !== "running" || !t.endsAt || t.kind === "stopwatch") return;
  if (!isBackgroundConfigured()) return;
  try {
    await new TriggerDevBackgroundRuntime().enqueue({
      type: "time.complete",
      payload: { workspaceId: auth.workspaceId, timerId: t.id, version: t.version },
      idempotencyKey: `timer:${t.id}:v${t.version}`,
      runAt: new Date(t.endsAt),
    });
  } catch (error) {
    // Never fails the change: the next read (any tab, any device) settles it.
    logger.warn("time.schedule_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
  }
}

export async function timePreferences(auth: AuthContext): Promise<TimePreferences> {
  const { data } = await auth.db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("key", "time")
    .maybeSingle();
  const raw = (data?.value_json ?? {}) as Partial<TimePreferences>;
  const parsed = timePreferencesSchema.safeParse({
    ...DEFAULT_TIME_PREFERENCES,
    ...raw,
    pomodoro: { ...DEFAULT_TIME_PREFERENCES.pomodoro, ...(raw.pomodoro ?? {}) },
  });
  return parsed.success ? parsed.data : DEFAULT_TIME_PREFERENCES;
}

export async function saveTimePreferences(
  auth: AuthContext,
  prefs: TimePreferences,
): Promise<TimePreferences> {
  const value = timePreferencesSchema.parse(prefs);
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: "time",
      value_json: value,
      source: "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not save time preferences", { cause: error });
  return value;
}

/** Writes `patch` only if the timer is still at `t.version`; null when it moved on. */
async function write(auth: AuthContext, t: Timer, patch: TimerPatch): Promise<Timer | null> {
  const { data, error } = await auth.db
    .from("timers")
    .update({ ...toColumns(patch), version: t.version + 1 })
    .eq("id", t.id)
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("version", t.version)
    .select("*")
    .maybeSingle();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not update the timer", { cause: error });
  return data ? toTimer(data) : null;
}

const audit = (auth: AuthContext, event: string, t: Timer, origin: "ai" | "user_ui" | "system") =>
  auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: event,
    resource_type: "timer",
    resource_id: t.id,
    origin,
    result: "success",
    metadata: { kind: t.kind, state: t.state, version: t.version },
  });

/**
 * Completes (or advances) an overdue timer, exactly once: the version guard picks one winner
 * among tabs, devices and the background run. The winner tells the user (one notification).
 */
export async function settleTimer(auth: AuthContext, t: Timer, now: Date): Promise<Timer> {
  const { patch, completion } = settle(t, now);
  if (!completion) return t;
  const next = await write(auth, t, patch);
  if (!next) return t;
  const prefs = await timePreferences(auth);
  const title = completionText(next, completion, auth.profile.locale);
  await Promise.all([
    auth.db.from("notifications").insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      notification_type: "time.completed",
      title,
      priority: "high",
      source_type: "timer",
      source_id: `${t.id}:${t.version}`,
      metadata: {
        timerId: t.id,
        at: completion.at,
        kind: completion.kind,
        sound: prefs.sound,
        browser: prefs.notify,
      },
    }),
    audit(auth, `timer.${completion.kind}`, next, "system"),
    scheduleEnd(auth, next),
  ]);
  logger.info("time.completed", {
    kind: completion.kind,
    late_ms: Math.max(0, now.getTime() - Date.parse(completion.at)),
  });
  return next;
}

export function timerStore(
  auth: AuthContext,
  origin: "ai" | "user_ui" | "system" = "ai",
): TimerStore {
  return {
    async list(opts = {}) {
      const since = new Date(Date.now() - RECENT_MS).toISOString();
      let q = auth.db
        .from("timers")
        .select("*")
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId);
      q = opts.includeFinished
        ? q.or(`state.in.(running,paused),updated_at.gte.${since}`)
        : q.in("state", ["running", "paused"]);
      const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_LIST);
      if (error) throw new AppError("INTERNAL_ERROR", "Could not load timers", { cause: error });
      const now = new Date();
      const settled = await Promise.all(
        (data ?? []).map((r) => settleTimer(auth, toTimer(r), now)),
      );
      return opts.includeFinished ? settled : settled.filter(isActive);
    },
    async create(n: NewTimer) {
      const now = new Date();
      const s = startState(n, now);
      const { data, error } = await auth.db
        .from("timers")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          kind: n.kind,
          label: n.label,
          state: s.state!,
          duration_ms: s.durationMs ?? 0,
          started_at: s.startedAt ?? null,
          ends_at: s.endsAt ?? null,
          elapsed_ms: 0,
          pomodoro: (s.pomodoro ?? null) as TimerRow["pomodoro"],
          created_from_conversation_id: n.provenance.conversationId ?? null,
          created_from_session_id: n.provenance.sessionId ?? null,
          created_from_schedule_id: n.provenance.scheduleId ?? null,
          created_from_space_id: n.provenance.spaceId ?? null,
        })
        .select("*")
        .single();
      if (error || !data)
        throw new AppError("INTERNAL_ERROR", "Could not start the timer", { cause: error });
      const t = toTimer(data);
      await Promise.all([audit(auth, "timer.created", t, origin), scheduleEnd(auth, t)]);
      logger.info("time.created", { kind: t.kind, duration_ms: t.durationMs });
      return t;
    },
    async change(t: Timer, patch: TimerPatch, event: string) {
      const next = await write(auth, t, patch);
      if (!next)
        throw new AppError("CONFLICT", "That timer just changed. Try again.", {
          recovery: "retry",
        });
      await Promise.all([audit(auth, event, next, origin), scheduleEnd(auth, next)]);
      return next;
    },
    preferences: () => timePreferences(auth),
  };
}

/** For the page: the user's timers (active and recent), as the Surfaces and mini timer show them. */
export async function timersForPage(
  auth: AuthContext,
): Promise<{ timers: TimerPayload[]; prefs: TimePreferences; serverNow: string }> {
  const [timers, prefs] = await Promise.all([
    timerStore(auth, "user_ui").list({ includeFinished: true }),
    timePreferences(auth),
  ]);
  const now = new Date();
  return {
    timers: timers.filter((t) => t.state !== "cancelled").map((t) => timerSnapshot(t, now)),
    prefs,
    serverNow: now.toISOString(),
  };
}

/**
 * The background run at a timer's end. Re-reads the canonical timer: a version that moved on
 * (paused, extended, cancelled, restarted) means this run is stale and does nothing.
 */
export async function completeTimerRun(
  payload: { workspaceId: string; timerId: string; version: number },
  authFor: (workspaceId: string, userId: string) => Promise<AuthContext>,
  db: AuthContext["db"],
): Promise<"completed" | "stale" | "early" | "gone"> {
  const { data } = await db
    .from("timers")
    .select("*")
    .eq("id", payload.timerId)
    .eq("workspace_id", payload.workspaceId)
    .maybeSingle();
  const t = data ? toTimer(data) : null;
  const now = new Date();
  const decision = endRunDecision(t, payload.version, now);
  if (decision !== "due") return decision;
  if (!t || !data) return "gone";
  const auth = await authFor(payload.workspaceId, data.user_id);
  const next = await settleTimer(auth, t, now);
  return next.version === t.version ? "stale" : "completed";
}
