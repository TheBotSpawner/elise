import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { WEATHER_HERE_SIGNAL } from "@/core/agents/tool-selection";
import type { ProviderFactory } from "@/core/agents/tools";
import type { Forecast, WeatherCapability, WeatherPlace } from "@/core/weather/model";
import { chooseWeatherPlace, countryCodeOf, parsePlaceQuery } from "@/core/weather/place";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

// What Open-Meteo's geocoder really answered (2026-10-18), trimmed: fuzzy, name-only.
const P = (
  name: string,
  admin1: string,
  countryCode: string,
  country: string,
  lat: number,
  lng: number,
  featureCode = "PPL",
  population = 0,
): WeatherPlace => ({
  name,
  detail: `${admin1}, ${country}`,
  lat,
  lng,
  countryCode,
  country,
  admin1,
  featureCode,
  population,
});
const BA = P(
  "Buenos Aires",
  "Ciudad Autónoma de Buenos Aires",
  "AR",
  "Argentina",
  -34.61,
  -58.38,
  "PPLC",
  2891082,
);
const MANILA_CAPITOL = P("Capitol", "Metro Manila", "PH", "Filipinas", 14.69, 121.08);
const GEO: Record<string, WeatherPlace[]> = {
  capital: [
    MANILA_CAPITOL,
    P("Capital", "Provincia de Puntarenas", "CR", "Costa Rica", 9.9, -84.8),
    P("Payán", "Nariño", "CO", "Colombia", 1.8, -78.1, "PPLA2", 2892),
    P("Capital Sur", "Querétaro", "MX", "México", 20.6, -100.4),
    P("Capital Hill", "California", "US", "Estados Unidos", 38.5, -121.5),
  ],
  caba: [P("Caba", "Ilocos", "PH", "Filipinas", 16.4, 120.3, "PPLA3", 4806)],
  capitol: [
    P("Capitol", "Montana", "US", "Estados Unidos", 45.5, -104.1),
    MANILA_CAPITOL,
    P("Capitol", "Valle del Cagayán", "PH", "Filipinas", 17.6, 121.7),
  ],
  "buenos aires": [
    BA,
    P("Buenos Aires", "Departamento de Rivas", "NI", "Nicaragua", 11.4, -85.8, "PPLA2", 1692),
  ],
  madrid: [
    P("Madrid", "Comunidad de Madrid", "ES", "España", 40.42, -3.7, "PPLC", 3255944),
    P("Madrid", "Cundinamarca", "CO", "Colombia", 4.73, -74.26, "PPLA2", 135000),
    P("Madrid", "Iowa", "US", "Estados Unidos", 41.87, -93.82, "PPL", 2588),
  ],
};

function geocoder() {
  const calls: { name: string; country: string | null }[] = [];
  const geocode = async (name: string, _lang: string, country: string | null = null) => {
    calls.push({ name, country });
    return (GEO[name.toLowerCase()] ?? []).filter((c) => !country || c.countryCode === country);
  };
  return { geocode, calls };
}

const TZ_AR = "America/Argentina/Buenos_Aires";
const NOW = new Date("2026-10-18T15:00:00Z");

function forecastFor(timezone: string): Forecast {
  const date = "2026-10-18";
  return {
    timezone,
    current: {
      time: `${date}T12:00`,
      temperature: 19,
      apparentTemperature: 18,
      condition: "rain",
      isDay: true,
      humidity: 80,
      windSpeed: 10,
      precipitation: 1,
    },
    daily: [
      {
        date,
        condition: "rain",
        min: 14,
        max: 21,
        precipitationProbability: 70,
        precipitationSum: 5,
        windMax: 20,
        sunrise: `${date}T06:20`,
        sunset: `${date}T19:30`,
      },
    ],
    hourly: Array.from({ length: 24 }, (_, h) => ({
      time: `${date}T${String(h).padStart(2, "0")}:00`,
      temperature: 15 + (h % 6),
      condition: "rain" as const,
      precipitationProbability: h === 17 ? 70 : 20,
      windSpeed: 10,
      isDay: h >= 7 && h < 20,
    })),
  };
}

function setup(over: Parameters<typeof makeCtx>[0] = {}) {
  const g = geocoder();
  const forecasts: { lat: number; lng: number }[] = [];
  const weather: WeatherCapability = {
    attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
    geocode: g.geocode,
    forecast: async (at) => {
      forecasts.push(at);
      return forecastFor(at.lat < 0 ? TZ_AR : "Europe/Madrid");
    },
  };
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "weather" ? weather : undefined)) as ProviderFactory["get"],
  };
  const ctx = makeCtx({
    now: NOW,
    timezone: TZ_AR,
    log: (_l, event, fields) => logs.push({ event, fields }),
    ...over,
  });
  const ask = async (location?: string, name = "weather.forecast") => {
    const out = await executeToolCall(ports, ctx, {
      name,
      args: {
        ...(location ? { location } : {}),
        ...(name === "weather.forecast" ? { when: "today" } : {}),
      },
    });
    if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
    return out;
  };
  return { ask, calls: g.calls, forecasts, logs, ctx };
}

const card = (out: Awaited<ReturnType<ReturnType<typeof setup>["ask"]>>) =>
  out.display?.kind === "weather" ? out.display.weather : null;

describe("weather place resolution (ADR-086)", () => {
  it("Argentina + “¿Va a llover hoy en Capital?” → Buenos Aires City, never Capitol, Manila", async () => {
    const s = setup();
    const out = await s.ask("Capital");
    expect(s.calls).toEqual([{ name: "Buenos Aires", country: "AR" }]);
    const o = out.output as { place: string };
    expect(o.place).toBe("Buenos Aires, Ciudad Autónoma de Buenos Aires, Argentina");
    // Card, narrative input and the forecast request: one place.
    expect(card(out)?.location).toMatchObject({
      name: "Buenos Aires",
      detail: "Ciudad Autónoma de Buenos Aires, Argentina",
      source: "explicit",
      countryCode: "AR",
    });
    expect(s.forecasts[0]).toEqual({ lat: -34.61, lng: -58.38 });
    expect(JSON.stringify(out)).not.toMatch(/Manila|Capitol/);
  });

  it("“CABA”, “Capital Federal”, “Buenos Aires Capital” are the same place", async () => {
    for (const said of ["CABA", "Capital Federal", "Buenos Aires Capital", "C.A.B.A."]) {
      const s = setup();
      const out = await s.ask(said);
      expect(card(out)?.location?.name, said).toBe("Buenos Aires");
      expect(s.forecasts[0], said).toEqual({ lat: -34.61, lng: -58.38 });
    }
  });

  it("a regional name is regional: “Capital” with no Argentine context isn't forced to Buenos Aires — it asks", async () => {
    const s = setup({ timezone: "UTC" });
    const out = await s.ask("Capital");
    const o = out.output as { found: boolean; options: string[] };
    expect(o.found).toBe(false);
    expect(o.options.length).toBeGreaterThan(1);
    expect(o.options.join(" ")).not.toMatch(/Capitol|Payán/); // look-alikes rejected
    expect(out.display).toBeUndefined();
    expect(s.forecasts).toHaveLength(0);
  });

  it("explicit “Capitol, Metro Manila, Philippines” resolves there, even from Buenos Aires", async () => {
    const s = setup();
    const out = await s.ask("Capitol, Metro Manila, Philippines");
    expect(s.calls[0]).toEqual({ name: "Capitol", country: "PH" });
    expect(card(out)?.location).toMatchObject({ name: "Capitol", countryCode: "PH" });
    expect(s.forecasts[0]).toEqual({ lat: 14.69, lng: 121.08 });
  });

  it("explicit Madrid while located in Buenos Aires → Madrid, Spain", async () => {
    const s = setup({ here: { lat: -34.6, lng: -58.4 } });
    const out = await s.ask("Madrid");
    expect(card(out)?.location).toMatchObject({ name: "Madrid", countryCode: "ES" });
    expect(card(out)?.timezone).toBe("Europe/Madrid");
  });

  it("“donde estoy” with a fresh shared position: that position, no city guessed", async () => {
    const s = setup({ here: { lat: -34.6037, lng: -58.3816 } });
    const out = await s.ask("here");
    expect(s.calls).toHaveLength(0);
    expect(card(out)?.location?.source).toBe("device");
    expect(JSON.stringify(out)).not.toContain("34.60");
  });

  it("“donde estoy” with location on but no coordinates (denied/timeout): asks, never claims to know", async () => {
    const s = setup({ here: null });
    const out = await s.ask("here");
    expect((out.output as { found: boolean }).found).toBe(false);
    expect(card(out)?.mode).toBe("needs_location");
    expect(s.calls).toHaveLength(0);
    expect(s.logs.find((l) => l.event === "weather.location_missing")?.fields).toEqual({
      here_requested: true,
      position_shared: false,
    });
  });

  it("the transcript slip, then the explicit correction: weather for CABA, not Manila", async () => {
    // "¿vas a ver hoy Capital?" → (no tool) → "va a llover hoy en Capital" → weather.forecast.
    const s = setup();
    const out = await s.ask("Capital");
    expect((out.output as { place: string }).place).toMatch(/^Buenos Aires/);
  });

  it("the weather place on screen is the region hint for the next request", async () => {
    const s = setup({
      timezone: "UTC",
      workspace: {
        state: () => ({
          surfaces: [{ type: "weather", payload: { location: { countryCode: "AR" } } }],
        }),
      } as never,
    });
    const out = await s.ask("Capital");
    expect(card(out)?.location?.name).toBe("Buenos Aires");
  });

  it("telemetry says how the place was chosen, never the place itself", async () => {
    const s = setup();
    await s.ask("Capital");
    const log = s.logs.find((l) => l.event === "weather.location_resolved")!;
    expect(log.fields).toMatchObject({
      outcome: "resolved",
      alias: "capital",
      country: "AR",
      confidence: "high",
    });
    expect(JSON.stringify(log)).not.toMatch(/Buenos|34\.|58\./);
  });
});

describe("place choice (pure)", () => {
  const none = { country: null, near: null };
  it("rejects fuzzy look-alikes (Capital ≠ Capitol)", () => {
    const q = parsePlaceQuery("Capital", null);
    expect(chooseWeatherPlace(q, [MANILA_CAPITOL], none)).toEqual({
      kind: "not_found",
      rejected: 1,
    });
  });
  it("a lone small place on another continent is a question", () => {
    const q = parsePlaceQuery("Caba", "AR"); // with Argentina it's the alias; here: no alias
    expect(q.alias).toBe("caba");
    const plain = parsePlaceQuery("Caba", "ES");
    expect(chooseWeatherPlace(plain, GEO.caba!, { country: "ES", near: null }).kind).toBe(
      "ambiguous",
    );
  });
  it("country names in Spanish or English", () => {
    expect(countryCodeOf("Philippines")).toBe("PH");
    expect(countryCodeOf("Filipinas")).toBe("PH");
    expect(countryCodeOf("España")).toBe("ES");
    expect(countryCodeOf("Metro Manila")).toBeNull();
  });
  it("“Santiago de Chile” matches Santiago, Chile", () => {
    const santiago = P(
      "Santiago",
      "Región Metropolitana",
      "CL",
      "Chile",
      -33.4,
      -70.6,
      "PPLC",
      4837295,
    );
    const q = parsePlaceQuery("Santiago de Chile", "AR");
    expect(chooseWeatherPlace(q, [santiago], { country: "AR", near: null }).kind).toBe("resolved");
  });
});

describe("weather 'here' signal", () => {
  it("refreshes the device position for weather-here questions only", () => {
    expect(WEATHER_HERE_SIGNAL.test("¿Va a llover donde estoy?")).toBe(true);
    expect(WEATHER_HERE_SIGNAL.test("¿qué temperatura hace acá?")).toBe(true);
    expect(WEATHER_HERE_SIGNAL.test("¿Va a llover hoy en Capital?")).toBe(false);
  });
});
