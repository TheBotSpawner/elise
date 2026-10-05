import "server-only";

import { AppError } from "@/core/errors";
import {
  conditionFromWmo,
  type Forecast,
  type WeatherPlace,
  type WeatherProvider,
} from "@/core/weather/model";

/**
 * Open-Meteo (ADR-038): forecasts from national weather services, no key for non-commercial use.
 * With OPEN_METEO_API_KEY the forecast goes to the commercial customer endpoint, as its terms
 * require for commercial use. Data is CC BY 4.0: the Surface credits it.
 */

const FREE = "https://api.open-meteo.com/v1/forecast";
const CUSTOMER = "https://customer-api.open-meteo.com/v1/forecast";
// ponytail: geocoding stays on the public host; switch it too once a commercial plan documents one.
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

const CURRENT = [
  "temperature_2m",
  "apparent_temperature",
  "weather_code",
  "is_day",
  "relative_humidity_2m",
  "wind_speed_10m",
  "precipitation",
];
const HOURLY = [
  "temperature_2m",
  "precipitation_probability",
  "weather_code",
  "wind_speed_10m",
  "is_day",
];
const DAILY = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "wind_speed_10m_max",
  "sunrise",
  "sunset",
];

type Series = Record<string, (number | string | null)[] | undefined>;
interface ForecastResponse {
  timezone?: string;
  current?: Record<string, number | string | null>;
  hourly?: Series & { time?: string[] };
  daily?: Series & { time?: string[] };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 16) : null);
const pct = (v: unknown) => {
  const n = num(v);
  return n == null ? null : Math.max(0, Math.min(100, Math.round(n)));
};

export class OpenMeteoWeather implements WeatherProvider {
  readonly id = "open_meteo";
  readonly attribution = { name: "Open-Meteo", url: "https://open-meteo.com/" };

  constructor(
    private readonly apiKey: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(url: URL, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal, headers: { accept: "application/json" } });
    } catch (cause) {
      throw new AppError("PROVIDER_UNAVAILABLE", "The weather service didn't answer", { cause });
    }
    if (res.status === 429)
      throw new AppError("RATE_LIMITED", "The weather service is busy; try again shortly");
    if (!res.ok)
      throw new AppError("PROVIDER_UNAVAILABLE", `The weather service failed (${res.status})`);
    return (await res.json()) as T;
  }

  async geocode(name: string, language: string, signal?: AbortSignal): Promise<WeatherPlace[]> {
    const url = new URL(GEOCODE);
    url.searchParams.set("name", name);
    url.searchParams.set("count", "5");
    url.searchParams.set("language", language);
    url.searchParams.set("format", "json");
    const body = await this.get<{
      results?: {
        name: string;
        latitude: number;
        longitude: number;
        admin1?: string;
        country?: string;
      }[];
    }>(url, signal);
    return (body.results ?? []).map((r) => ({
      name: r.name,
      detail: [r.admin1, r.country].filter((x) => x && x !== r.name).join(", ") || null,
      lat: r.latitude,
      lng: r.longitude,
    }));
  }

  async forecast(
    at: { lat: number; lng: number },
    days: number,
    signal?: AbortSignal,
  ): Promise<Forecast> {
    const url = new URL(this.apiKey ? CUSTOMER : FREE);
    url.searchParams.set("latitude", at.lat.toFixed(3));
    url.searchParams.set("longitude", at.lng.toFixed(3));
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", String(days));
    url.searchParams.set("current", CURRENT.join(","));
    url.searchParams.set("hourly", HOURLY.join(","));
    url.searchParams.set("daily", DAILY.join(","));
    if (this.apiKey) url.searchParams.set("apikey", this.apiKey);
    const body = await this.get<ForecastResponse>(url, signal);
    return parseForecast(body);
  }
}

/** Provider JSON → canonical forecast. Rows with a missing temperature are dropped, not invented. */
export function parseForecast(body: ForecastResponse): Forecast {
  const c = body.current;
  const h = body.hourly;
  const d = body.daily;
  const current =
    c && num(c.temperature_2m) != null && str(c.time)
      ? {
          time: str(c.time)!,
          temperature: num(c.temperature_2m)!,
          apparentTemperature: num(c.apparent_temperature),
          condition: conditionFromWmo(num(c.weather_code) ?? 3),
          isDay: c.is_day !== 0,
          humidity: pct(c.relative_humidity_2m),
          windSpeed: num(c.wind_speed_10m),
          precipitation: num(c.precipitation),
        }
      : null;
  const hourly = (h?.time ?? []).flatMap((time, i) => {
    const t = num(h?.temperature_2m?.[i]);
    if (t == null) return [];
    return [
      {
        time: time.slice(0, 16),
        temperature: t,
        condition: conditionFromWmo(num(h?.weather_code?.[i]) ?? 3),
        precipitationProbability: pct(h?.precipitation_probability?.[i]),
        windSpeed: num(h?.wind_speed_10m?.[i]),
        isDay: h?.is_day?.[i] !== 0,
      },
    ];
  });
  const daily = (d?.time ?? []).flatMap((date, i) => {
    const max = num(d?.temperature_2m_max?.[i]);
    const min = num(d?.temperature_2m_min?.[i]);
    if (max == null || min == null) return [];
    return [
      {
        date: date.slice(0, 10),
        condition: conditionFromWmo(num(d?.weather_code?.[i]) ?? 3),
        min,
        max,
        precipitationProbability: pct(d?.precipitation_probability_max?.[i]),
        precipitationSum: num(d?.precipitation_sum?.[i]),
        windMax: num(d?.wind_speed_10m_max?.[i]),
        sunrise: str(d?.sunrise?.[i]),
        sunset: str(d?.sunset?.[i]),
      },
    ];
  });
  return { timezone: body.timezone ?? "UTC", current, hourly, daily };
}
