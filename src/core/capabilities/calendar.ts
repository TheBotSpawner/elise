import { z } from "zod";

import { destinationField } from "../providers/destination";
import type { ProviderKey } from "../providers/types";
import {
  addDays,
  isIsoDate,
  isLocalDateTime,
  startOfDayUtc,
  toLocalDateTime,
  zonedDateTimeToUtc,
} from "../time";

/** Canonical Calendar model. Google Calendar (and future providers) map into this. */
export interface CalendarProvenance {
  providerKey: ProviderKey;
  connectionId: string;
  externalId: string;
  /** User-facing account name ("Personal", "Acme"). */
  source: string;
}

export interface CalendarInfo {
  /** Canonical id to pass back as `calendar`. */
  id: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
  timezone: string | null;
  provenance: CalendarProvenance;
}

export interface Attendee {
  email: string;
  name: string | null;
  response: "accepted" | "declined" | "tentative" | "needsAction" | null;
  self: boolean;
  organizer: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  title: string;
  description: string | null;
  location: string | null;
  /** RFC 3339 instant for timed events; YYYY-MM-DD for all-day events. */
  start: string;
  /** Exclusive end (RFC 3339 instant or YYYY-MM-DD). */
  end: string;
  allDay: boolean;
  attendees: Attendee[];
  status: "confirmed" | "tentative" | "cancelled";
  url: string | null;
  /** Video-call link (Meet, Zoom, Teams…), when the event has one. */
  meetingUrl?: string | null;
  provenance: CalendarProvenance;
}

const MEETING_LINK =
  /https:\/\/(?:meet\.google\.com|[\w-]+\.zoom\.us|zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w-]+\.webex\.com|whereby\.com)\/[^\s<>"')\]]+/i;

/** The call link: the provider's own field, else the first known video link in the text. */
export function findMeetingUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t?.match(MEETING_LINK);
    if (m) return m[0];
  }
  return null;
}

export type EventTime = { kind: "dateTime"; local: string } | { kind: "date"; date: string };

export interface EventQuery {
  timeMin: Date;
  timeMax: Date;
  /** Canonical calendar ids; omitted = the calendars the user shows in their calendar app. */
  calendarIds?: string[];
  search?: string;
  limit: number;
}

export interface BusyBlock {
  start: Date;
  end: Date;
  source: string;
}

export interface NewEvent {
  title: string;
  start: EventTime;
  end: EventTime;
  /** IANA timezone the local times are expressed in. */
  timezone: string;
  calendarId?: string;
  attendees: string[];
  location?: string;
  description?: string;
}

export interface EventPatch {
  title?: string;
  start?: EventTime;
  end?: EventTime;
  timezone: string;
  attendees?: string[];
  location?: string | null;
  description?: string | null;
}

/** Contract every Calendar provider implements. */
export interface CalendarProvider {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(query: EventQuery): Promise<CalendarEvent[]>;
  busy(query: { timeMin: Date; timeMax: Date }): Promise<BusyBlock[]>;
  getEvent(eventId: string): Promise<CalendarEvent | null>;
  /** `idempotencyKey` lets providers that support it make retries safe. */
  createEvent(event: NewEvent, meta: { idempotencyKey: string | null }): Promise<CalendarEvent>;
  updateEvent(eventId: string, patch: EventPatch): Promise<CalendarEvent>;
  deleteEvent(eventId: string): Promise<CalendarEvent>;
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const date = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
const localDateTime = z.string().refine(isLocalDateTime, "Expected local time YYYY-MM-DDTHH:mm");
const when = z
  .string()
  .refine(
    (v) => isIsoDate(v) || isLocalDateTime(v),
    "Expected YYYY-MM-DD or local YYYY-MM-DDTHH:mm (user's timezone)",
  );
const ref = z.string().trim().min(1).max(1000);
const email = z.email().max(320);

export const listCalendarsInput = z.object({ destination: destinationField }).strict();

export const listEventsInput = z
  .object({
    from: when.describe(
      'Start (user\'s local time). A date means the whole day. "Esta semana" starts on Monday.',
    ),
    to: when
      .optional()
      .describe(
        "End (a date is inclusive; exclusive for times). Defaults to the end of the `from` day.",
      ),
    calendar: ref
      .optional()
      .describe("Calendar id from calendar.listCalendars. Omit for all visible calendars."),
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(250).default(50),
    destination: destinationField,
  })
  .strict();

export const findAvailabilityInput = z
  .object({
    from: when.describe("Window start (user's local time). A date means from 00:00."),
    to: when.optional().describe("Window end. Defaults to the end of the `from` day."),
    minDurationMinutes: z.number().int().min(5).max(1440).default(30),
    destination: destinationField,
  })
  .strict();

export const createEventInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    start: z
      .union([localDateTime, date])
      .describe(
        "Local start YYYY-MM-DDTHH:mm in the user's timezone, or YYYY-MM-DD for an all-day event.",
      ),
    end: z
      .union([localDateTime, date])
      .optional()
      .describe("Local end. Omit to use durationMinutes."),
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .optional()
      .describe("Defaults to 60 for timed events."),
    calendar: ref
      .optional()
      .describe("Calendar id from calendar.listCalendars, if not the default calendar."),
    attendees: z
      .array(email)
      .max(50)
      .optional()
      .describe("Only people the user explicitly asked to invite."),
    location: z.string().trim().max(500).optional(),
    description: z.string().trim().max(5000).optional(),
    destination: destinationField,
  })
  .strict();

export const updateEventInput = z
  .object({
    eventId: ref,
    title: z.string().trim().min(1).max(300).optional(),
    start: z.union([localDateTime, date]).optional(),
    end: z.union([localDateTime, date]).optional(),
    attendees: z.array(email).max(50).optional(),
    location: z.string().trim().max(500).nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();

export const eventIdInput = z.object({ eventId: ref }).strict();

export type ListEventsInput = z.infer<typeof listEventsInput>;
export type CreateEventInput = z.infer<typeof createEventInput>;
export type UpdateEventInput = z.infer<typeof updateEventInput>;

// ── Deterministic time handling ──────────────────────────────────────────────

/** A local date or date-time window → UTC instants. Dates cover whole days in `timezone`. */
export function resolveRange(
  from: string,
  to: string | undefined,
  timezone: string,
): { timeMin: Date; timeMax: Date } {
  const start = isIsoDate(from)
    ? startOfDayUtc(from, timezone)
    : zonedDateTimeToUtc(from, timezone);
  let end: Date;
  if (!to) end = startOfDayUtc(addDays(from.slice(0, 10), 1), timezone);
  else if (isIsoDate(to)) end = startOfDayUtc(addDays(to, 1), timezone);
  else end = zonedDateTimeToUtc(to, timezone);
  if (end <= start) throw new RangeError("The end must be after the start");
  return { timeMin: start, timeMax: end };
}

export function toEventTime(value: string): EventTime {
  return isIsoDate(value)
    ? { kind: "date", date: value }
    : { kind: "dateTime", local: value.slice(0, 16) };
}

/** Start/end for a new event; timed events default to 60 minutes, all-day to one day. */
export function resolveEventTimes(
  start: string,
  end: string | undefined,
  durationMinutes: number | undefined,
  timezone: string,
): { start: EventTime; end: EventTime } {
  const s = toEventTime(start);
  if (s.kind === "date") {
    const e = end && isIsoDate(end) ? end : addDays(s.date, 1);
    if (e <= s.date) throw new RangeError("An all-day event must end after it starts");
    return { start: s, end: { kind: "date", date: e } };
  }
  if (end) {
    const e = toEventTime(end);
    if (e.kind !== "dateTime") throw new RangeError("A timed event needs a timed end");
    if (zonedDateTimeToUtc(e.local, timezone) <= zonedDateTimeToUtc(s.local, timezone)) {
      throw new RangeError("The event must end after it starts");
    }
    return { start: s, end: e };
  }
  const startUtc = zonedDateTimeToUtc(s.local, timezone);
  const endUtc = new Date(startUtc.getTime() + (durationMinutes ?? 60) * 60000);
  return { start: s, end: { kind: "dateTime", local: toLocalDateTime(endUtc, timezone) } };
}

/**
 * Free time inside a window given busy blocks from any number of calendars/accounts.
 * Calendar data is authoritative for occupied time; this never asks the model to compute it.
 */
export function freeSlots(
  busy: readonly { start: Date; end: Date }[],
  window: { timeMin: Date; timeMax: Date },
  minDurationMinutes: number,
): { start: Date; end: Date }[] {
  const blocks = busy
    .map((b) => ({
      start: Math.max(b.start.getTime(), window.timeMin.getTime()),
      end: Math.min(b.end.getTime(), window.timeMax.getTime()),
    }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  const slots: { start: Date; end: Date }[] = [];
  let cursor = window.timeMin.getTime();
  for (const b of blocks) {
    if (b.start - cursor >= minDurationMinutes * 60000)
      slots.push({ start: new Date(cursor), end: new Date(b.start) });
    cursor = Math.max(cursor, b.end);
  }
  if (window.timeMax.getTime() - cursor >= minDurationMinutes * 60000) {
    slots.push({ start: new Date(cursor), end: window.timeMax });
  }
  return slots;
}

/** Events that overlap a given interval (conflict detection). */
export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && b.start < a.end;
}
