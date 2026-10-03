// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent } from "@/core/capabilities/calendar";
import { calendarPayload, type CalendarPayload } from "@/core/workspace/calendar";
import { CalendarBody } from "@/features/workspace/calendar-view";
import { I18nProvider } from "@/lib/i18n/client";

const TZ = "America/Argentina/Buenos_Aires";
let desktop = true;
beforeEach(() => {
  desktop = true;
  window.matchMedia = ((q: string) => ({
    matches: desktop && q.includes("min-width"),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

function ev(id: string, title: string, start: string, end: string, calendar = "Personal") {
  return {
    id,
    calendarId: `cal-${calendar}`,
    calendarName: calendar,
    title,
    description: null,
    location: null,
    start,
    end,
    allDay: start.length === 10,
    attendees: [],
    status: "confirmed",
    url: null,
    provenance: { providerKey: "google", connectionId: "c", externalId: id, source: "Personal" },
  } as CalendarEvent;
}

const week = (extra: CalendarEvent[] = []) =>
  calendarPayload({
    events: [
      ev("m", "Weekly Meeting", "2026-09-30T13:00:00Z", "2026-09-30T13:30:00Z"),
      ev("t", "Teatro", "2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z"),
      ev("b", "Cumpleaños", "2026-10-02", "2026-10-03"),
      ...extra,
    ],
    from: "2026-09-28T03:00:00Z",
    to: "2026-10-05T03:00:00Z",
    timezone: TZ,
    today: "2026-10-03",
  });

const show = (p: CalendarPayload, onChange = vi.fn()) => {
  render(
    <I18nProvider locale="es">
      <CalendarBody p={p} loading={false} focus={false} onChange={onChange} />
    </I18nProvider>,
  );
  return onChange;
};

describe("CalendarBody", () => {
  it("Week: each event is described with its own day and time; the birthday is all-day", () => {
    show(week());
    expect(
      screen.getByRole("button", {
        name: /^Weekly Meeting, miércoles, 30 de septiembre, 10:00 a 10:30/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Teatro, miércoles, 30 de septiembre, 20:00 a 22:00/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Cumpleaños, viernes, 2 de octubre, todo el día/ }),
    ).toBeInTheDocument();
    // No single misleading date heading over the whole list.
    expect(screen.queryByText(/sáb 3 oct/i)).toBeNull();
  });

  it("the view switcher changes the presentation of this Surface (no navigation)", () => {
    const onChange = show(week());
    const views = screen.getByRole("group", { name: "Vista" });
    expect(within(views).getByRole("button", { name: "Semana" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(views).getByRole("button", { name: "Mes" }));
    expect(onChange).toHaveBeenCalledWith({ view: "month" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(onChange).toHaveBeenCalledWith({ shift: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Hoy" }));
    expect(onChange).toHaveBeenCalledWith({ shift: 0 });
  });

  it("clicking a day header opens that Day", () => {
    const onChange = show(week());
    fireEvent.click(screen.getByRole("button", { name: /Ver el miércoles, 30 de septiembre/ }));
    expect(onChange).toHaveBeenCalledWith({ view: "day", anchor: "2026-09-30" });
  });

  it("an event opens its detail without leaving the Canvas", () => {
    show(week());
    fireEvent.click(screen.getByRole("button", { name: /^Teatro/ }));
    const dialog = screen.getByRole("dialog", { name: "Teatro" });
    expect(within(dialog).getByText(/miércoles, 30 de septiembre/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Month: bounded events per day, then '+N más' that opens the day", () => {
    const busy = Array.from({ length: 5 }, (_, i) =>
      ev(`x${i}`, `Turno ${i}`, `2026-10-01T1${i}:00:00Z`, `2026-10-01T1${i}:30:00Z`),
    );
    const p = { ...week(busy), view: "month" as const };
    const onChange = show(p);
    fireEvent.click(screen.getByRole("button", { name: "+2 más" }));
    expect(onChange).toHaveBeenCalledWith({ view: "day", anchor: "2026-10-01" });
  });

  it("Agenda: grouped under each event's own date, all-day labelled", () => {
    show({ ...week(), view: "agenda" });
    const wed = screen.getByRole("region", { name: /miércoles, 30 de septiembre/ });
    expect(within(wed).getByText("Weekly Meeting")).toBeInTheDocument();
    expect(within(wed).getByText("Teatro")).toBeInTheDocument();
    const fri = screen.getByRole("region", { name: /viernes, 2 de octubre/ });
    expect(within(fri).getByText("Todo el día")).toBeInTheDocument();
  });

  it("Year: twelve months by density; a month opens Month", () => {
    const onChange = show({ ...week(), view: "year" });
    fireEvent.click(screen.getByRole("button", { name: "septiembre: 2 eventos" }));
    expect(onChange).toHaveBeenCalledWith({ view: "month", anchor: "2026-09-01" });
  });

  it("several calendars: a filter, and the name travels with each event (not color only)", () => {
    const onChange = show(
      week([ev("w", "Standup", "2026-10-01T12:00:00Z", "2026-10-01T12:15:00Z", "Trabajo")]),
    );
    expect(screen.getByRole("button", { name: /^Standup, .* · Trabajo$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Calendarios/));
    fireEvent.click(screen.getByRole("checkbox", { name: /Trabajo/ }));
    expect(onChange).toHaveBeenCalledWith({ hidden: ["cal-Trabajo"] });
  });

  it("phones: the week is a strip of days plus the selected day's schedule", () => {
    desktop = false;
    const onChange = show({ ...week(), anchor: "2026-09-30" });
    expect(
      screen.getByRole("button", { name: /Ver el miércoles, 30 de septiembre · 2/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^Weekly Meeting/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cumpleaños/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ver el viernes, 2 de octubre/ }));
    expect(onChange).toHaveBeenCalledWith({ anchor: "2026-10-02" });
  });
});
