import { describe, expect, it, vi } from "vitest";

import { makeExternalRef } from "@/core/providers/refs";
import {
  GoogleCalendarProvider,
  idempotentEventId,
  normalizeEvent,
  type GEvent,
} from "@/infrastructure/providers/google/calendar";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import { GoogleTasksProvider, normalizeTask } from "@/infrastructure/providers/google/tasks";

const CONN = { connectionId: "11111111-1111-4111-8111-111111111111", label: "Personal" };
const BA = "America/Argentina/Buenos_Aires";

type Call = { method: string; url: string; body: unknown };

/** Minimal fake of the Google REST surface: routes by method + URL prefix. */
function fakeGoogle(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(" ");
      return m === call.method && url.startsWith(prefix!);
    });
    if (!key) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    const result = routes[key]!(call);
    if (result instanceof Response) return result;
    return new Response(result === undefined ? null : JSON.stringify(result), {
      status: result === undefined ? 204 : 200,
    });
  });
  return { http: new GoogleHttp({ accessToken: async () => "token" }, fetchImpl), calls };
}

const CAL = "https://www.googleapis.com/calendar/v3";
const TASKS = "https://tasks.googleapis.com/tasks/v1";

describe("Google Calendar normalization", () => {
  it("maps events into the canonical model with provenance and account", () => {
    const event: GEvent = {
      id: "ev1",
      summary: "Design review",
      start: { dateTime: "2026-10-01T14:00:00-03:00" },
      end: { dateTime: "2026-10-01T15:00:00-03:00" },
      attendees: [
        { email: "me@x.com", self: true },
        { email: "marta@x.com", displayName: "Marta", responseStatus: "accepted" },
      ],
      htmlLink: "https://calendar.google.com/event?eid=1",
    };
    const e = normalizeEvent(event, "work@group.calendar.google.com", "Work", CONN);
    expect(e).toMatchObject({
      title: "Design review",
      allDay: false,
      calendarName: "Work",
      start: "2026-10-01T14:00:00-03:00",
      attendees: [{ self: true }, { name: "Marta", response: "accepted", self: false }],
      provenance: {
        providerKey: "google",
        connectionId: CONN.connectionId,
        externalId: "ev1",
        source: "Personal",
      },
    });
    expect(e.id).toBe(
      makeExternalRef(CONN.connectionId, "evt", "work@group.calendar.google.com", "ev1"),
    );
    expect(
      normalizeEvent(
        { id: "a", start: { date: "2026-10-01" }, end: { date: "2026-10-02" } },
        "p",
        "P",
        CONN,
      ).allDay,
    ).toBe(true);
  });
});

describe("GoogleCalendarProvider", () => {
  const calendarList = {
    items: [
      { id: "leo@gmail.com", summary: "Leo", primary: true, selected: true, accessRole: "owner" },
      { id: "team@group", summary: "Team", selected: true, accessRole: "reader" },
      { id: "hidden@group", summary: "Holidays", selected: false, accessRole: "reader" },
    ],
  };

  it("reads visible calendars only, in the requested UTC window", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${CAL}/users/me/calendarList`]: () => calendarList,
      [`GET ${CAL}/calendars/`]: (c) => ({
        items: [
          {
            id: `e-${c.url.includes("team") ? "team" : "me"}`,
            summary: "X",
            start: { dateTime: "2026-10-01T12:00:00Z" },
            end: { dateTime: "2026-10-01T13:00:00Z" },
          },
        ],
      }),
    });
    const events = await new GoogleCalendarProvider(CONN, http).listEvents({
      timeMin: new Date("2026-10-01T03:00:00Z"),
      timeMax: new Date("2026-10-02T03:00:00Z"),
      limit: 50,
    });
    expect(events.map((e) => e.calendarName).sort()).toEqual(["Leo", "Team"]);
    const eventCalls = calls.filter((c) => c.url.includes("/events?"));
    expect(eventCalls).toHaveLength(2);
    expect(eventCalls[0]!.url).toContain("timeMin=2026-10-01T03%3A00%3A00.000Z");
    expect(eventCalls[0]!.url).toContain("singleEvents=true");
  });

  it("creates events in local time with the user's timezone and an idempotent id", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${CAL}/users/me/calendarList`]: () => calendarList,
      [`POST ${CAL}/calendars/primary/events`]: (c) => ({
        ...(c.body as object),
        id: (c.body as { id: string }).id,
      }),
    });
    const provider = new GoogleCalendarProvider(CONN, http);
    await provider.createEvent(
      {
        title: "Gym",
        start: { kind: "dateTime", local: "2026-09-30T18:00" },
        end: { kind: "dateTime", local: "2026-09-30T19:00" },
        timezone: BA,
        attendees: [],
      },
      { idempotencyKey: "action-1" },
    );
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("sendUpdates=none");
    expect(post.body).toMatchObject({
      id: idempotentEventId("action-1"),
      summary: "Gym",
      start: { dateTime: "2026-09-30T18:00:00", timeZone: BA },
      end: { dateTime: "2026-09-30T19:00:00", timeZone: BA },
    });
    expect(idempotentEventId("action-1")).toMatch(/^[0-9a-v]{5,1024}$/);
  });

  it("returns the existing event when a retried create collides on its idempotent id", async () => {
    const id = idempotentEventId("action-2");
    const { http } = fakeGoogle({
      [`GET ${CAL}/users/me/calendarList`]: () => calendarList,
      [`POST ${CAL}/calendars/primary/events`]: () =>
        new Response(JSON.stringify({ error: { code: 409 } }), { status: 409 }),
      [`GET ${CAL}/calendars/primary/events/${id}`]: () => ({
        id,
        summary: "Gym",
        start: { dateTime: "2026-09-30T21:00:00Z" },
        end: { dateTime: "2026-09-30T22:00:00Z" },
      }),
    });
    const event = await new GoogleCalendarProvider(CONN, http).createEvent(
      {
        title: "Gym",
        start: { kind: "dateTime", local: "2026-09-30T18:00" },
        end: { kind: "dateTime", local: "2026-09-30T19:00" },
        timezone: BA,
        attendees: [],
      },
      { idempotencyKey: "action-2" },
    );
    expect(event.provenance.externalId).toBe(id);
  });

  it("notifies attendees only when there are any", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${CAL}/users/me/calendarList`]: () => calendarList,
      [`POST ${CAL}/calendars/primary/events`]: (c) => ({ ...(c.body as object) }),
    });
    await new GoogleCalendarProvider(CONN, http).createEvent(
      {
        title: "Sync",
        start: { kind: "date", date: "2026-10-01" },
        end: { kind: "date", date: "2026-10-02" },
        timezone: BA,
        attendees: ["juan@northwind.com"],
      },
      { idempotencyKey: null },
    );
    expect(calls.find((c) => c.method === "POST")!.url).toContain("sendUpdates=all");
  });

  it("refuses ids that belong to another connection", async () => {
    const { http } = fakeGoogle({});
    const foreign = makeExternalRef("22222222-2222-4222-8222-222222222222", "evt", "primary", "x");
    await expect(new GoogleCalendarProvider(CONN, http).getEvent(foreign)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

describe("Google Tasks", () => {
  const lists = { items: [{ id: "L1", title: "My Tasks" }] };

  it("normalizes tasks into the canonical Task model", () => {
    const t = normalizeTask(
      {
        id: "t1",
        title: "Review",
        notes: "n",
        status: "needsAction",
        due: "2026-10-01T00:00:00.000Z",
        updated: "2026-09-29T10:00:00Z",
      },
      { id: "L1", title: "My Tasks" },
      CONN,
    );
    expect(t).toMatchObject({
      title: "Review",
      notes: "n",
      status: "pending",
      dueDate: "2026-10-01",
      priority: null,
      provenance: {
        providerKey: "google",
        source: "Personal",
        listName: "My Tasks",
        externalId: "t1",
      },
    });
    expect(t.id).toBe(makeExternalRef(CONN.connectionId, "task", "L1", "t1"));
  });

  it("creates in the default list and maps due dates", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${TASKS}/users/@me/lists`]: () => lists,
      [`POST ${TASKS}/lists/%40default/tasks`]: (c) => ({
        id: "t9",
        ...(c.body as object),
        status: "needsAction",
      }),
    });
    const task = await new GoogleTasksProvider(CONN, http).create({
      title: "Review the proposal",
      dueDate: "2026-10-01",
    });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      title: "Review the proposal",
      due: "2026-10-01T00:00:00.000Z",
    });
    expect(task.dueDate).toBe("2026-10-01");
  });

  it("completes and reopens with Google's status semantics", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${TASKS}/users/@me/lists`]: () => lists,
      [`PATCH ${TASKS}/lists/L1/tasks/t1`]: (c) => ({
        id: "t1",
        title: "x",
        ...(c.body as object),
      }),
    });
    const provider = new GoogleTasksProvider(CONN, http);
    const id = makeExternalRef(CONN.connectionId, "task", "L1", "t1");
    expect((await provider.complete(id)).status).toBe("completed");
    await provider.reopen(id);
    expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
      { status: "completed" },
      { status: "needsAction", completed: null },
    ]);
  });

  it("rejects what Google Tasks cannot store instead of silently dropping it", async () => {
    const { http } = fakeGoogle({});
    const provider = new GoogleTasksProvider(CONN, http);
    await expect(provider.create({ title: "x", priority: "high" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      provider.update({
        taskId: makeExternalRef(CONN.connectionId, "task", "L1", "t1"),
        status: "in_progress",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("filters open tasks and passes an exclusive dueMax", async () => {
    const { http, calls } = fakeGoogle({
      [`GET ${TASKS}/users/@me/lists`]: () => lists,
      [`GET ${TASKS}/lists/L1/tasks`]: () => ({
        items: [
          { id: "a", title: "Open", status: "needsAction", due: "2026-09-30T00:00:00.000Z" },
          { id: "b", title: "Done", status: "completed" },
        ],
      }),
    });
    const tasks = await new GoogleTasksProvider(CONN, http).list({
      status: "open",
      dueFrom: "2026-09-30",
      dueTo: "2026-09-30",
      limit: 20,
    });
    expect(tasks.map((t) => t.title)).toEqual(["Open"]);
    const url = calls.find((c) => c.url.includes("/tasks?"))!.url;
    expect(url).toContain("dueMax=2026-10-01T00%3A00%3A00.000Z");
    expect(url).toContain("showCompleted=false");
  });
});
