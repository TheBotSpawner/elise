import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import {
  freeSlots,
  resolveEventTimes,
  resolveRange,
  type BusyBlock,
  type CalendarEvent,
  type CalendarProvider,
  type NewEvent,
} from "@/core/capabilities/calendar";
import { makeExternalRef } from "@/core/providers/refs";
import { toLocalDateTime, zonedDateTimeToUtc } from "@/core/time";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

const BA = "America/Argentina/Buenos_Aires";

describe("timezone handling", () => {
  it("converts local wall-clock time to UTC, including across DST", () => {
    expect(zonedDateTimeToUtc("2026-09-30T15:00", BA).toISOString()).toBe(
      "2026-09-30T18:00:00.000Z",
    );
    // New York: EDT (-4) before Nov 1 2026, EST (-5) after.
    expect(zonedDateTimeToUtc("2026-10-31T09:00", "America/New_York").toISOString()).toBe(
      "2026-10-31T13:00:00.000Z",
    );
    expect(zonedDateTimeToUtc("2026-11-02T09:00", "America/New_York").toISOString()).toBe(
      "2026-11-02T14:00:00.000Z",
    );
    expect(toLocalDateTime(new Date("2026-09-30T18:00:00Z"), BA)).toBe("2026-09-30T15:00");
  });

  it("resolves whole days and explicit windows in the user's timezone", () => {
    expect(resolveRange("2026-09-30", undefined, BA)).toEqual({
      timeMin: new Date("2026-09-30T03:00:00Z"),
      timeMax: new Date("2026-10-01T03:00:00Z"),
    });
    expect(resolveRange("2026-09-30T15:00", "2026-09-30T17:00", BA)).toEqual({
      timeMin: new Date("2026-09-30T18:00:00Z"),
      timeMax: new Date("2026-09-30T20:00:00Z"),
    });
    expect(() => resolveRange("2026-09-30T17:00", "2026-09-30T15:00", BA)).toThrow(RangeError);
  });

  it("defaults timed events to 60 minutes and all-day events to one day", () => {
    expect(resolveEventTimes("2026-09-30T18:00", undefined, undefined, BA)).toEqual({
      start: { kind: "dateTime", local: "2026-09-30T18:00" },
      end: { kind: "dateTime", local: "2026-09-30T19:00" },
    });
    expect(resolveEventTimes("2026-09-30", undefined, undefined, BA)).toEqual({
      start: { kind: "date", date: "2026-09-30" },
      end: { kind: "date", date: "2026-10-01" },
    });
  });

  it("computes free time from busy blocks of any number of calendars", () => {
    const window = {
      timeMin: new Date("2026-09-30T18:00:00Z"),
      timeMax: new Date("2026-09-30T20:00:00Z"),
    };
    const busy = [
      { start: new Date("2026-09-30T18:30:00Z"), end: new Date("2026-09-30T19:00:00Z") },
      { start: new Date("2026-09-30T18:45:00Z"), end: new Date("2026-09-30T19:15:00Z") },
    ];
    expect(freeSlots(busy, window, 30)).toEqual([
      { start: new Date("2026-09-30T18:00:00Z"), end: new Date("2026-09-30T18:30:00Z") },
      { start: new Date("2026-09-30T19:15:00Z"), end: new Date("2026-09-30T20:00:00Z") },
    ]);
  });
});

class FakeCalendar implements CalendarProvider {
  created: NewEvent[] = [];
  deleted: string[] = [];
  constructor(
    private readonly connectionId: string,
    private readonly source: string,
    private readonly busyBlocks: BusyBlock[] = [],
    private readonly existing: CalendarEvent[] = [],
  ) {}
  async listCalendars() {
    return [];
  }
  async listEvents() {
    return this.existing;
  }
  async busy() {
    return this.busyBlocks;
  }
  async getEvent(id: string) {
    return this.existing.find((e) => e.id === id) ?? null;
  }
  async createEvent(event: NewEvent): Promise<CalendarEvent> {
    this.created.push(event);
    return makeEvent(this.connectionId, this.source, "new", event.title, []);
  }
  async updateEvent(id: string): Promise<CalendarEvent> {
    return this.existing.find((e) => e.id === id)!;
  }
  async deleteEvent(id: string): Promise<CalendarEvent> {
    this.deleted.push(id);
    return this.existing.find((e) => e.id === id)!;
  }
}

function makeEvent(
  connectionId: string,
  source: string,
  id: string,
  title: string,
  attendees: string[],
): CalendarEvent {
  return {
    id: makeExternalRef(connectionId, "evt", "primary", id),
    calendarId: makeExternalRef(connectionId, "cal", "primary"),
    calendarName: "Primary",
    title,
    description: null,
    location: null,
    start: "2026-09-30T18:00:00Z",
    end: "2026-09-30T19:00:00Z",
    allDay: false,
    attendees: [
      { email: "leo@example.com", name: null, response: "accepted", self: true, organizer: true },
      ...attendees.map((email) => ({
        email,
        name: null,
        response: null,
        self: false,
        organizer: false,
      })),
    ],
    status: "confirmed",
    url: null,
    provenance: { providerKey: "google", connectionId, externalId: id, source },
  };
}

const PERSONAL = "11111111-1111-4111-8111-111111111111";
const NORTHWIND = "22222222-2222-4222-8222-222222222222";

function setup() {
  const meeting = makeEvent(NORTHWIND, "Northwind", "m1", "Client meeting", [
    "client@northwind.com",
  ]);
  const gym = makeEvent(PERSONAL, "Personal", "g1", "Gym", []);
  const personal = new FakeCalendar(
    PERSONAL,
    "Personal",
    [
      {
        start: new Date("2026-09-30T18:00:00Z"),
        end: new Date("2026-09-30T19:00:00Z"),
        source: "Personal",
      },
    ],
    [gym],
  );
  const northwind = new FakeCalendar(
    NORTHWIND,
    "Northwind",
    [
      {
        start: new Date("2026-09-30T19:30:00Z"),
        end: new Date("2026-09-30T20:00:00Z"),
        source: "Northwind",
      },
    ],
    [meeting],
  );
  const bindings = [
    binding({
      connectionId: PERSONAL,
      capability: "calendar",
      providerKey: "google",
      label: "Personal",
      isDefault: true,
    }),
    binding({
      connectionId: NORTHWIND,
      capability: "calendar",
      providerKey: "google",
      label: "Northwind",
    }),
  ];
  const { ports, log } = makePorts(bindings, { [PERSONAL]: personal, [NORTHWIND]: northwind });
  return { ports, log, personal, northwind, meeting, gym };
}

describe("calendar tools", () => {
  it("answers availability across every calendar account", async () => {
    const { ports } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.findAvailability",
      args: { from: "2026-09-30T15:00", to: "2026-09-30T17:00" },
    });
    expect(out).toMatchObject({
      status: "succeeded",
      output: {
        free: [{ start: "2026-09-30T16:00", end: "2026-09-30T16:30" }],
        busy: [{ source: "Personal" }, { source: "Northwind" }],
      },
    });
  });

  it("creates a simple personal event directly in the default calendar", async () => {
    const { ports, personal, northwind } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.createEvent",
      args: { title: "Gym", start: "2026-09-30T18:00" },
    });
    expect(out.status).toBe("succeeded");
    expect(personal.created).toMatchObject([
      {
        title: "Gym",
        start: { local: "2026-09-30T18:00" },
        end: { local: "2026-09-30T19:00" },
        timezone: BA,
      },
    ]);
    expect(northwind.created).toHaveLength(0);
  });

  it("requires approval before inviting other people", async () => {
    const { ports, northwind, log } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.createEvent",
      args: {
        title: "Proposal review",
        start: "2026-10-01T15:00",
        attendees: ["juan@northwind.com"],
        destination: "Northwind",
      },
    });
    expect(out).toMatchObject({ status: "approval_required", reason: "external_communication" });
    expect(out.status === "approval_required" && out.summary).toContain("juan@northwind.com");
    expect(northwind.created).toHaveLength(0);
    expect(log.approvals).toHaveLength(1);
  });

  it("requires approval to change an event that has other attendees", async () => {
    const { ports, meeting } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.updateEvent",
      args: { eventId: meeting.id, start: "2026-10-01T16:00", end: "2026-10-01T17:00" },
    });
    expect(out).toMatchObject({ status: "approval_required", reason: "external_communication" });
  });

  it("always asks before deleting, even personal events, and routes to the owning account", async () => {
    const { ports, gym, personal } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.deleteEvent",
      args: { eventId: gym.id },
    });
    expect(out).toMatchObject({ status: "approval_required" });
    expect(out.status === "approval_required" && out.summary).toContain("Gym");
    expect(personal.deleted).toHaveLength(0);
  });

  it("rejects impossible times as a fixable validation error", async () => {
    const { ports } = setup();
    const out = await executeToolCall(ports, makeCtx(), {
      name: "calendar.createEvent",
      args: { title: "X", start: "2026-09-30T18:00", end: "2026-09-30T17:00" },
    });
    expect(out).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
  });
});
