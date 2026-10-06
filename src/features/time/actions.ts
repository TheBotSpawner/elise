"use server";

import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { runUserTool } from "@/application/elise";
import {
  saveTimePreferences,
  timePreferencesSchema,
  timersForPage,
} from "@/application/time-service";
import { toPublicError, type PublicError } from "@/core/errors";
import type { TimePreferences } from "@/core/timers/model";
import type { TimerPayload } from "@/core/workspace/time";

/**
 * The Time Surfaces' and mini timer's buttons (ADR-045): the same canonical tools ELISE uses,
 * with origin user_ui (validation, policy, audit).
 */

type Result<T> = ({ ok: true } & T) | { ok: false; error: PublicError };

export async function loadTimers(): Promise<
  Result<{ timers: TimerPayload[]; prefs: TimePreferences; serverNow: string }>
> {
  try {
    return { ok: true, ...(await timersForPage(await requireAuthContext())) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const call = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("control"),
    action: z.enum(["pause", "resume", "cancel", "reset", "lap", "skip"]),
    timer: z.uuid(),
  }),
  z.object({ tool: z.literal("addTime"), minutes: z.number().min(-60).max(60), timer: z.uuid() }),
]);

export async function timeAction(
  input: z.input<typeof call>,
): Promise<Result<{ timer: TimerPayload | null }>> {
  try {
    const { tool, ...args } = call.parse(input);
    const outcome = await runUserTool(await requireAuthContext(), `time.${tool}`, args);
    return { ok: true, timer: outcome.display?.kind === "timer" ? outcome.display.timer : null };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

export async function saveTimePrefs(
  prefs: TimePreferences,
): Promise<Result<{ prefs: TimePreferences }>> {
  try {
    const value = timePreferencesSchema.parse(prefs);
    return { ok: true, prefs: await saveTimePreferences(await requireAuthContext(), value) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
