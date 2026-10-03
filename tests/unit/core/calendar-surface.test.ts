import { describe, expect, it } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { WorkspaceSession } from "@/application/workspace-service";
import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import {
  agendaGroups,
  allDayBars,
  calendarPayload,
  chooseView,
  daysBetween,
  dayBlocks,
  eventLabel,
  eventsOn,
  keepPresentation,
  localSpan,
  monthWeeks,
  navigate,
  viewRange,
  visibleEvents,
  yearDensity,
  calendarItem,
  type CalendarItem,
  type CalendarPayload,
} from "@/core/workspace/calendar";
import { changeOf } from "@/core/workspace/lifecycle";
import { emptyWorkspace } from "@/core/workspace/model";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * The Calendar Surface (ADR-033): every event in its own day and time, all-day events in the
 * all-day strip, overlaps side by side, views switched without a new Surface. Synthetic data.
 */

const TZ = "America/Argentina/Buenos_Aires"; // UTC−3, no DST
const TODAY = "2026-10-03"; // Saturday
const AT = "2026-10-03T15:00:00.000Z";

function ev(
  id: string,
  title: string,
  start: string,
  end: string,
  over: Partial<CalendarEvent> = {},
) {
  return {
    id,
    calendarId: over.calendarId ?? "cal-personal",
    calendarName: over.calendarName ?? "Personal",
    title,
    description: null,
    location: null,
    start,
    end,
    allDay: start.length === 10,
    attendees: [],
    status: "confirmed",
    url: null,
    provenance: { providerKey: "google", connectionId: "c1", externalId: id, source: "Personal" },
    ...over,
  } as CalendarEvent;
}

// The real failure: Wednesday has a meeting and the theatre, Friday a birthday.
const week = [
  ev("m", "Weekly Meeting", "2026-09-30T13:00:00Z", "2026-09-30T13:30:00Z"),
  ev("t", "Teatro", "2026-09-30T23:00:00Z", "2026-10-01T01:00:00Z"),
  ev("b", "Cumpleaños", "2026-10-02", "2026-10-03"),
];
const payload = (events = week, from = "2026-09-28T03:00:00Z", to = "2026-10-05T03:00:00Z") =>
  calendarPayload({ events, from, to, timezone: TZ, today: TODAY });
const items = (p = payload()) => p.events;

describe("every event in its own day (the real failure)", () => {
  it("'esta semana' is a Week of the whole week, opened on today", () => {
    const p = payload();
    expect(p).toMatchObject({
      view: "week",
      anchor: TODAY,
      range: { from: "2026-09-28", to: "2026-10-05" },
    });
    expect(viewRange("week", p.anchor, p.range)).toEqual({ from: "2026-09-28", to: "2026-10-05" });
  });

  it("Wednesday holds the meeting and the theatre (local time), Friday the birthday", () => {
    const wed = dayBlocks(items(), "2026-09-30", TZ);
    expect(wed.map((b) => [b.item.title, b.from, b.to])).toEqual([
      ["Weekly Meeting", 600, 630],
      ["Teatro", 1200, 1320],
    ]);
    expect(dayBlocks(items(), "2026-10-03", TZ)).toEqual([]);
    expect(eventsOn(items(), "2026-10-02", TZ).map((e) => e.title)).toEqual(["Cumpleaños"]);
    // Never in a timed column: the all-day strip.
    expect(dayBlocks(items(), "2026-10-02", TZ)).toEqual([]);
    const days = daysBetween("2026-09-28", "2026-10-05");
    expect(allDayBars(items(), days, TZ)).toMatchObject([{ item: { id: "b" }, start: 4, end: 4 }]);
  });

  it("agenda groups by each event's own date, never one heading for all", () => {
    const g = agendaGroups(items(), payload().range, TZ);
    expect(g.map((x) => [x.day, x.items.map((i) => i.item.title)])).toEqual([
      ["2026-09-30", ["Weekly Meeting", "Teatro"]],
      ["2026-10-02", ["Cumpleaños"]],
    ]);
  });

  it("is described with its own day and time", () => {
    expect(eventLabel(items()[0]!, TZ, "en")).toBe(
      "Weekly Meeting, Wednesday, September 30, 10:00 to 10:30",
    );
    expect(eventLabel(items()[2]!, TZ, "es")).toMatch(
      /^Cumpleaños, viernes, 2 de octubre, todo el día$/,
    );
  });
});

describe("time correctness", () => {
  it("all-day dates never shift with the timezone", () => {
    expect(
      localSpan({ start: "2026-10-02", end: "2026-10-03", allDay: true }, "Pacific/Kiritimati"),
    ).toMatchObject({
      first: "2026-10-02",
      last: "2026-10-02",
    });
  });

  it("an event ending at midnight belongs to its day; one crossing midnight shows on both", () => {
    expect(localSpan(ev("x", "X", "2026-10-01T23:00:00Z", "2026-10-02T03:00:00Z"), TZ)).toEqual({
      first: "2026-10-01",
      last: "2026-10-01",
      startMin: 1200,
      endMin: 1440,
    });
    const late = calendarPayload({
      events: [ev("l", "Late", "2026-10-02T01:00:00Z", "2026-10-02T05:00:00Z")],
      from: "2026-09-28T03:00:00Z",
      to: "2026-10-05T03:00:00Z",
      timezone: TZ,
      today: TODAY,
    }).events;
    expect(dayBlocks(late, "2026-10-01", TZ)[0]).toMatchObject({ from: 1320, to: 1440 });
    expect(dayBlocks(late, "2026-10-02", TZ)[0]).toMatchObject({ from: 0, to: 120 });
  });

  it("DST: Madrid's October change keeps local hours right", () => {
    const madrid = "Europe/Madrid";
    // 25 Oct 2026, clocks go back at 03:00: 09:00 local = 08:00Z.
    expect(
      localSpan(ev("d", "D", "2026-10-25T08:00:00Z", "2026-10-25T09:00:00Z"), madrid),
    ).toMatchObject({
      first: "2026-10-25",
      startMin: 540,
      endMin: 600,
    });
  });

  it("a multi-day all-day event spans its days as one bar (not repeated events)", () => {
    const trip = calendarPayload({
      events: [ev("trip", "Viaje", "2026-09-29", "2026-10-02")],
      from: "2026-09-28T03:00:00Z",
      to: "2026-10-05T03:00:00Z",
      timezone: TZ,
      today: TODAY,
    }).events;
    const days = [
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ];
    expect(allDayBars(trip, days, TZ)).toEqual([
      expect.objectContaining({ start: 1, end: 3, lane: 0, before: false, after: false }),
    ]);
    const agenda = agendaGroups(trip, { from: "2026-09-28", to: "2026-10-05" }, TZ);
    expect(agenda).toHaveLength(1);
    expect(agenda[0]!.items[0]!.span).toMatchObject({ first: "2026-09-29", last: "2026-10-01" });
  });
});

describe("overlaps", () => {
  it("overlapping events share the width side by side; later ones reuse free columns", () => {
    const p = calendarPayload({
      events: [
        ev("a", "A", "2026-10-03T12:00:00Z", "2026-10-03T14:00:00Z"), // 09–11
        ev("b", "B", "2026-10-03T13:00:00Z", "2026-10-03T13:30:00Z"), // 10–10:30
        ev("c", "C", "2026-10-03T13:30:00Z", "2026-10-03T14:30:00Z"), // 10:30–11:30
        ev("d", "D", "2026-10-03T18:00:00Z", "2026-10-03T19:00:00Z"), // 15–16 alone
      ],
      from: "2026-10-03T03:00:00Z",
      to: "2026-10-04T03:00:00Z",
      timezone: TZ,
      today: TODAY,
    });
    const blocks = Object.fromEntries(dayBlocks(p.events, TODAY, TZ).map((b) => [b.item.id, b]));
    expect([blocks.a!.col, blocks.b!.col, blocks.c!.col]).toEqual([0, 1, 1]);
    expect(blocks.a!.cols).toBe(2);
    expect(blocks.d).toMatchObject({ col: 0, cols: 1 });
  });
});

describe("choosing the view", () => {
  it.each([
    ["hoy", "2026-10-03", "2026-10-04", 3, "day"],
    ["esta semana", "2026-09-28", "2026-10-05", 3, "week"],
    ["de lunes a viernes", "2026-09-28", "2026-10-03", 5, "week"],
    ["octubre", "2026-10-01", "2026-11-01", 12, "month"],
    ["próximos eventos (2 semanas)", "2026-10-03", "2026-10-17", 6, "agenda"],
    ["3 meses, pocos", "2026-10-01", "2027-01-01", 10, "agenda"],
    ["3 meses, muchos", "2026-10-01", "2027-01-01", 90, "month"],
    ["este año", "2026-01-01", "2027-01-01", 120, "year"],
  ])("%s → %s", (_, from, to, count, view) => {
    expect(chooseView({ from, to, count })).toBe(view);
  });

  it("an explicit request wins", () => {
    expect(chooseView({ from: "2026-10-03", to: "2026-10-04", count: 1, requested: "month" })).toBe(
      "month",
    );
  });
});

describe("switching views and moving in time", () => {
  it("Week → Month → Day changes only the presentation; loaded days need no new read", () => {
    const p = payload();
    const month = navigate(p, { view: "month" }, TODAY);
    expect(month.payload).toMatchObject({ view: "month", anchor: TODAY, events: p.events });
    expect(month.fetch).toEqual({ from: "2026-10-01", to: "2026-11-01" }); // a month needs more days
    const agenda = navigate(p, { view: "agenda" }, TODAY);
    expect(agenda.fetch).toBeNull(); // same week as agenda: no provider call
    const wed = navigate(p, { view: "day", anchor: "2026-09-30" }, TODAY);
    expect(wed).toMatchObject({ payload: { view: "day", anchor: "2026-09-30" }, fetch: null });
  });

  it("previous / today / next move by the view's unit", () => {
    const p = payload();
    expect(navigate(p, { shift: 1 }, TODAY)).toMatchObject({
      payload: { anchor: "2026-10-10" },
      fetch: { from: "2026-10-05", to: "2026-10-12" },
    });
    const day = navigate(p, { view: "day", shift: -1 }, TODAY).payload;
    expect(day.anchor).toBe("2026-10-02");
    expect(navigate({ ...p, view: "month" }, { shift: 1 }, TODAY).payload.anchor).toBe(
      "2026-11-01",
    );
    expect(navigate({ ...p, view: "year" }, { shift: -1 }, TODAY).payload.anchor).toBe(
      "2025-10-03",
    );
    expect(navigate({ ...p, anchor: "2026-09-28" }, { shift: 0 }, TODAY).payload.anchor).toBe(
      TODAY,
    );
  });

  it("a refreshed dataset keeps the view, date and filter the user chose", () => {
    const old = { ...payload(), view: "day" as const, anchor: "2026-09-30", hidden: ["cal-work"] };
    const fresh = payload([
      ...week,
      ev("n", "Nuevo", "2026-09-30T17:00:00Z", "2026-09-30T18:00:00Z"),
    ]);
    expect(keepPresentation(fresh, old)).toMatchObject({
      view: "day",
      anchor: "2026-09-30",
      hidden: ["cal-work"],
    });
    expect(keepPresentation(fresh, old).events).toHaveLength(4);
  });
});

describe("month, year and filters", () => {
  it("the month grid is whole Monday-first weeks", () => {
    const weeks = monthWeeks("2026-10-15");
    expect(weeks[0]![0]).toBe("2026-09-28");
    expect(weeks.at(-1)!.at(-1)).toBe("2026-11-01");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("the year shows density per day", () => {
    const d = yearDensity(items(), "2026", TZ);
    expect(d.get("2026-09-30")).toBe(2);
    expect(d.get("2026-10-02")).toBe(1);
  });

  it("hiding a calendar hides only its events", () => {
    const work = ev("w", "Standup", "2026-10-01T12:00:00Z", "2026-10-01T12:15:00Z", {
      calendarId: "cal-work",
      calendarName: "Trabajo",
    });
    const p = payload([...week, work]);
    expect(visibleEvents({ ...p, hidden: ["cal-work"] }).map((e) => e.id)).toEqual(["m", "t", "b"]);
    expect(p.events.map((e: CalendarItem) => e.id)).toContain("w");
  });
});

// ── On the Canvas: one Calendar Surface that follows the user's calendar ──────

describe("the Calendar Surface on the Live Canvas", () => {
  const auth = {
    userId: "user-1",
    workspaceId: "ws-1",
    profile: { locale: "es", timezone: TZ },
    db: { from: () => ({ upsert: async () => ({ error: null }) }) },
  } as unknown as AuthContext;
  const listed = (events: CalendarEvent[], from: string, to: string): ToolCallOutcome => ({
    status: "succeeded",
    output: {},
    display: { kind: "event_list", events, from, to },
    actionId: null,
    providerLabel: "google",
  });
  const thisWeek = { tool: "calendar.listEvents", args: { from: "2026-09-28", to: "2026-10-04" } };
  const session = () => {
    const s = new WorkspaceSession(auth, { kind: "conversation", id: "c" }, emptyWorkspace());
    s.present(
      "calendar.listEvents",
      "call-1",
      listed(week, "2026-09-28T03:00:00Z", "2026-10-05T03:00:00Z"),
      thisWeek,
    );
    return s;
  };
  const calendars = (s: WorkspaceSession) =>
    s.state().surfaces.filter((x) => x.type === "calendar");
  const shown = (s: WorkspaceSession) => calendars(s)[0]!.payload as CalendarPayload;
  const created = ev("n", "Reunión", "2026-10-01T18:00:00Z", "2026-10-01T19:00:00Z");
  const writeChange = (op: "createEvent" | "deleteEvent", id: string) =>
    changeOf(
      `calendar.${op}`,
      { name: op, kind: op === "deleteEvent" ? "destructive" : "write" },
      { status: "succeeded", target: { type: "calendar_event", id } },
    )!;

  it("'mi calendario de esta semana' → one Week calendar, primary and large", () => {
    const s = session();
    expect(calendars(s)).toHaveLength(1);
    expect(calendars(s)[0]).toMatchObject({ dataset: "calendar", size: "large" });
    expect(shown(s).view).toBe("week");
  });

  it("another range of the calendar replaces it in place (no second calendar)", () => {
    const s = session();
    const handle = calendars(s)[0]!.handle;
    s.present(
      "calendar.listEvents",
      "call-2",
      listed([], "2026-10-05T03:00:00Z", "2026-10-12T03:00:00Z"),
      { tool: "calendar.listEvents", args: { from: "2026-10-05", to: "2026-10-11" } },
    );
    expect(calendars(s)).toHaveLength(1);
    expect(calendars(s)[0]!.handle).toBe(handle);
    expect(shown(s).range.from).toBe("2026-10-05");
  });

  it("a created event appears in its block, the view is kept, no extra card; a deleted one leaves", async () => {
    const s = session();
    const id = calendars(s)[0]!.id;
    s.apply([
      {
        op: "update",
        id,
        patch: { payload: { ...shown(s), view: "day", anchor: "2026-10-01" } },
        at: AT,
      },
    ]);
    await s.reconcile(writeChange("createEvent", created.id), async () =>
      listed([...week, created], "2026-09-28T03:00:00Z", "2026-10-05T03:00:00Z"),
    );
    s.present(
      "calendar.createEvent",
      "call-3",
      {
        status: "succeeded",
        output: {},
        display: { kind: "event", event: created, change: "created" },
        actionId: "a",
        providerLabel: "google",
      },
      null,
      writeChange("createEvent", created.id),
    );
    expect(s.state().surfaces.map((x) => x.type)).toEqual(["calendar"]);
    expect(shown(s)).toMatchObject({ view: "day", anchor: "2026-10-01" });
    expect(dayBlocks(shown(s).events, "2026-10-01", TZ).map((b) => [b.item.title, b.from])).toEqual(
      [["Reunión", 900]],
    );
    expect(calendars(s)[0]!.focusItem).toBe("n");

    await s.reconcile(writeChange("deleteEvent", "n"), async () =>
      listed(week, "2026-09-28T03:00:00Z", "2026-10-05T03:00:00Z"),
    );
    expect(shown(s).events.map((e) => e.id)).not.toContain("n");
  });

  it("free time emphasizes the calendar already shown (no second calendar)", () => {
    const s = session();
    s.present(
      "calendar.findAvailability",
      "call-4",
      {
        status: "succeeded",
        output: {},
        display: {
          kind: "availability",
          from: "2026-10-01T03:00:00Z",
          to: "2026-10-02T03:00:00Z",
          free: [{ start: "2026-10-01T12:00:00Z", end: "2026-10-01T15:00:00Z" }],
          busy: [],
        },
        actionId: null,
        providerLabel: "google",
      },
      { tool: "calendar.findAvailability", args: { from: "2026-10-01" } },
    );
    expect(calendars(s)).toHaveLength(1);
    expect(shown(s)).toMatchObject({
      view: "day",
      anchor: "2026-10-01",
      free: [{ start: "2026-10-01T12:00:00Z" }],
    });
  });

  it("follow-ups move the same Surface: month (one range read), Wednesday, only Trabajo", async () => {
    const work = ev("w", "Standup", "2026-10-01T12:00:00Z", "2026-10-01T12:15:00Z", {
      calendarId: "cal-work",
      calendarName: "Trabajo",
    });
    const reads: { timeMin: Date; timeMax: Date }[] = [];
    const all = [
      ...week,
      work,
      ev("o", "Dentista", "2026-10-20T14:00:00Z", "2026-10-20T15:00:00Z"),
    ];
    const provider = {
      listCalendars: async () => [],
      listEvents: async (q: { timeMin: Date; timeMax: Date }) => {
        reads.push(q);
        return all.filter((e) => {
          const t = Date.parse(e.start.length === 10 ? `${e.start}T03:00:00Z` : e.start);
          return t >= q.timeMin.getTime() && t < q.timeMax.getTime();
        });
      },
    };
    const { ports } = makePorts(
      [
        binding({
          connectionId: "c1",
          capability: "calendar",
          providerKey: "google",
          label: "Personal",
          isDefault: true,
        }),
      ],
      { c1: provider },
    );
    const s = session();
    s.apply([
      {
        op: "update",
        id: calendars(s)[0]!.id,
        patch: { payload: { ...shown(s), events: [...shown(s).events, calendarItem(work)] } },
        at: AT,
      },
    ]);
    const ctx = makeCtx({ workspace: s, now: new Date(AT) });
    const show = (args: unknown) => executeToolCall(ports, ctx, { name: "ui.show", args });

    expect(await show({ what: "collection", as: "month" })).toMatchObject({
      status: "succeeded",
    });
    expect(reads).toHaveLength(1); // one range read for the month, never one per event
    expect(shown(s)).toMatchObject({
      view: "month",
      range: { from: "2026-10-01", to: "2026-11-01" },
    });
    expect(shown(s).events.map((e) => e.id)).toContain("o");
    expect(calendars(s)).toHaveLength(1);

    await show({ what: "collection", as: "day", date: "2026-10-01" });
    expect(reads).toHaveLength(1); // already loaded
    expect(shown(s)).toMatchObject({ view: "day", anchor: "2026-10-01" });

    await show({ what: "collection", calendars: ["trabajo"] });
    expect(visibleEvents(shown(s)).map((e) => e.id)).toEqual(["w"]);
    expect(calendars(s)).toHaveLength(1);
  });
});
