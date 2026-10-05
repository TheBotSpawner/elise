import { addDays, toLocalDateTime } from "../time";

/**
 * Weather (ADR-038): current conditions and forecasts as structured data. Canonical and
 * vendor-free: the Core knows "Weather", never the forecast provider behind it. Weather is
 * never answered from web search snippets.
 */

export const WEATHER_CONDITIONS = [
  "clear",
  "mostly_clear",
  "partly_cloudy",
  "cloudy",
  "fog",
  "drizzle",
  "rain",
  "heavy_rain",
  "snow",
  "storm",
] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

/** WMO weather interpretation codes (the common standard forecast APIs report). */
export function conditionFromWmo(code: number): WeatherCondition {
  if (code === 0) return "clear";
  if (code === 1) return "mostly_clear";
  if (code === 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 65 || code === 82) return "heavy_rain";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 81)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

/** Wind worth mentioning (km/h, sustained). */
export const WINDY_KMH = 40;

export interface WeatherPlace {
  name: string;
  /** Region and country ("Buenos Aires, Argentina"). */
  detail: string | null;
  lat: number;
  lng: number;
}

export interface CurrentWeather {
  /** Local time at the place, "YYYY-MM-DDTHH:MM". */
  time: string;
  temperature: number;
  apparentTemperature: number | null;
  condition: WeatherCondition;
  isDay: boolean;
  humidity: number | null;
  windSpeed: number | null;
  precipitation: number | null;
}

export interface DailyWeather {
  date: string;
  condition: WeatherCondition;
  min: number;
  max: number;
  precipitationProbability: number | null;
  precipitationSum: number | null;
  windMax: number | null;
  sunrise: string | null;
  sunset: string | null;
}

export interface HourlyWeather {
  time: string;
  temperature: number;
  condition: WeatherCondition;
  precipitationProbability: number | null;
  windSpeed: number | null;
  isDay: boolean;
}

/** A forecast in the place's own timezone (every time is local there). */
export interface Forecast {
  timezone: string;
  current: CurrentWeather | null;
  daily: DailyWeather[];
  hourly: HourlyWeather[];
}

export interface WeatherProvider {
  readonly id: string;
  /** Display name for attribution ("Open-Meteo"). */
  readonly attribution: { name: string; url: string };
  geocode(name: string, language: string, signal?: AbortSignal): Promise<WeatherPlace[]>;
  forecast(at: { lat: number; lng: number }, days: number, signal?: AbortSignal): Promise<Forecast>;
}

/** Where the place of a request came from (user-named, shared position, timezone city…). */
export type WeatherLocationSource = "explicit" | "device" | "configured" | "timezone";

/** What tools see: the provider behind a timeout, a cache and telemetry. */
export interface WeatherCapability {
  readonly attribution: WeatherProvider["attribution"];
  geocode(name: string, language: string): Promise<WeatherPlace[]>;
  forecast(
    at: { lat: number; lng: number },
    days: number,
    source: WeatherLocationSource,
  ): Promise<Forecast>;
}

export const WEATHER_LIMITS = {
  timeoutMs: 8_000,
  cacheMs: 10 * 60_000,
  maxDays: 16,
  hours: 48,
} as const;

// ── Relative periods, resolved deterministically (never by the model) ────────

export const WEATHER_PERIODS = [
  "today",
  "this_morning",
  "this_afternoon",
  "tonight",
  "tomorrow",
  "tomorrow_morning",
  "tomorrow_afternoon",
  "tomorrow_night",
  "weekend",
  "this_week",
  "next_7_days",
  "next_week",
] as const;
export type WeatherPeriod = (typeof WEATHER_PERIODS)[number];

export interface ResolvedPeriod {
  /** Local date-times at the place, "YYYY-MM-DDTHH:MM", inclusive start, exclusive end. */
  from: string;
  to: string;
  /** Hours for a part of a day or one day; days for anything longer. */
  granularity: "hourly" | "daily";
}

const WINDOWS: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 19],
  night: [19, 24],
};

const at = (date: string, hour: number) =>
  hour >= 24 ? `${addDays(date, 1)}T00:00` : `${date}T${String(hour).padStart(2, "0")}:00`;

/** ISO weekday of a "YYYY-MM-DD" (1 = Monday … 7 = Sunday). */
function weekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * The local time range a relative period means, at the place. "esta semana" is the next seven
 * days (a forecast is about what's ahead); "semana que viene" is next Monday to Sunday.
 */
export function resolvePeriod(
  period: WeatherPeriod | { date: string },
  now: Date,
  timezone: string,
): ResolvedPeriod {
  const local = toLocalDateTime(now, timezone).slice(0, 16);
  const today = local.slice(0, 10);
  const hourNow = `${local.slice(0, 13)}:00`;
  const tomorrow = addDays(today, 1);
  const part = (date: string, w: keyof typeof WINDOWS, clampNow: boolean): ResolvedPeriod => {
    const [a, b] = WINDOWS[w]!;
    const from = at(date, a);
    return {
      from: clampNow && hourNow > from ? hourNow : from,
      to: at(date, b),
      granularity: "hourly",
    };
  };
  const days = (from: string, n: number): ResolvedPeriod => ({
    from: `${from}T00:00`,
    to: `${addDays(from, n)}T00:00`,
    granularity: "daily",
  });
  if (typeof period === "object") return { ...days(period.date, 1), granularity: "hourly" };
  switch (period) {
    case "today":
      return { from: hourNow, to: at(today, 24), granularity: "hourly" };
    case "this_morning":
      return part(today, "morning", true);
    case "this_afternoon":
      return part(today, "afternoon", true);
    case "tonight":
      return part(today, "night", true);
    case "tomorrow":
      return { from: at(tomorrow, 6), to: at(tomorrow, 24), granularity: "hourly" };
    case "tomorrow_morning":
      return part(tomorrow, "morning", false);
    case "tomorrow_afternoon":
      return part(tomorrow, "afternoon", false);
    case "tomorrow_night":
      return part(tomorrow, "night", false);
    case "weekend": {
      const wd = weekday(today);
      // Saturday or Sunday: what's left of it; otherwise the coming Saturday and Sunday.
      if (wd === 7) return days(today, 1);
      if (wd === 6) return days(today, 2);
      return days(addDays(today, 6 - wd), 2);
    }
    case "this_week":
    case "next_7_days":
      return days(today, 7);
    case "next_week":
      return days(addDays(today, 8 - weekday(today)), 7);
  }
}

/** Forecast days to request so the period is covered (today included). */
export function daysNeeded(p: ResolvedPeriod, today: string): number {
  const last = p.to.slice(0, 10);
  const span = Math.round(
    (Date.parse(`${last}T00:00Z`) - Date.parse(`${today}T00:00Z`)) / 86_400_000,
  );
  return Math.min(WEATHER_LIMITS.maxDays, Math.max(1, span + 1));
}

/**
 * A coarse city implied by an IANA timezone ("America/Argentina/Buenos_Aires" → "Buenos
 * Aires"). Used only when the user named no place and shared no position; never precise.
 */
export function cityFromTimezone(timezone: string): string | null {
  if (!timezone.includes("/") || /^(Etc|UTC|GMT)/i.test(timezone)) return null;
  const city = timezone.split("/").pop()!.replace(/_/g, " ").trim();
  return city.length >= 2 ? city : null;
}
