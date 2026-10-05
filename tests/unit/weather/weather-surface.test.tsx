// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MorningBrief } from "@/core/briefs/morning-brief";
import type { WeatherPayload } from "@/core/workspace/weather";
import { BriefView } from "@/features/schedules/brief-view";
import { WeatherView } from "@/features/workspace/canvas/weather";
import { I18nProvider } from "@/lib/i18n/client";

const day = (date: string, max: number, rain: number) => ({
  date,
  condition: rain >= 50 ? ("rain" as const) : ("clear" as const),
  min: max - 9,
  max,
  precipitationProbability: rain,
  precipitationSum: null,
  windMax: 12,
  sunrise: null,
  sunset: null,
});

const week: WeatherPayload = {
  mode: "daily",
  location: { name: "Buenos Aires", detail: "Argentina", source: "explicit" },
  timezone: "America/Argentina/Buenos_Aires",
  period: { from: "2026-10-05T00:00", to: "2026-10-12T00:00" },
  current: null,
  days: [
    day("2026-10-05", 24, 10),
    day("2026-10-06", 22, 45),
    day("2026-10-07", 19, 80),
    day("2026-10-08", 21, 30),
    day("2026-10-09", 25, 5),
    day("2026-10-10", 27, 5),
    day("2026-10-11", 26, 15),
  ],
  hours: [],
  attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
};

const hourly: WeatherPayload = {
  ...week,
  mode: "hourly",
  period: { from: "2026-10-06T12:00", to: "2026-10-06T19:00" },
  days: [day("2026-10-06", 22, 45)],
  hours: Array.from({ length: 7 }, (_, i) => ({
    time: `2026-10-06T${12 + i}:00`,
    temperature: 20 + i / 2,
    condition: "cloudy" as const,
    precipitationProbability: i === 5 ? 70 : 10,
    windSpeed: 10,
    isDay: true,
  })),
};

const current: WeatherPayload = {
  ...week,
  mode: "current",
  location: { name: "Buenos Aires", detail: null, source: "timezone" },
  current: {
    time: "2026-10-05T10:30",
    temperature: 18.4,
    apparentTemperature: 16,
    condition: "partly_cloudy",
    isDay: true,
    humidity: 60,
    windSpeed: 30,
    precipitation: 0,
  },
  days: [day("2026-10-05", 24, 10)],
};

// jsdom has no layout: every observed chart gets a fixed 600 × 200 box.
globalThis.ResizeObserver ??= class {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ target, contentRect: { width: 600, height: 200 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
};

const ui = (node: React.ReactNode) => render(<I18nProvider locale="es">{node}</I18nProvider>);

describe("Weather Surface", () => {
  it("current: temperature, condition, feels-like, today's range, and the assumed place", () => {
    ui(<WeatherView p={current} />);
    expect(screen.getByText("18°")).toBeTruthy();
    expect(screen.getByText(/Parcialmente nublado · Sensación 16°/)).toBeTruthy();
    expect(screen.getByText("15° / 24°")).toBeTruthy();
    expect(screen.getByText(/La ciudad de tu zona horaria/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open-Meteo" })).toBeTruthy();
  });

  it("weekly: seven labelled days with max, min and rain, plus a temperature chart", () => {
    const { container } = ui(<WeatherView p={week} size="large" />);
    const days = screen.getByRole("list", { name: "Próximos días" }).querySelectorAll("li");
    expect(days).toHaveLength(7);
    expect(days[2]!.getAttribute("aria-label")).toMatch(/Lluvia, 19° \/ 10°, Lluvia 80%/);
    expect(container.querySelector("svg[role=img]:not(.lucide)")).toBeTruthy();
  });

  it("hourly: the asked window, hour by hour, with the day's summary", () => {
    ui(<WeatherView p={hourly} />);
    const hours = screen.getByRole("list", { name: "Por hora" }).querySelectorAll("li");
    expect(hours).toHaveLength(7);
    expect(hours[0]!.textContent).toContain("12:00");
    expect(screen.getByText("70%")).toBeTruthy();
  });

  it("compact (the Morning Brief): no chart, a few hours", () => {
    const { container } = ui(<WeatherView p={hourly} compact />);
    expect(screen.getByRole("list", { name: "Por hora" }).querySelectorAll("li")).toHaveLength(6);
    expect(container.querySelector("svg[role=img]:not(.lucide)")).toBeNull();
  });

  it("without a place it asks, instead of showing a made-up forecast", () => {
    ui(<WeatherView p={{ ...week, mode: "needs_location", location: null, days: [] }} />);
    expect(screen.getByText(/¿De qué ciudad\?/)).toBeTruthy();
  });
});

describe("Morning Brief issues", () => {
  const brief: MorningBrief = {
    version: 1,
    date: "2026-10-05",
    timezone: "America/Argentina/Buenos_Aires",
    today: { events: [], conflicts: [], gaps: [] },
    attention: { emails: [], tasks: [] },
    waitingOnYou: { replies: [], overdue: [] },
    waitingOnOthers: [],
    weather: hourly,
    // As stored by the old runtime: duplicated, raw codes, account labels as sources.
    warnings: [
      { block: "email", code: "CAPABILITY_UNAVAILABLE" },
      { block: "needs_reply", code: "CAPABILITY_UNAVAILABLE" },
      { block: "news", code: "SERVER_NOT_CONFIGURED" },
      { block: "news", code: "SERVER_NOT_CONFIGURED" },
      { block: "tasks", code: "AUTH_EXPIRED", account: "UTN" },
    ],
    narrative: null,
  };

  it("one compact line per source after the content; setup problems never read as 'not connected'", () => {
    ui(<BriefView brief={brief} createdAt="2026-10-05T11:00:00Z" unread={false} />);
    const section = screen.getByRole("region", { name: "Algunas fuentes necesitan atención" });
    const lines = [...section.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual([
      "Email: no hay ninguna cuenta conectada.",
      "No se pudo cargar Noticias por un problema de configuración de ELISE — tu conexión está bien.",
      "Tareas (UTN): hay que volver a conectar la cuenta.",
    ]);
    expect(screen.getByRole("link", { name: "Open-Meteo" })).toBeTruthy();
    // The weather card comes before the issues.
    const html = document.body.innerHTML;
    expect(html.indexOf("Por hora")).toBeLessThan(html.indexOf("necesitan atención"));
  });
});
