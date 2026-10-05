import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { selectTools } from "@/core/agents/tool-selection";
import type { ProviderFactory } from "@/core/agents/tools";
import { AppError } from "@/core/errors";
import { predictIntent, ackIntent } from "@/core/voice/speech-plan";
import {
  cityFromTimezone,
  conditionFromWmo,
  resolvePeriod,
  type Forecast,
  type WeatherCapability,
} from "@/core/weather/model";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { PAYLOADS } from "@/core/workspace/registry";
import { parseForecast } from "@/infrastructure/weather/open-meteo";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const TZ = "America/Argentina/Buenos_Aires";
// Monday 2026-10-05, 10:30 in Buenos Aires (UTC-3).
const NOW = new Date("2026-10-05T13:30:00Z");

/** A 16-day forecast for Buenos Aires: hours every hour, rain on Wednesday and tomorrow at 17. */
function forecast(): Forecast {
  const days = Array.from({ length: 16 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 5 + i)).toISOString().slice(0, 10);
    return {
      date,
      condition: i === 2 ? ("rain" as const) : ("clear" as const),
      min: 12 + (i % 3),
      max: 22 + (i % 4),
      precipitationProbability: i === 2 ? 80 : 10,
      precipitationSum: i === 2 ? 6 : 0,
      windMax: 15,
      sunrise: `${date}T07:05`,
      sunset: `${date}T19:40`,
    };
  });
  const hourly = days.flatMap((d) =>
    Array.from({ length: 24 }, (_, h) => ({
      time: `${d.date}T${String(h).padStart(2, "0")}:00`,
      temperature: 14 + (h > 6 && h < 18 ? h - 6 : 0),
      condition: "cloudy" as const,
      precipitationProbability: d.date === "2026-10-06" && h === 17 ? 70 : 5,
      windSpeed: 10,
      isDay: h >= 7 && h < 20,
    })),
  );
  return {
    timezone: TZ,
    current: {
      time: "2026-10-05T10:30",
      temperature: 18.4,
      apparentTemperature: 17.1,
      condition: "partly_cloudy",
      isDay: true,
      humidity: 60,
      windSpeed: 12,
      precipitation: 0,
    },
    daily: days,
    hourly,
  };
}

function fakeWeather(over: Partial<WeatherCapability> = {}) {
  const calls: { op: string; arg: unknown }[] = [];
  const weather: WeatherCapability = {
    attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
    geocode: async (name) => {
      calls.push({ op: "geocode", arg: name });
      if (/nowhere/i.test(name)) return [];
      return [{ name: name.split(",")[0]!, detail: "Argentina", lat: -34.6, lng: -58.38 }];
    },
    forecast: async (at, days, source) => {
      calls.push({ op: "forecast", arg: { at, days, source } });
      return forecast();
    },
    ...over,
  };
  return { weather, calls };
}

function setup(weather: WeatherCapability, over: Parameters<typeof makeCtx>[0] = {}) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "weather" ? weather : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW, ...over }) };
}

async function run(...args: Parameters<typeof executeToolCall>) {
  const out = await executeToolCall(...args);
  if (out.status !== "succeeded") throw new Error(`${out.status}: ${JSON.stringify(out)}`);
  return out;
}

describe("weather model", () => {
  it("maps WMO codes to ELISE's conditions", () => {
    expect(conditionFromWmo(0)).toBe("clear");
    expect(conditionFromWmo(2)).toBe("partly_cloudy");
    expect(conditionFromWmo(45)).toBe("fog");
    expect(conditionFromWmo(53)).toBe("drizzle");
    expect(conditionFromWmo(63)).toBe("rain");
    expect(conditionFromWmo(65)).toBe("heavy_rain");
    expect(conditionFromWmo(75)).toBe("snow");
    expect(conditionFromWmo(95)).toBe("storm");
  });

  it("resolves relative periods in the place's timezone, deterministically", () => {
    expect(resolvePeriod("today", NOW, TZ)).toEqual({
      from: "2026-10-05T10:00",
      to: "2026-10-06T00:00",
      granularity: "hourly",
    });
    expect(resolvePeriod("this_afternoon", NOW, TZ)).toMatchObject({
      from: "2026-10-05T12:00",
      to: "2026-10-05T19:00",
    });
    expect(resolvePeriod("tomorrow_afternoon", NOW, TZ)).toMatchObject({
      from: "2026-10-06T12:00",
      to: "2026-10-06T19:00",
      granularity: "hourly",
    });
    expect(resolvePeriod("tonight", NOW, TZ)).toMatchObject({ to: "2026-10-06T00:00" });
    // Monday → the coming Saturday and Sunday; "esta semana" → the next seven days.
    expect(resolvePeriod("weekend", NOW, TZ)).toEqual({
      from: "2026-10-10T00:00",
      to: "2026-10-12T00:00",
      granularity: "daily",
    });
    expect(resolvePeriod("this_week", NOW, TZ)).toMatchObject({
      from: "2026-10-05T00:00",
      to: "2026-10-12T00:00",
    });
    expect(resolvePeriod("next_week", NOW, TZ)).toMatchObject({
      from: "2026-10-12T00:00",
      to: "2026-10-19T00:00",
    });
    // Late Sunday evening in Buenos Aires is already Monday in UTC: the user's day wins.
    const sundayNight = new Date("2026-10-12T02:00:00Z");
    expect(resolvePeriod("weekend", sundayNight, TZ).from).toBe("2026-10-11T00:00");
  });

  it("derives a coarse city from the timezone, never from UTC", () => {
    expect(cityFromTimezone(TZ)).toBe("Buenos Aires");
    expect(cityFromTimezone("Europe/Madrid")).toBe("Madrid");
    expect(cityFromTimezone("UTC")).toBeNull();
    expect(cityFromTimezone("Etc/GMT+3")).toBeNull();
  });

  it("parses the provider's JSON and drops rows without temperatures", () => {
    const f = parseForecast({
      timezone: TZ,
      current: { time: "2026-10-05T10:30", temperature_2m: 18, weather_code: 3, is_day: 1 },
      hourly: {
        time: ["2026-10-05T10:00", "2026-10-05T11:00"],
        temperature_2m: [18, null],
        weather_code: [61, 61],
        precipitation_probability: [140, 20],
      },
      daily: {
        time: ["2026-10-05"],
        temperature_2m_max: [24],
        temperature_2m_min: [14],
        weather_code: [95],
        precipitation_probability_max: [55],
      },
    });
    expect(f.current?.condition).toBe("cloudy");
    expect(f.hourly).toHaveLength(1);
    expect(f.hourly[0]).toMatchObject({ condition: "rain", precipitationProbability: 100 });
    expect(f.daily[0]).toMatchObject({ condition: "storm", min: 14, max: 24 });
  });
});

describe("weather tools", () => {
  it("current weather for a named city: structured, on a Weather Surface", async () => {
    const { weather, calls } = fakeWeather();
    const { ports, ctx } = setup(weather);
    const out = await run(ports, ctx, { name: "weather.current", args: { location: "Córdoba" } });
    expect(calls[0]).toEqual({ op: "geocode", arg: "Córdoba" });
    const o = out.output as { now: { temperature: number }; today: { min: number; max: number } };
    expect(o.now.temperature).toBe(18);
    expect(o.today).toEqual({ min: 12, max: 22, rainChance: 10 });
    expect(out.display?.kind).toBe("weather");
    const [surface] = surfacesFromOutcome("weather.current", out, { key: "k" });
    expect(surface?.type).toBe("weather");
    expect(PAYLOADS.weather.safeParse(surface!.payload).success).toBe(true);
  });

  it("uses the shared device position without geocoding, and never exposes it", async () => {
    const { weather, calls } = fakeWeather();
    const here = { lat: -34.60123456, lng: -58.38345678 };
    const { ports, ctx } = setup(weather, { here });
    const out = await run(ports, ctx, { name: "weather.current", args: {} });
    expect(calls.some((c) => c.op === "geocode")).toBe(false);
    const fc = calls.find((c) => c.op === "forecast")!.arg as { at: unknown; source: string };
    expect(fc.at).toEqual({ lat: -34.601, lng: -58.383 });
    expect(fc.source).toBe("device");
    expect(JSON.stringify(out)).not.toContain("34.601");
  });

  it("no place and no position: the timezone's city, said as an assumption — no question", async () => {
    const { weather, calls } = fakeWeather();
    const { ports, ctx } = setup(weather);
    const out = await run(ports, ctx, { name: "weather.forecast", args: { when: "this_week" } });
    expect(calls[0]).toEqual({ op: "geocode", arg: "Buenos Aires" });
    expect((out.output as { instructions: string }).instructions).toMatch(/assumed/);
    if (out.display?.kind !== "weather") throw new Error("no weather");
    expect(out.display.weather.location?.source).toBe("timezone");
  });

  it("asks only when nothing is known (UTC timezone, no position)", async () => {
    const { weather } = fakeWeather();
    const { ports, ctx } = setup(weather, { timezone: "UTC" });
    const out = await run(ports, ctx, { name: "weather.current", args: {} });
    expect((out.output as { found: boolean }).found).toBe(false);
    expect(out.display?.kind === "weather" && out.display.weather.mode).toBe("needs_location");
  });

  it("an unknown city asks which one instead of guessing", async () => {
    const { weather } = fakeWeather();
    const { ports, ctx } = setup(weather);
    const out = await run(ports, ctx, { name: "weather.current", args: { location: "Nowhere" } });
    expect((out.output as { instructions: string }).instructions).toMatch(/Nowhere/);
    expect(out.display).toBeUndefined();
  });

  it("weekly forecast: seven days, with the rainiest and warmest computed for the model", async () => {
    const { weather } = fakeWeather();
    const { ports, ctx } = setup(weather);
    const out = await run(ports, ctx, {
      name: "weather.forecast",
      args: { location: "Buenos Aires", when: "this_week" },
    });
    const o = out.output as { days: { date: string }[]; rainiestDay: { date: string } };
    expect(o.days.map((d) => d.date)).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    expect(o.rainiestDay.date).toBe("2026-10-07");
    if (out.display?.kind !== "weather") throw new Error("no weather");
    expect(out.display.weather.mode).toBe("daily");
    expect(out.display.weather.hours).toEqual([]);
  });

  it("'¿va a llover mañana a la tarde?': the hours of that window and when rain peaks", async () => {
    const { weather } = fakeWeather();
    const { ports, ctx } = setup(weather);
    const out = await run(ports, ctx, {
      name: "weather.forecast",
      args: { when: "tomorrow_afternoon" },
    });
    if (out.display?.kind !== "weather") throw new Error("no weather");
    const w = out.display.weather;
    expect(w.mode).toBe("hourly");
    expect(w.hours[0]?.time).toBe("2026-10-06T12:00");
    expect(w.hours.at(-1)?.time).toBe("2026-10-06T18:00");
    expect(w.period).toEqual({ from: "2026-10-06T12:00", to: "2026-10-06T19:00" });
    expect((out.output as { rainPeak: unknown }).rainPeak).toEqual({ at: "17:00", chance: 70 });
  });

  it("a provider failure is reported as such — never as a web answer", async () => {
    const { weather } = fakeWeather({
      forecast: async () => {
        throw new AppError("PROVIDER_UNAVAILABLE", "The weather service didn't answer");
      },
    });
    const { ports, ctx } = setup(weather);
    const out = await executeToolCall(ports, ctx, {
      name: "weather.current",
      args: { location: "Rosario" },
    });
    expect(out.status === "failed" && out.error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("information routing", () => {
  const { ports } = makePorts([]);
  const all = ports.registry.available(new Set());

  it("weather tools are always offered; weather words no longer pull in web search", () => {
    const sel = selectTools(all, { message: "¿Cómo va a estar esta semana?" });
    expect(sel.tools.some((t) => t.name === "weather.forecast")).toBe(true);
    const clima = selectTools(all, { message: "¿cómo está el clima hoy?" });
    expect(clima.groups).not.toContain("web");
    expect(clima.tools.some((t) => t.name === "weather.current")).toBe(true);
  });

  it("other sources keep their own groups", () => {
    const groups = (m: string) => selectTools(all, { message: m }).groups;
    expect(groups("¿cuánto tardo hasta el MALBA?")).toContain("location");
    expect(groups("buscame noticias de OpenAI")).toContain("web");
    expect(groups("qué tengo en mi agenda")).toContain("calendar");
    expect(groups("buscá en mis documentos")).toContain("knowledge");
    expect(groups("lo que hablamos ayer")).toContain("history");
  });

  it("voice acknowledges weather as weather, before the tool and when it starts", () => {
    expect(predictIntent("buscame el pronóstico de esta semana")).toBe("check_weather");
    expect(predictIntent("¿va a llover mañana a la tarde?")).toBe("check_weather");
    expect(ackIntent("weather.forecast")).toBe("check_weather");
  });
});
