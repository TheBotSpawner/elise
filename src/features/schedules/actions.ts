"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  cancelActive,
  createSchedule,
  deleteSchedule,
  listRuns,
  markResultRead,
  runScheduleNow,
  setSchedulePaused,
  updateSchedule,
  type RunView,
} from "@/application/schedules-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type ScheduleActionResult<T = undefined> =
  { ok: true; value: T } | { ok: false; error: PublicError };

const id = z.uuid();

async function run<T>(fn: () => Promise<T>): Promise<ScheduleActionResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/schedules");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Inputs are validated by the service's schema; nothing from the client is trusted as-is. */
export async function createScheduleAction(input: unknown) {
  return run(async () => createSchedule(await requireAuthContext(), input));
}

export async function updateScheduleAction(scheduleId: string, input: unknown) {
  return run(async () => updateSchedule(await requireAuthContext(), id.parse(scheduleId), input));
}

export async function pauseScheduleAction(scheduleId: string, paused: boolean) {
  return run(async () =>
    setSchedulePaused(await requireAuthContext(), id.parse(scheduleId), z.boolean().parse(paused)),
  );
}

export async function deleteScheduleAction(scheduleId: string) {
  return run(async () => deleteSchedule(await requireAuthContext(), id.parse(scheduleId)));
}

export async function runNowAction(scheduleId: string) {
  return run(async () => runScheduleNow(await requireAuthContext(), id.parse(scheduleId)));
}

export async function cancelRunAction(scheduleId: string) {
  return run(async () => cancelActive(await requireAuthContext(), id.parse(scheduleId)));
}

export async function historyAction(scheduleId: string): Promise<ScheduleActionResult<RunView[]>> {
  try {
    return { ok: true, value: await listRuns(await requireAuthContext(), id.parse(scheduleId)) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

export async function markResultReadAction(resultId: string) {
  try {
    await markResultRead(await requireAuthContext(), id.parse(resultId));
    revalidatePath("/");
  } catch {
    // Read state is a convenience; never block viewing the brief.
  }
}
