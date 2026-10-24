"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { createExecutorPorts, toolContext } from "@/application/elise";
import { suggestWeatherCities, weatherCity } from "@/application/location-service";
import { marketsCapability } from "@/application/markets-service";
import {
  cancelActive,
  createSchedule,
  deleteSchedule,
  latestDailySummary,
  listRuns,
  markResultRead,
  runScheduleNow,
  setSchedulePaused,
  updateSchedule,
  type RunView,
} from "@/application/schedules-service";
import { executeToolCall } from "@/core/agents/executor";
import { AppError, toPublicError, type PublicError } from "@/core/errors";
import type { CitySuggestion } from "@/core/location/model";
import { weatherPlaceSchema, type WeatherPlace } from "@/core/schedules/schedule";

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

/**
 * The channels of one Slack workspace a brief can read (ADR-062): through the same executor path
 * as chat (that exact connection, its permissions, traced). Names and ids only.
 */
export async function slackChannelsAction(
  connectionId: string,
): Promise<ScheduleActionResult<{ id: string; name: string }[]>> {
  try {
    const auth = await requireAuthContext();
    const outcome = await executeToolCall(createExecutorPorts(auth), toolContext(auth, "user_ui"), {
      name: "teamMessaging.listChannels",
      args: { limit: 50 },
      connectionId: id.parse(connectionId),
    });
    if (outcome.status !== "succeeded")
      return {
        ok: false,
        error:
          outcome.status === "failed"
            ? outcome.error
            : toPublicError(new AppError("PERMISSION_DENIED", "Slack channels unavailable")),
      };
    const { channels } = outcome.output as { channels: { id: string; name: string }[] };
    return { ok: true, value: channels.map((c) => ({ id: c.id, name: c.name })) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

// ── Weather location (ADR-069) ───────────────────────────────────────────────

const token = z.uuid();

/** Assets for the Markets block, by name or ticker (server key; never exposed to the browser). */
export async function searchMarketsAction(query: string): Promise<
  ScheduleActionResult<
    {
      symbol: string;
      name: string;
      exchange: string | null;
      currency: string | null;
      type: "equity" | "etf" | "index" | "other";
    }[]
  >
> {
  try {
    const q = z.string().trim().min(1).max(60).parse(query);
    await requireAuthContext();
    const found = await marketsCapability().search(q);
    return {
      ok: true,
      value: found.slice(0, 6).map(({ symbol, name, exchange, currency, type }) => ({
        symbol,
        name: name.slice(0, 200),
        exchange,
        currency,
        type,
      })),
    };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** City-level suggestions while typing (server key; never exposed to the browser). */
export async function suggestWeatherCitiesAction(
  query: string,
  sessionToken: string,
): Promise<ScheduleActionResult<CitySuggestion[]>> {
  try {
    const q = z.string().trim().min(2).max(120).parse(query);
    return {
      ok: true,
      value: await suggestWeatherCities(await requireAuthContext(), q, token.parse(sessionToken)),
    };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** The chosen suggestion as a place a forecast can use: id, names, coordinates. */
export async function weatherCityAction(
  placeId: string,
  sessionToken: string,
): Promise<ScheduleActionResult<WeatherPlace>> {
  try {
    const place = await weatherCity(
      await requireAuthContext(),
      z.string().min(1).max(300).parse(placeId),
      token.parse(sessionToken),
    );
    if (!place) throw new AppError("NOT_FOUND", "That place has no location");
    return { ok: true, value: weatherPlaceSchema.parse(place) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** "ELISE, decime mi resumen del día": the newest one to open and play, or null. */
export async function latestDailySummaryAction(): Promise<ScheduleActionResult<string | null>> {
  return run(async () => latestDailySummary(await requireAuthContext()));
}
