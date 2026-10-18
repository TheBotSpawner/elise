// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduleView } from "@/application/schedules-service";
import {
  morningBriefConfigSchema,
  normalizeBlocks,
  scheduleInputSchema,
} from "@/core/schedules/schedule";
import { canonicalTimezone } from "@/core/time";
import { SchedulesView } from "@/features/schedules/schedules-view";
import { I18nProvider } from "@/lib/i18n/client";
import { prefersArgentina, timezoneLabel, timezoneOptions } from "@/lib/timezones";

const actions = vi.hoisted(() => ({
  createScheduleAction: vi.fn(),
  updateScheduleAction: vi.fn(),
  pauseScheduleAction: vi.fn(),
  deleteScheduleAction: vi.fn(),
  runNowAction: vi.fn(),
  cancelRunAction: vi.fn(),
  historyAction: vi.fn(),
  slackChannelsAction: vi.fn(),
  suggestWeatherCitiesAction: vi.fn(),
  weatherCityAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/hooks/use-realtime-refresh", () => ({ useRealtimeRefresh: () => undefined }));
vi.mock("@/features/schedules/actions", () => actions);

const BA = "America/Argentina/Buenos_Aires";
const BARILOCHE = {
  placeId: "ChIJ-bariloche",
  displayName: "San Carlos de Bariloche, Río Negro, Argentina",
  city: "San Carlos de Bariloche",
  region: "Río Negro",
  country: "Argentina",
  countryCode: "AR",
  lat: -41.1335,
  lng: -71.3103,
};

function schedule(configuration: Record<string, unknown>, timezone = BA): ScheduleView {
  const input = scheduleInputSchema.parse({
    name: "Morning Brief",
    actionType: "morning_brief",
    definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
    timezone,
    configuration,
  });
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Morning Brief",
    status: "active",
    timezone: input.timezone,
    definition: input.definition,
    input,
    capabilities: [],
    nextRunAt: null,
    lastRun: null,
  };
}

function view(s: ScheduleView) {
  return render(
    <I18nProvider locale="es">
      <SchedulesView
        schedules={[s]}
        workspaceId="ws"
        timezone={BA}
        spaces={[]}
        backgroundAvailable
        draft={null}
      />
    </I18nProvider>,
  );
}

const edit = () => {
  fireEvent.click(screen.getByRole("button", { name: "Más acciones" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));
};

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.updateScheduleAction.mockResolvedValue({ ok: true, value: undefined });
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
  Element.prototype.scrollIntoView = vi.fn();
});

describe("one “Correos” for all email (ADR-069)", () => {
  it("old configurations: either old option (or both) means Correos; none means off", () => {
    expect(normalizeBlocks(["calendar", "email"])).toEqual(["calendar", "email"]);
    expect(normalizeBlocks(["calendar", "needs_reply"])).toEqual(["calendar", "email"]);
    expect(normalizeBlocks(["email", "needs_reply", "tasks"])).toEqual(["email", "tasks"]);
    expect(normalizeBlocks(["calendar", "tasks"])).toEqual(["calendar", "tasks"]);
    expect(morningBriefConfigSchema.parse({ blocks: ["needs_reply", "weather"] }).blocks).toEqual([
      "email",
      "weather",
    ]);
  });

  it("the form shows one Correos checkbox, checked for a legacy needs-reply-only schedule", () => {
    view(schedule({ blocks: ["calendar", "needs_reply"] }));
    edit();
    expect(screen.getByRole("checkbox", { name: "Correos" })).toBeChecked();
    expect(screen.queryByText("Mails importantes")).toBeNull();
    expect(screen.queryByText("Para responder y en espera")).toBeNull();
  });

  it("turning Correos off removes all email; on, adds it back", async () => {
    view(schedule({ blocks: ["calendar", "email"] }));
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: "Correos" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(actions.updateScheduleAction.mock.calls[0]![1].configuration.blocks).toEqual([
      "calendar",
    ]);
  });

  it("Finanzas, with no detail in the label; mobile reading order", () => {
    view(schedule({ blocks: ["calendar"] }));
    edit();
    expect(screen.getByRole("checkbox", { name: "Finanzas" })).toBeInTheDocument();
    expect(screen.queryByText(/Finanzas \(/)).toBeNull();
    const dialog = screen.getByLabelText("Nombre").closest("dialog")!;
    const names = within(dialog)
      .getAllByRole("checkbox")
      .map((c) => c.closest("label")!.textContent);
    expect(names.slice(0, 9)).toEqual([
      "Agenda",
      "Correos",
      "Tareas de hoy y vencidas",
      "Hábitos",
      "Objetivos",
      "Finanzas",
      "Inversiones",
      "Noticias (tus temas)",
      "Clima (pronóstico del día)",
    ]);
    // "Cambios en Conocimiento" is no longer offered to a schedule that doesn't use it.
    expect(names.some((n) => n?.includes("Conocimiento"))).toBe(false);
  });
});

describe("time zones", () => {
  const NOW = new Date("2026-10-16T12:00:00Z");

  it("aliases are saved as the canonical id", () => {
    expect(canonicalTimezone("America/Buenos_Aires")).toBe(BA);
    expect(canonicalTimezone("America/Cordoba")).toBe("America/Argentina/Cordoba");
    expect(canonicalTimezone("Europe/Madrid")).toBe("Europe/Madrid");
    const s = scheduleInputSchema.parse({
      name: "x",
      actionType: "morning_brief",
      definition: { kind: "weekly", days: [1], time: "08:00" },
      timezone: "America/Buenos_Aires",
      configuration: {},
    });
    expect(s.timezone).toBe(BA);
  });

  it("friendly labels with country and UTC; searchable by city, country, offset and id", () => {
    expect(timezoneLabel("America/Buenos_Aires")).toBe("Buenos Aires, Argentina");
    expect(timezoneLabel("America/Sao_Paulo")).toBe("Sao Paulo, Brasil");
    const options = timezoneOptions(["America/Buenos_Aires", "America/Argentina/Mendoza"], NOW);
    expect(options.map((o) => o.value)).toEqual([BA, "America/Argentina/Mendoza"]);
    const ba = options[0]!;
    expect(ba.label).toBe("Buenos Aires, Argentina");
    expect(ba.detail).toBe(`UTC-3 · ${BA}`);
    for (const q of ["argentina", "utc-3", "America/Argentina", "buenos aires"])
      expect(`${ba.label} ${ba.detail} ${ba.keywords}`.toLowerCase()).toContain(q.toLowerCase());
    expect(options[1]!.label).toBe("Mendoza, Argentina");
  });

  it("Argentina first for Argentines, never forced on anyone else", () => {
    const zones = ["Africa/Abidjan", "America/Sao_Paulo", "Europe/Madrid", "America/Buenos_Aires"];
    const ar = timezoneOptions(zones, NOW, { locale: "es", preferArgentina: true });
    expect(ar[0]!.value).toBe(BA);
    const other = timezoneOptions(zones, NOW, { locale: "en", preferArgentina: false });
    expect(other[0]!.value).toBe("Africa/Abidjan");
    expect(prefersArgentina("en", "Europe/Madrid")).toBe(false);
    expect(prefersArgentina("en", "America/Argentina/Cordoba")).toBe(true);
    // An old schedule's time zone is still offered, and kept.
    expect(timezoneOptions([], NOW, { current: "Asia/Kolkata" }).map((o) => o.value)).toContain(
      "Asia/Kolkata",
    );
  });

  it("the picker shows Buenos Aires, Argentina and saves the canonical id", async () => {
    view(schedule({ blocks: ["calendar"] }, "America/Buenos_Aires"));
    edit();
    expect(screen.getByLabelText("Zona horaria")).toHaveValue("Buenos Aires, Argentina");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    // Opening an old alias isn't a change, and nothing else moved.
    expect(actions.updateScheduleAction.mock.calls[0]![1].timezone).toBe(BA);
  });
});

describe("weather location (Google Places)", () => {
  it("suggests cities, saves the chosen place with its id and coordinates", async () => {
    actions.suggestWeatherCitiesAction.mockResolvedValue({
      ok: true,
      value: [
        {
          placeId: BARILOCHE.placeId,
          label: "San Carlos de Bariloche",
          detail: "Río Negro, Argentina",
        },
      ],
    });
    actions.weatherCityAction.mockResolvedValue({ ok: true, value: BARILOCHE });
    view(schedule({ blocks: ["weather"] }));
    edit();
    const field = screen.getByLabelText("Ubicación del clima");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Barilo" } });
    const option = await screen.findByRole("option", { name: /San Carlos de Bariloche/ });
    await act(async () => {
      fireEvent.click(option);
    });
    await waitFor(() => expect(field).toHaveValue(BARILOCHE.displayName));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    const config = actions.updateScheduleAction.mock.calls[0]![1].configuration;
    expect(config.weatherPlace).toEqual(BARILOCHE);
    expect(config.weatherLocation).toBe("San Carlos de Bariloche");
    // Typing and the chosen place share one billing session.
    expect(actions.weatherCityAction.mock.calls[0]![1]).toBe(
      actions.suggestWeatherCitiesAction.mock.calls[0]![1],
    );
  });

  it("typed text that wasn't picked is never saved", async () => {
    actions.suggestWeatherCitiesAction.mockResolvedValue({ ok: true, value: [] });
    view(schedule({ blocks: ["weather"] }));
    edit();
    const field = screen.getByLabelText("Ubicación del clima");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Buenos Airez" } });
    expect(await screen.findByText("Ninguna ciudad coincide.")).toBeInTheDocument();
    fireEvent.blur(field);
    await waitFor(() => expect(field).toHaveValue(""));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(actions.updateScheduleAction.mock.calls[0]![1].configuration).toMatchObject({
      weatherPlace: null,
      weatherLocation: null,
    });
  });

  it("an older free-text city keeps working and says it can be pinned", () => {
    view(schedule({ blocks: ["weather"], weatherLocation: "Buenos Aires" }));
    edit();
    expect(screen.getByLabelText("Ubicación del clima")).toHaveValue("Buenos Aires");
    expect(screen.getByText(/Guardada como texto/)).toBeInTheDocument();
  });

  it("without Places (a dev setup) it falls back to text, without breaking", async () => {
    actions.suggestWeatherCitiesAction.mockResolvedValue({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE", message: "" },
    });
    view(schedule({ blocks: ["weather"] }));
    edit();
    const field = screen.getByLabelText("Ubicación del clima");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Rosario" } });
    expect(await screen.findByText(/Google Places no está disponible/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(actions.updateScheduleAction.mock.calls[0]![1].configuration.weatherLocation).toBe(
      "Rosario",
    );
  });

  it("the place is stored in the schedule; old text-only schedules still parse", () => {
    expect(morningBriefConfigSchema.parse({ weatherPlace: BARILOCHE }).weatherPlace).toEqual(
      BARILOCHE,
    );
    expect(morningBriefConfigSchema.parse({ weatherLocation: "Córdoba" })).toMatchObject({
      weatherLocation: "Córdoba",
      weatherPlace: null,
    });
    expect(() =>
      morningBriefConfigSchema.parse({ weatherPlace: { ...BARILOCHE, lat: 200 } }),
    ).toThrow();
  });
});
