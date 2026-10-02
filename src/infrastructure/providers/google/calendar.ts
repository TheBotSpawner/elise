import { createHash } from "node:crypto";

import type {
  Attendee,
  BusyBlock,
  CalendarEvent,
  CalendarInfo,
  CalendarProvider,
  EventPatch,
  EventQuery,
  EventTime,
  NewEvent,
} from "@/core/capabilities/calendar";
import { findMeetingUrl } from "@/core/capabilities/calendar";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";

import type { GoogleHttp } from "./http";

const API = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDARS = 20;

export interface GoogleConnectionInfo {
  connectionId: string;
  /** User-facing account name ("Personal", "Acme"). */
  label: string;
  /** Calendar used for new events when none is named (binding configuration). */
  defaultCalendarId?: string | null;
}

// ── Google API shapes (only the fields we use) ───────────────────────────────

export interface GCalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  timeZone?: string;
}

export interface GEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: {
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
  }[];
}

// ── Normalization ────────────────────────────────────────────────────────────

export function normalizeCalendar(
  entry: GCalendarListEntry,
  conn: GoogleConnectionInfo,
): CalendarInfo {
  return {
    id: makeExternalRef(conn.connectionId, "cal", entry.id),
    name: entry.summaryOverride ?? entry.summary ?? entry.id,
    primary: Boolean(entry.primary),
    canWrite: entry.accessRole === "owner" || entry.accessRole === "writer",
    timezone: entry.timeZone ?? null,
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: entry.id,
      source: conn.label,
    },
  };
}

const RESPONSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

export function normalizeEvent(
  event: GEvent,
  calendarId: string,
  calendarName: string,
  conn: GoogleConnectionInfo,
): CalendarEvent {
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const attendees: Attendee[] = (event.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({
      email: a.email!,
      name: a.displayName ?? null,
      response:
        a.responseStatus && RESPONSES.has(a.responseStatus)
          ? (a.responseStatus as Attendee["response"])
          : null,
      self: Boolean(a.self),
      organizer: Boolean(a.organizer),
    }));
  return {
    id: makeExternalRef(conn.connectionId, "evt", calendarId, event.id),
    calendarId: makeExternalRef(conn.connectionId, "cal", calendarId),
    calendarName,
    title: event.summary?.trim() || "(no title)",
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    allDay,
    attendees,
    status: event.status ?? "confirmed",
    url: event.htmlLink ?? null,
    meetingUrl:
      event.hangoutLink ??
      event.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ??
      findMeetingUrl(event.location, event.description),
    provenance: {
      providerKey: "google",
      connectionId: conn.connectionId,
      externalId: event.id,
      source: conn.label,
    },
  };
}

export function toGoogleTime(
  time: EventTime,
  timezone: string,
): { dateTime?: string; date?: string; timeZone?: string } {
  return time.kind === "date"
    ? { date: time.date }
    : { dateTime: `${time.local}:00`, timeZone: timezone };
}

/** Google accepts client-chosen event ids (base32hex, 5–1024 chars): a retry of the same action is a no-op. */
export function idempotentEventId(key: string): string {
  return createHash("sha256").update(`elise:${key}`).digest("hex");
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class GoogleCalendarProvider implements CalendarProvider {
  private calendars: Promise<GCalendarListEntry[]> | null = null;

  constructor(
    private readonly conn: GoogleConnectionInfo,
    private readonly http: GoogleHttp,
  ) {}

  private calendarList(): Promise<GCalendarListEntry[]> {
    this.calendars ??= this.http
      .request<{ items?: GCalendarListEntry[] }>(
        "GET",
        `${API}/users/me/calendarList?maxResults=250`,
      )
      .then((r) => r?.items ?? []);
    return this.calendars;
  }

  /** Calendars the user shows in Google Calendar (primary is always included). */
  private async visibleCalendars(): Promise<GCalendarListEntry[]> {
    return (await this.calendarList())
      .filter((c) => c.primary || (c.selected && !c.hidden))
      .slice(0, MAX_CALENDARS);
  }

  /** Validates that a canonical calendar/event id belongs to this connection. */
  private parse(ref: string, kind: "cal" | "evt"): string[] {
    const parsed = parseExternalRef(ref);
    if (!parsed || parsed.connectionId !== this.conn.connectionId || parsed.parts[0] !== kind) {
      throw new AppError(
        "VALIDATION_ERROR",
        `That ${kind === "cal" ? "calendar" : "event"} does not belong to this account`,
        {
          recovery: "review",
        },
      );
    }
    return parsed.parts.slice(1);
  }

  private async calendarName(calendarId: string): Promise<string> {
    const entry = (await this.calendarList()).find((c) => c.id === calendarId);
    return entry ? (entry.summaryOverride ?? entry.summary ?? calendarId) : calendarId;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return (await this.calendarList())
      .filter((c) => !c.hidden)
      .map((c) => normalizeCalendar(c, this.conn));
  }

  async listEvents(query: EventQuery): Promise<CalendarEvent[]> {
    const targets = query.calendarIds?.length
      ? await Promise.all(
          query.calendarIds.map(async (ref) => {
            const [id] = this.parse(ref, "cal");
            return { id: id!, name: await this.calendarName(id!) };
          }),
        )
      : (await this.visibleCalendars()).map((c) => ({
          id: c.id,
          name: c.summaryOverride ?? c.summary ?? c.id,
        }));

    const perCalendar = await Promise.all(
      targets.map(async (cal) => {
        const params = new URLSearchParams({
          timeMin: query.timeMin.toISOString(),
          timeMax: query.timeMax.toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: String(Math.min(query.limit, 250)),
        });
        if (query.search) params.set("q", query.search);
        const res = await this.http.request<{ items?: GEvent[] }>(
          "GET",
          `${API}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
        );
        return (res?.items ?? [])
          .filter((e) => e.status !== "cancelled")
          .map((e) => normalizeEvent(e, cal.id, cal.name, this.conn));
      }),
    );
    return perCalendar
      .flat()
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, query.limit);
  }

  async busy(query: { timeMin: Date; timeMax: Date }): Promise<BusyBlock[]> {
    const calendars = await this.visibleCalendars();
    const res = await this.http.request<{
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
    }>("POST", `${API}/freeBusy`, {
      timeMin: query.timeMin.toISOString(),
      timeMax: query.timeMax.toISOString(),
      items: calendars.map((c) => ({ id: c.id })),
    });
    return Object.values(res?.calendars ?? {}).flatMap((c) =>
      (c.busy ?? []).map((b) => ({
        start: new Date(b.start),
        end: new Date(b.end),
        source: this.conn.label,
      })),
    );
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    const [calendarId, id] = this.parse(eventId, "evt");
    const event = await this.http.request<GEvent>(
      "GET",
      `${API}/calendars/${encodeURIComponent(calendarId!)}/events/${encodeURIComponent(id!)}`,
      undefined,
      { notFoundAsNull: true },
    );
    if (!event || event.status === "cancelled") return null;
    return normalizeEvent(event, calendarId!, await this.calendarName(calendarId!), this.conn);
  }

  async createEvent(
    event: NewEvent,
    meta: { idempotencyKey: string | null },
  ): Promise<CalendarEvent> {
    const calendarId = event.calendarId
      ? this.parse(event.calendarId, "cal")[0]!
      : (this.conn.defaultCalendarId ?? "primary");
    const body = {
      ...(meta.idempotencyKey ? { id: idempotentEventId(meta.idempotencyKey) } : {}),
      summary: event.title,
      description: event.description,
      location: event.location,
      start: toGoogleTime(event.start, event.timezone),
      end: toGoogleTime(event.end, event.timezone),
      attendees: event.attendees.length ? event.attendees.map((email) => ({ email })) : undefined,
    };
    const sendUpdates = event.attendees.length ? "all" : "none";
    const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`;
    try {
      const created = await this.http.request<GEvent>("POST", url, body);
      return normalizeEvent(created!, calendarId, await this.calendarName(calendarId), this.conn);
    } catch (error) {
      // Same action retried: the event already exists with our deterministic id — return it.
      if (error instanceof AppError && error.code === "CONFLICT" && body.id) {
        const existing = await this.getEvent(
          makeExternalRef(this.conn.connectionId, "evt", calendarId, body.id),
        );
        if (existing) return existing;
      }
      throw error;
    }
  }

  async updateEvent(eventId: string, patch: EventPatch): Promise<CalendarEvent> {
    const [calendarId, id] = this.parse(eventId, "evt");
    const current = await this.getEvent(eventId);
    if (!current)
      throw new AppError("NOT_FOUND", "That event no longer exists", { recovery: "review" });
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.start) body.start = toGoogleTime(patch.start, patch.timezone);
    if (patch.end) body.end = toGoogleTime(patch.end, patch.timezone);
    if (patch.attendees) body.attendees = patch.attendees.map((email) => ({ email }));
    const notify = current.attendees.some((a) => !a.self) || Boolean(patch.attendees?.length);
    const updated = await this.http.request<GEvent>(
      "PATCH",
      `${API}/calendars/${encodeURIComponent(calendarId!)}/events/${encodeURIComponent(id!)}?sendUpdates=${notify ? "all" : "none"}`,
      body,
    );
    return normalizeEvent(updated!, calendarId!, current.calendarName, this.conn);
  }

  async deleteEvent(eventId: string): Promise<CalendarEvent> {
    const [calendarId, id] = this.parse(eventId, "evt");
    const current = await this.getEvent(eventId);
    if (!current)
      throw new AppError("NOT_FOUND", "That event no longer exists", { recovery: "review" });
    const notify = current.attendees.some((a) => !a.self);
    await this.http.request(
      "DELETE",
      `${API}/calendars/${encodeURIComponent(calendarId!)}/events/${encodeURIComponent(id!)}?sendUpdates=${notify ? "all" : "none"}`,
    );
    return current;
  }
}
