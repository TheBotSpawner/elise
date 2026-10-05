import { z } from "zod";

import { WEATHER_CONDITIONS, WEATHER_LIMITS } from "../weather/model";

/**
 * The Weather Surface (ADR-038): current conditions, hours or days at one place. Typed numbers
 * and names only — never coordinates (a device position stays out of every payload), markup or
 * provider icon URLs; the UI owns the iconography and the chart.
 */

const text = (max: number) => z.string().trim().max(max);
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const condition = z.enum(WEATHER_CONDITIONS);
const temp = z.number().min(-90).max(70);
const pct = z.number().min(0).max(100).nullable();
const amount = z.number().min(0).max(2000).nullable();

export const WEATHER_MODES = ["current", "hourly", "daily", "needs_location"] as const;

/** Where the place came from, so the UI and the model can say "assumed from your timezone". */
export const WEATHER_LOCATION_SOURCES = ["explicit", "device", "configured", "timezone"] as const;

export const weatherPayload = z
  .object({
    mode: z.enum(WEATHER_MODES),
    location: z
      .object({
        name: text(120),
        detail: text(160).nullable(),
        source: z.enum(WEATHER_LOCATION_SOURCES),
      })
      .strict()
      .nullable(),
    /** The place's timezone: every time below is local there. */
    timezone: text(64),
    /** The asked range, for focusing the hours ("esta tarde"). */
    period: z.object({ from: localTime, to: localTime }).strict().nullable(),
    current: z
      .object({
        time: localTime,
        temperature: temp,
        apparentTemperature: temp.nullable(),
        condition,
        isDay: z.boolean(),
        humidity: pct,
        windSpeed: amount,
        precipitation: amount,
      })
      .strict()
      .nullable(),
    days: z
      .array(
        z
          .object({
            date,
            condition,
            min: temp,
            max: temp,
            precipitationProbability: pct,
            precipitationSum: amount,
            windMax: amount,
            sunrise: localTime.nullable(),
            sunset: localTime.nullable(),
          })
          .strict(),
      )
      .max(WEATHER_LIMITS.maxDays),
    hours: z
      .array(
        z
          .object({
            time: localTime,
            temperature: temp,
            condition,
            precipitationProbability: pct,
            windSpeed: amount,
            isDay: z.boolean(),
          })
          .strict(),
      )
      .max(WEATHER_LIMITS.hours),
    /** Data credit the provider's licence requires (CC BY 4.0 for Open-Meteo). */
    attribution: z
      .object({
        name: text(60),
        url: z
          .string()
          .max(200)
          .refine((u) => u.startsWith("https://"), "https only"),
      })
      .strict(),
  })
  .strict();

export type WeatherPayload = z.infer<typeof weatherPayload>;
