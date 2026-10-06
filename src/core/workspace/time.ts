import { z } from "zod";

import { AUTO_START, TIME_LIMITS, TIMER_KINDS, TIMER_STATES, type Timer } from "../timers/model";

/**
 * Time Surfaces (ADR-045). A timer's Surface is a view over the canonical timer — one per timer
 * (`timer:<id>`), updated in place on every change, never duplicated. The page counts down from
 * the timestamps and follows the live timer, so a stale snapshot never shows the wrong time.
 */

const text = (max: number) => z.string().max(max);
const ms = z
  .number()
  .int()
  .min(0)
  .max(7 * 24 * 3_600_000);

export const timerPayload = z
  .object({
    id: text(64),
    kind: z.enum(TIMER_KINDS),
    label: text(TIME_LIMITS.maxLabel).nullable(),
    state: z.enum(TIMER_STATES),
    durationMs: ms,
    startedAt: text(40).nullable(),
    endsAt: text(40).nullable(),
    remainingMs: ms.nullable(),
    elapsedMs: ms,
    laps: z.array(ms).max(TIME_LIMITS.maxLaps),
    pomodoro: z
      .object({
        focusMs: ms,
        shortBreakMs: ms,
        longBreakMs: ms,
        cycles: z.number().int().min(1).max(12),
        autoStart: z.enum(AUTO_START),
        phaseIndex: z.number().int().min(0).max(40),
      })
      .strict()
      .nullable(),
    version: z.number().int().min(0),
    completedAt: text(40).nullable(),
    createdAt: text(40),
    updatedAt: text(40),
    /** The server's clock when this was read: the page corrects its own clock by it. */
    serverNow: text(40),
  })
  .strict();

export type TimerPayload = z.infer<typeof timerPayload>;

export const clockPayload = z
  .object({
    timezone: text(64),
    /** The place as the user named it ("Auckland"); null for their own time. */
    place: text(80).nullable(),
    hour12: z.boolean(),
  })
  .strict();

export type ClockPayload = z.infer<typeof clockPayload>;

/** The Surface payload for a timer (provenance stays server-side). */
export function timerSnapshot(t: Timer, now: Date): TimerPayload {
  return {
    id: t.id,
    kind: t.kind,
    label: t.label,
    state: t.state,
    durationMs: t.durationMs,
    startedAt: t.startedAt,
    endsAt: t.endsAt,
    remainingMs: t.remainingMs,
    elapsedMs: t.elapsedMs,
    laps: t.laps,
    pomodoro: t.pomodoro,
    version: t.version,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    serverNow: now.toISOString(),
  };
}

/** Back to the model's shape (for computing time from a payload in the page). */
export function timerFromPayload(p: TimerPayload): Timer {
  const t: Partial<TimerPayload> = { ...p };
  delete t.serverNow;
  return { ...(t as Omit<TimerPayload, "serverNow">), provenance: {} };
}
