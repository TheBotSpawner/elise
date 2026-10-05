import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { coarse } from "../location/model";
import { clipText as clip } from "../text";
import { toLocalDateTime } from "../time";
import {
  cityFromTimezone,
  daysNeeded,
  resolvePeriod,
  WEATHER_LIMITS,
  WEATHER_PERIODS,
  WINDY_KMH,
  type Forecast,
  type WeatherCapability,
  type WeatherPeriod,
} from "../weather/model";
import type { WeatherPayload } from "../workspace/weather";

/**
 * Weather tools (ADR-038): structured forecasts, never web search. Named by capability, read-only.
 * The place comes from, in order: what the user named, the position they shared, the brief's
 * configured place, and the city of their timezone (said as an assumption). ELISE asks only when
 * none of those exists, and never puts a device position in a payload or the model's input.
 */

function weather(env: ToolRunEnv): WeatherCapability {
  return env.providers.get("weather", env.binding);
}

const HERE = "here";
const locationField = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .optional()
  .describe(
    'A city or place the user named ("Córdoba", "Madrid, España"), or "here". Omit when they named none: ELISE uses their shared position or their usual city.',
  );

type Resolved =
  | {
      at: { lat: number; lng: number };
      location: NonNullable<WeatherPayload["location"]>;
    }
  | { missing: true; query: string | null };

async function resolvePlace(env: ToolRunEnv, named: string | undefined): Promise<Resolved> {
  const lang = env.ctx.locale;
  const wantsHere = !named || named.toLowerCase() === HERE;
  if (wantsHere && env.ctx.here) {
    return {
      at: coarse(env.ctx.here),
      location: {
        name: lang === "es" ? "Tu ubicación" : "Your location",
        detail: null,
        source: "device",
      },
    };
  }
  const query = wantsHere ? null : named!;
  // Named place first; with none, the city of the user's timezone (coarse, said as assumed).
  // An explicit "here" without a shared position asks instead of assuming.
  const text = query ?? (named ? null : cityFromTimezone(env.ctx.timezone));
  if (!text) return { missing: true, query };
  const [first] = await weather(env).geocode(text, lang);
  if (!first) return { missing: true, query };
  return {
    at: { lat: first.lat, lng: first.lng },
    location: {
      name: clip(first.name, 120),
      detail: first.detail ? clip(first.detail, 160) : null,
      source: query ? "explicit" : "timezone",
    },
  };
}

function needsLocation(env: ToolRunEnv, query: string | null) {
  const payload: WeatherPayload = {
    mode: "needs_location",
    location: null,
    timezone: env.ctx.timezone,
    period: null,
    current: null,
    days: [],
    hours: [],
    attribution: weather(env).attribution,
  };
  return {
    output: {
      found: false,
      instructions: query
        ? `No place called "${clip(query, 80)}" was found. Ask which city they mean (with its country).`
        : "ELISE doesn't know where the user is. Ask which city, or to share their location with the button on screen. Never guess.",
    },
    ...(query ? {} : { display: { kind: "weather" as const, weather: payload } }),
  };
}

const round = (n: number | null) => (n == null ? null : Math.round(n));

function payload(
  mode: WeatherPayload["mode"],
  f: Forecast,
  location: NonNullable<WeatherPayload["location"]>,
  period: WeatherPayload["period"],
  env: ToolRunEnv,
  filter: { days: (d: string) => boolean; hours: (t: string) => boolean },
): WeatherPayload {
  return {
    mode,
    location,
    timezone: f.timezone,
    period,
    current: f.current,
    days: f.daily.filter((d) => filter.days(d.date)).slice(0, WEATHER_LIMITS.maxDays),
    hours: f.hourly.filter((h) => filter.hours(h.time)).slice(0, WEATHER_LIMITS.hours),
    attribution: weather(env).attribution,
  };
}

/** What the model needs to answer briefly; it never computes extremes itself. */
function highlights(p: WeatherPayload) {
  const days = p.days;
  const wettest = days.reduce<(typeof days)[number] | null>(
    (best, d) =>
      (d.precipitationProbability ?? 0) > (best?.precipitationProbability ?? -1) ? d : best,
    null,
  );
  const hours = p.hours;
  const rainiest = hours.reduce<(typeof hours)[number] | null>(
    (best, h) =>
      (h.precipitationProbability ?? 0) > (best?.precipitationProbability ?? -1) ? h : best,
    null,
  );
  const temps = hours.map((h) => h.temperature);
  return {
    ...(days.length > 1
      ? {
          range: {
            min: Math.min(...days.map((d) => d.min)),
            max: Math.max(...days.map((d) => d.max)),
          },
          warmestDay: days.reduce((a, b) => (b.max > a.max ? b : a)).date,
          coldestDay: days.reduce((a, b) => (b.min < a.min ? b : a)).date,
          ...(wettest && (wettest.precipitationProbability ?? 0) >= 30
            ? { rainiestDay: { date: wettest.date, chance: wettest.precipitationProbability } }
            : { rain: "unlikely on every day" }),
        }
      : {}),
    ...(hours.length
      ? {
          hoursRange: { min: Math.min(...temps), max: Math.max(...temps) },
          ...(rainiest && (rainiest.precipitationProbability ?? 0) >= 30
            ? {
                rainPeak: {
                  at: rainiest.time.slice(11),
                  chance: rainiest.precipitationProbability,
                },
              }
            : { rain: "unlikely in these hours" }),
          ...(hours.some((h) => (h.windSpeed ?? 0) >= WINDY_KMH) ? { windy: true } : {}),
        }
      : {}),
  };
}

const VOICE_SHORT =
  "The full forecast is on screen: answer in one or two short sentences (the overall feel and what matters — rain chance and when, the warmest or coldest, strong wind). Don't read every day or hour, and give temperatures as whole degrees °C.";

function placeNote(location: NonNullable<WeatherPayload["location"]>) {
  return location.source === "timezone"
    ? ` The place was assumed from the user's timezone (${location.name}): name it briefly so they can correct it.`
    : "";
}

// ── Current conditions ───────────────────────────────────────────────────────

const currentInput = z.object({ location: locationField }).strict();

export const currentWeatherTool: ToolDefinition = {
  name: "weather.current",
  capability: "weather",
  operation: "current",
  description:
    '"¿Cómo está el clima?", "¿hace frío?", "what\'s the weather": current conditions plus today\'s min/max and rain chance, shown as a weather card. Never use web search for weather.',
  input: currentInput,
  async describe() {
    return { summary: "Check the weather" };
  },
  async run(raw, env) {
    const q = currentInput.parse(raw);
    const place = await resolvePlace(env, q.location);
    if ("missing" in place) return needsLocation(env, place.query);
    const f = await weather(env).forecast(place.at, 2, place.location.source);
    const nowLocal = toLocalDateTime(env.ctx.now, f.timezone).slice(0, 13);
    const today = nowLocal.slice(0, 10);
    const p = payload("current", f, place.location, null, env, {
      days: (d) => d === today,
      hours: (t) => t.slice(0, 13) >= nowLocal,
    });
    p.hours = p.hours.slice(0, 12);
    const day = p.days[0];
    return {
      output: {
        found: true,
        place: [p.location?.name, p.location?.detail].filter(Boolean).join(", "),
        now: p.current && {
          temperature: round(p.current.temperature),
          feelsLike: round(p.current.apparentTemperature),
          condition: p.current.condition,
          humidity: p.current.humidity,
          windKmh: round(p.current.windSpeed),
        },
        today: day && {
          min: round(day.min),
          max: round(day.max),
          rainChance: day.precipitationProbability,
        },
        ...highlights({ ...p, days: [] }),
        instructions: `${VOICE_SHORT}${placeNote(place.location)}`,
      },
      display: { kind: "weather", weather: p },
    };
  },
};

// ── Forecast (hours for part of a day, days for longer) ──────────────────────

const forecastInput = z
  .object({
    location: locationField,
    when: z
      .enum(WEATHER_PERIODS)
      .default("next_7_days")
      .describe(
        "hoy → today; esta mañana/tarde/noche → this_morning/this_afternoon/tonight; mañana → tomorrow (a la tarde → tomorrow_afternoon…); fin de semana → weekend; esta semana / próximos días → this_week; semana que viene → next_week.",
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("A specific day (YYYY-MM-DD) instead of `when`, within the next 15 days."),
  })
  .strict();

export const forecastWeatherTool: ToolDefinition = {
  name: "weather.forecast",
  capability: "weather",
  operation: "forecast",
  description:
    '"Pronóstico de esta semana", "¿va a llover mañana a la tarde?", "¿cómo va a estar el finde?": the forecast by hour (part of a day, one day) or by day (weekend, week), shown graphically. Dates are resolved by ELISE from `when`; never compute them yourself. Never use web search for weather.',
  input: forecastInput,
  async describe() {
    return { summary: "Check the forecast" };
  },
  async run(raw, env) {
    const q = forecastInput.parse(raw);
    const period: WeatherPeriod | { date: string } = q.date ? { date: q.date } : q.when;
    const place = await resolvePlace(env, q.location);
    if ("missing" in place) return needsLocation(env, place.query);
    // Days to fetch, from the user's clock (+1 for a place a day ahead); the range itself is
    // resolved again in the place's own timezone once the forecast says which one it is.
    const userToday = toLocalDateTime(env.ctx.now, env.ctx.timezone).slice(0, 10);
    const rough = resolvePeriod(period, env.ctx.now, env.ctx.timezone);
    const want = Math.min(WEATHER_LIMITS.maxDays, daysNeeded(rough, userToday) + 1);
    const f = await weather(env).forecast(place.at, want, place.location.source);
    const range = resolvePeriod(period, env.ctx.now, f.timezone);
    const today = toLocalDateTime(env.ctx.now, f.timezone).slice(0, 10);
    if (range.from.slice(0, 10) > (f.daily.at(-1)?.date ?? today))
      return {
        output: {
          found: false,
          instructions:
            "That day is beyond the forecast range (about two weeks). Say so; don't estimate.",
        },
      };
    const fromDay = range.from.slice(0, 10);
    const p = payload(
      range.granularity,
      f,
      place.location,
      { from: range.from, to: range.to },
      env,
      {
        days: (d) => d >= fromDay && `${d}T00:00` < range.to,
        hours: (t) => range.granularity === "hourly" && t >= range.from && t < range.to,
      },
    );
    return {
      output: {
        found: true,
        place: [p.location?.name, p.location?.detail].filter(Boolean).join(", "),
        from: range.from,
        to: range.to,
        days: p.days.map((d) => ({
          date: d.date,
          condition: d.condition,
          min: round(d.min),
          max: round(d.max),
          rainChance: d.precipitationProbability,
          ...(d.precipitationSum ? { rainMm: d.precipitationSum } : {}),
          ...((d.windMax ?? 0) >= WINDY_KMH ? { windKmh: round(d.windMax) } : {}),
        })),
        ...(p.hours.length
          ? {
              hours: p.hours.map((h) => ({
                at: h.time.slice(11),
                t: round(h.temperature),
                c: h.condition,
                rain: h.precipitationProbability,
              })),
            }
          : {}),
        ...highlights(p),
        instructions: `${VOICE_SHORT}${placeNote(place.location)}`,
      },
      display: { kind: "weather", weather: p },
    };
  },
};

export const WEATHER_TOOLS = [currentWeatherTool, forecastWeatherTool];
