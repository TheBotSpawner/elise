import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import {
  createEventInput,
  eventIdInput,
  findAvailabilityInput,
  freeSlots,
  listCalendarsInput,
  listEventsInput,
  overlaps,
  resolveEventTimes,
  resolveRange,
  toEventTime,
  updateEventInput,
  type BusyBlock,
  type CalendarEvent,
  type CalendarInfo,
  type EventTime,
} from "../capabilities/calendar";
import { AppError } from "../errors";
import { parseExternalRef } from "../providers/refs";
import { toLocalDateTime, zonedDateTimeToUtc } from "../time";

function provider(env: ToolRunEnv) {
  return env.providers.get("calendar", env.binding);
}

/** Deterministic date errors become validation errors the model can fix. */
function withRange<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AppError("VALIDATION_ERROR", error.message, { recovery: "review" });
    }
    throw error;
  }
}

function local(value: string, timezone: string): string {
  return value.length === 10 ? value : toLocalDateTime(new Date(value), timezone);
}

/** Compact, timezone-resolved event view for the model. */
function forModel(event: CalendarEvent, timezone: string) {
  const others = event.attendees.filter((a) => !a.self);
  return {
    id: event.id,
    title: event.title,
    start: local(event.start, timezone),
    end: local(event.end, timezone),
    allDay: event.allDay,
    calendar: event.calendarName,
    source: event.provenance.source,
    ...(event.location ? { location: event.location } : {}),
    ...(others.length ? { attendees: others.map((a) => a.name ?? a.email) } : {}),
    ...(event.status !== "confirmed" ? { status: event.status } : {}),
  };
}

function calendarForModel(c: CalendarInfo) {
  return {
    id: c.id,
    name: c.name,
    primary: c.primary,
    canWrite: c.canWrite,
    source: c.provenance.source,
  };
}

function eventTimeToUtc(t: EventTime, timezone: string): Date {
  return t.kind === "date"
    ? zonedDateTimeToUtc(`${t.date}T00:00`, timezone)
    : zonedDateTimeToUtc(t.local, timezone);
}

function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => a.start.localeCompare(b.start));
}

/** Existing events and explicit calendars live in the account their id names. */
function routeByRef(ref: string | undefined) {
  if (!ref) return null;
  const parsed = parseExternalRef(ref);
  if (!parsed)
    throw new AppError("VALIDATION_ERROR", "Unknown calendar or event id", { recovery: "review" });
  return { connectionId: parsed.connectionId };
}

function describeWhen(start: EventTime, end: EventTime, timezone: string, locale: string): string {
  if (start.kind === "date") {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${start.date}T00:00:00Z`));
  }
  const s = eventTimeToUtc(start, timezone);
  const e = eventTimeToUtc(end, timezone);
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  }).format(s);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  return `${day} ${time.format(s)}–${time.format(e)}`;
}

/** Inviting or notifying other people is external communication: always ask (docs/architecture/15 §14). */
const EXTERNAL = {
  kind: "external_communication",
  risk: "high",
  defaultApproval: "always_ask",
} as const;

export const listCalendarsTool: ToolDefinition = {
  name: "calendar.listCalendars",
  capability: "calendar",
  operation: "listCalendars",
  description:
    "List the user's calendars across connected accounts (name, account, whether ELISE can add events).",
  input: listCalendarsInput,
  async describe() {
    return { summary: "List calendars" };
  },
  async run(_input, env) {
    const calendars = await provider(env).listCalendars();
    return {
      output: { calendars: calendars.map(calendarForModel) },
      display: { kind: "calendars", calendars },
    };
  },
  merge(results) {
    const calendars = results.flatMap(({ result }) =>
      result.display?.kind === "calendars" ? result.display.calendars : [],
    );
    return {
      output: { calendars: calendars.map(calendarForModel) },
      display: { kind: "calendars", calendars },
    };
  },
};

export const listEventsTool: ToolDefinition = {
  name: "calendar.listEvents",
  capability: "calendar",
  operation: "listEvents",
  description:
    "List calendar events in a date/time range (user's local time) across the user's visible calendars, or one calendar. Use for agendas, \"what do I have tomorrow\", meetings and conflicts.",
  input: listEventsInput,
  route: (input) => routeByRef(listEventsInput.parse(input).calendar),
  async describe() {
    return { summary: "List events" };
  },
  async run(input, env) {
    const q = listEventsInput.parse(input);
    const range = withRange(() => resolveRange(q.from, q.to, env.ctx.timezone));
    const events = await provider(env).listEvents({
      ...range,
      calendarIds: q.calendar ? [q.calendar] : undefined,
      search: q.search,
      limit: q.limit,
    });
    return eventsResult(events, range, env.ctx.timezone, q.limit);
  },
  merge(results, input, ctx) {
    const q = listEventsInput.parse(input);
    const range = resolveRange(q.from, q.to, ctx.timezone);
    const events = results.flatMap(({ result }) =>
      result.display?.kind === "event_list" ? result.display.events : [],
    );
    return eventsResult(events, range, ctx.timezone, q.limit);
  },
};

function eventsResult(
  events: CalendarEvent[],
  range: { timeMin: Date; timeMax: Date },
  timezone: string,
  limit: number,
): ToolRunResult<unknown> {
  const sorted = sortEvents(events).slice(0, limit);
  return {
    output: {
      from: toLocalDateTime(range.timeMin, timezone),
      to: toLocalDateTime(range.timeMax, timezone),
      count: sorted.length,
      events: sorted.map((e) => forModel(e, timezone)),
    },
    display: {
      kind: "event_list",
      events: sorted,
      from: range.timeMin.toISOString(),
      to: range.timeMax.toISOString(),
      // A read that hit its limit may have left events out: never a complete range.
      complete: events.length < limit,
    },
  };
}

export const findAvailabilityTool: ToolDefinition = {
  name: "calendar.findAvailability",
  capability: "calendar",
  operation: "findAvailability",
  description:
    'Find free time and busy blocks in a window across all the user\'s calendars. Use to answer "am I free…" and before proposing times.',
  input: findAvailabilityInput,
  async describe() {
    return { summary: "Check availability" };
  },
  async run(input, env) {
    const q = findAvailabilityInput.parse(input);
    const range = withRange(() => resolveRange(q.from, q.to, env.ctx.timezone));
    const busy = await provider(env).busy(range);
    return availabilityResult(busy, range, q.minDurationMinutes, env.ctx.timezone);
  },
  merge(results, input, ctx) {
    const q = findAvailabilityInput.parse(input);
    const range = resolveRange(q.from, q.to, ctx.timezone);
    const busy = results.flatMap(({ result }) =>
      result.display?.kind === "availability"
        ? result.display.busy.map((b) => ({
            start: new Date(b.start),
            end: new Date(b.end),
            source: b.source,
          }))
        : [],
    );
    return availabilityResult(busy, range, q.minDurationMinutes, ctx.timezone);
  },
};

function availabilityResult(
  busy: BusyBlock[],
  range: { timeMin: Date; timeMax: Date },
  minDurationMinutes: number,
  timezone: string,
): ToolRunResult<unknown> {
  const free = freeSlots(busy, range, minDurationMinutes);
  const sortedBusy = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    output: {
      from: toLocalDateTime(range.timeMin, timezone),
      to: toLocalDateTime(range.timeMax, timezone),
      free: free.map((s) => ({
        start: toLocalDateTime(s.start, timezone),
        end: toLocalDateTime(s.end, timezone),
      })),
      busy: sortedBusy.map((b) => ({
        start: toLocalDateTime(b.start, timezone),
        end: toLocalDateTime(b.end, timezone),
        source: b.source,
      })),
    },
    display: {
      kind: "availability",
      from: range.timeMin.toISOString(),
      to: range.timeMax.toISOString(),
      free: free.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
      busy: sortedBusy.map((b) => ({
        start: b.start.toISOString(),
        end: b.end.toISOString(),
        source: b.source,
      })),
    },
  };
}

export const createEventTool: ToolDefinition = {
  name: "calendar.createEvent",
  capability: "calendar",
  operation: "createEvent",
  description:
    "Create a calendar event. Times are local (YYYY-MM-DDTHH:mm) in the user's timezone; use a date for all-day events. Only add attendees the user explicitly named — inviting people requires the user's approval. Set `destination` or `calendar` only when the user says which account or calendar.",
  input: createEventInput,
  route: (input) => routeByRef(createEventInput.parse(input).calendar),
  async assess(input) {
    return createEventInput.parse(input).attendees?.length ? EXTERNAL : null;
  },
  async describe(input, env) {
    const e = createEventInput.parse(input);
    const times = withRange(() =>
      resolveEventTimes(e.start, e.end, e.durationMinutes, env.ctx.timezone),
    );
    const who = e.attendees?.length ? ` · ${e.attendees.join(", ")}` : "";
    return {
      summary: `Create “${e.title}” · ${describeWhen(times.start, times.end, env.ctx.timezone, env.ctx.locale)}${who} · ${env.binding.label}`,
    };
  },
  async run(input, env) {
    const e = createEventInput.parse(input);
    const tz = env.ctx.timezone;
    const times = withRange(() => resolveEventTimes(e.start, e.end, e.durationMinutes, tz));
    const cal = provider(env);
    const event = await cal.createEvent(
      {
        title: e.title,
        ...times,
        timezone: tz,
        calendarId: e.calendar,
        attendees: e.attendees ?? [],
        location: e.location,
        description: e.description,
      },
      { idempotencyKey: env.actionId ?? null },
    );
    // Conflicts are reported, not blocked: the user decided to book this time.
    const span = { start: eventTimeToUtc(times.start, tz), end: eventTimeToUtc(times.end, tz) };
    const conflicts =
      times.start.kind === "dateTime"
        ? (await cal.busy({ timeMin: span.start, timeMax: span.end }).catch(() => [])).filter(
            (b) =>
              overlaps(b, span) &&
              !(
                b.start.getTime() === span.start.getTime() && b.end.getTime() === span.end.getTime()
              ),
          )
        : [];
    return {
      output: {
        created: forModel(event, tz),
        ...(conflicts.length ? { overlapsWith: conflicts.length } : {}),
      },
      display: { kind: "event", event, change: "created" },
      target: { type: "calendar_event", id: event.id },
    };
  },
};

export const updateEventTool: ToolDefinition = {
  name: "calendar.updateEvent",
  capability: "calendar",
  operation: "updateEvent",
  description:
    "Change an existing event (title, local start/end, location, description, attendees). Find the event id with calendar.listEvents first. Changing an event with other people needs approval.",
  input: updateEventInput,
  route: (input) => routeByRef(updateEventInput.parse(input).eventId),
  async assess(input, env) {
    const u = updateEventInput.parse(input);
    if (u.attendees?.length) return EXTERNAL;
    const existing = await provider(env).getEvent(u.eventId);
    return existing?.attendees.some((a) => !a.self) ? EXTERNAL : null;
  },
  async describe(input, env) {
    const u = updateEventInput.parse(input);
    const existing = await provider(env).getEvent(u.eventId);
    if (!existing) throw new AppError("NOT_FOUND", "Event not found", { recovery: "review" });
    return {
      summary: `Update “${existing.title}” (${existing.provenance.source})`,
      target: { type: "calendar_event", id: u.eventId },
    };
  },
  async run(input, env) {
    const u = updateEventInput.parse(input);
    const tz = env.ctx.timezone;
    if (u.start && u.end) withRange(() => resolveEventTimes(u.start!, u.end, undefined, tz));
    const event = await provider(env).updateEvent(u.eventId, {
      title: u.title,
      start: u.start ? toEventTime(u.start) : undefined,
      end: u.end ? toEventTime(u.end) : undefined,
      timezone: tz,
      attendees: u.attendees,
      location: u.location,
      description: u.description,
    });
    return {
      output: { updated: forModel(event, tz) },
      display: { kind: "event", event, change: "updated" },
      target: { type: "calendar_event", id: event.id },
    };
  },
};

export const deleteEventTool: ToolDefinition = {
  name: "calendar.deleteEvent",
  capability: "calendar",
  operation: "deleteEvent",
  description:
    "Delete a calendar event. Always requires the user's approval; say it is waiting for approval and never claim it was deleted before confirmation.",
  input: eventIdInput,
  route: (input) => routeByRef(eventIdInput.parse(input).eventId),
  async describe(input, env) {
    const { eventId } = eventIdInput.parse(input);
    const existing = await provider(env).getEvent(eventId);
    if (!existing) throw new AppError("NOT_FOUND", "Event not found", { recovery: "review" });
    const when = describeWhen(
      toEventTime(local(existing.start, env.ctx.timezone)),
      toEventTime(local(existing.end, env.ctx.timezone)),
      env.ctx.timezone,
      env.ctx.locale,
    );
    return {
      summary: `Delete “${existing.title}” · ${when} (${existing.provenance.source})`,
      target: { type: "calendar_event", id: eventId },
    };
  },
  async run(input, env) {
    const { eventId } = eventIdInput.parse(input);
    const event = await provider(env).deleteEvent(eventId);
    return {
      output: { deleted: { id: event.id, title: event.title } },
      display: { kind: "event", event, change: "deleted" },
      target: { type: "calendar_event", id: event.id },
    };
  },
};

export const CALENDAR_TOOLS = [
  listCalendarsTool,
  listEventsTool,
  findAvailabilityTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
];
