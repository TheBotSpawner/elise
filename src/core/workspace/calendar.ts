import { isSafeHref } from "./model";
import type { CalendarEvent } from "../capabilities/calendar";
import { addDays, isIsoDate, toLocalDateTime } from "../time";

/**
 * The Calendar Surface (ADR-033): calendar data looks like a calendar. One Surface per calendar
 * dataset (a range of events from the user's calendars) shown as Day, Week, Month, Year or
 * Agenda. The view, the date it is anchored to and the hidden calendars are presentation:
 * changing them never creates another Surface, and only a range that isn't loaded is read.
 * Everything here is pure and timezone-explicit (the user's timezone, never the server's).
 */

export const CALENDAR_VIEWS = ["day", "week", "month", "year", "agenda"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export interface CalendarItem {
  id: string;
  calendarId: string;
  calendarName: string;
  /** The account it comes from ("Personal", "Acme"). */
  account: string;
  title: string;
  /** RFC 3339 instant for timed events; YYYY-MM-DD for all-day ones (end exclusive). */
  start: string;
  end: string;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  location: string | null;
  description: string | null;
  meetingUrl: string | null;
  htmlUrl: string | null;
  attendees: number;
  /** A busy block from availability (no title: other calendars' details stay private). */
  busy?: boolean;
}

export type DayRange = { from: string; to: string };

/**
 * One Surface, two kinds of state (ADR-033 §range state). DATA: `events` (detailed, deduplicated
 * by provider event id), the ranges fully `loaded` for a calendar `scope`, and the year
 * `summary` (density, kept apart: it never replaces events). PRESENTATION: `view`, `anchor`,
 * `hidden`, and `seq`, which orders presentation changes so a late answer can't undo a newer one.
 */
export interface CalendarPayload {
  view: CalendarView;
  /** The date the view shows (its day, week, month or year); the same for every view. */
  anchor: string;
  /** The requested window, local dates [from, to): what Agenda lists. */
  range: DayRange;
  timezone: string;
  events: CalendarItem[];
  /** Calendar ids the user hid (filtering is presentation; provider data is untouched). */
  hidden: string[];
  /** Free windows to emphasize (availability), instants. */
  free: { start: string; end: string }[];
  truncated: boolean;
  /** Ranges read completely (never a truncated read). Absent in older snapshots: `range`. */
  loaded?: DayRange[];
  /** Which calendars the data was read for: "all", or one calendar id. */
  scope?: string;
  /** Events per day of one year (Year view), kept apart from the detailed events. */
  summary?: { year: string; counts: Record<string, number>; complete: boolean };
  /** Order of presentation changes (the newest wins). */
  seq?: number;
}

export const MAX_CALENDAR_EVENTS = 200;

// ── Dates ─────────────────────────────────────────────────────────────────────

const dayDiff = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
export const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));
const firstOfMonth = (date: string) => `${date.slice(0, 7)}-01`;
function addMonths(date: string, n: number): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n];
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (from: string, to: string) =>
  Array.from({ length: Math.max(0, dayDiff(from, to)) }, (_, i) => addDays(from, i));

/** The local dates a view shows, [from, to); agenda shows what is loaded. */
export function viewRange(
  view: CalendarView,
  anchor: string,
  loaded: { from: string; to: string },
): { from: string; to: string } {
  switch (view) {
    case "day":
      return { from: anchor, to: addDays(anchor, 1) };
    case "week":
      return { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 7) };
    case "month":
      return { from: firstOfMonth(anchor), to: addMonths(anchor, 1) };
    case "year":
      return { from: `${anchor.slice(0, 4)}-01-01`, to: `${Number(anchor.slice(0, 4)) + 1}-01-01` };
    case "agenda":
      return loaded;
  }
}

/** Previous / next in the view's own unit (agenda moves by its own length). */
export function shiftAnchor(
  view: CalendarView,
  anchor: string,
  dir: -1 | 1,
  loaded: { from: string; to: string },
): string {
  switch (view) {
    case "day":
      return addDays(anchor, dir);
    case "week":
      return addDays(anchor, 7 * dir);
    case "month":
      return addMonths(anchor, dir);
    case "year":
      return `${Number(anchor.slice(0, 4)) + dir}${anchor.slice(4)}`;
    case "agenda":
      return addDays(anchor, dir * Math.max(1, dayDiff(loaded.from, loaded.to)));
  }
}

/** The month grid: whole weeks (Monday first) covering the anchor's month. */
export function monthWeeks(anchor: string): string[][] {
  const first = firstOfMonth(anchor);
  const start = mondayOf(first);
  const end = addMonths(anchor, 1);
  const weeks: string[][] = [];
  for (let d = start; d < end; d = addDays(d, 7))
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

// ── Choosing the initial view (Representation Planner, ADR-033) ──────────────

/**
 * From the requested range and how many events it holds: a day → Day; up to a week → Week; a
 * calendar month → Month; a few weeks of "upcoming" → Agenda; a long range → Month or Agenda by
 * density; a year → Year. An explicit view (the user asked for one) wins.
 */
export function chooseView(input: {
  from: string;
  to: string;
  count: number;
  requested?: CalendarView | null;
}): CalendarView {
  if (input.requested) return input.requested;
  const days = dayDiff(input.from, input.to);
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  const wholeMonth = input.from.endsWith("-01") && input.to === addMonths(input.from, 1);
  if (wholeMonth) return "month";
  if (days >= 200) return "year";
  if (days <= 21) return "agenda";
  if (days <= 45) return input.count > 25 ? "month" : "agenda";
  return input.count > 40 ? "month" : "agenda";
}

// ── Building the payload ───────────────────────────────────────────────────────

const clip = (s: string | null | undefined, n: number) =>
  s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s;

export function calendarItem(e: CalendarEvent): CalendarItem {
  return {
    id: e.id,
    calendarId: e.calendarId,
    calendarName: clip(e.calendarName, 200) ?? "",
    account: clip(e.provenance.source, 200) ?? "",
    title: clip(e.title, 300) || "—",
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    status: e.status,
    location: clip(e.location, 300),
    description: clip(e.description, 400),
    // Only safe links reach the screen (a hostile invite can't plant javascript: links).
    meetingUrl: e.meetingUrl && isSafeHref(e.meetingUrl) ? e.meetingUrl : null,
    htmlUrl: e.url && isSafeHref(e.url) ? e.url : null,
    attendees: e.attendees.filter((a) => !a.self).length,
  };
}

/** A range of instants → the local dates it covers, [from, to). */
export function localRange(from: string, to: string, timezone: string) {
  const f = toLocalDateTime(new Date(from), timezone);
  const t = toLocalDateTime(new Date(to), timezone);
  return {
    from: f.slice(0, 10),
    to: t.slice(11, 16) === "00:00" ? t.slice(0, 10) : addDays(t.slice(0, 10), 1),
  };
}

export function calendarPayload(input: {
  events: CalendarEvent[];
  from: string;
  to: string;
  timezone: string;
  today: string;
  view?: CalendarView | null;
  free?: { start: string; end: string }[];
  busy?: { start: string; end: string; source: string }[];
  /** The read returned everything in the range (not cut at its limit). */
  complete?: boolean;
  scope?: string;
}): CalendarPayload {
  const range = localRange(input.from, input.to, input.timezone);
  const items = input.events
    .filter((e) => e.status !== "cancelled")
    .slice(0, MAX_CALENDAR_EVENTS)
    .map(calendarItem);
  const busy = (input.busy ?? []).slice(0, MAX_CALENDAR_EVENTS).map((b, i): CalendarItem => ({
    id: `busy:${i}`,
    calendarId: "busy",
    calendarName: "",
    account: clip(b.source, 200) ?? "",
    title: "",
    start: b.start,
    end: b.end,
    allDay: false,
    status: "confirmed",
    location: null,
    description: null,
    meetingUrl: null,
    htmlUrl: null,
    attendees: 0,
    busy: true,
  }));
  const view = chooseView({
    from: range.from,
    to: range.to,
    count: items.length,
    requested: input.view ?? null,
  });
  // The view opens on today when today is in the range, else on the range's start.
  const anchor = input.today >= range.from && input.today < range.to ? input.today : range.from;
  const complete = (input.complete ?? true) && input.events.length <= MAX_CALENDAR_EVENTS;
  const year = range.from.slice(0, 4);
  return {
    view,
    anchor,
    range,
    timezone: input.timezone,
    events: [...items, ...busy],
    hidden: [],
    free: (input.free ?? []).slice(0, 100),
    truncated: !complete,
    loaded: complete ? [range] : [],
    scope: input.scope ?? "all",
    ...(range.from === `${year}-01-01` && range.to === `${Number(year) + 1}-01-01`
      ? { summary: summaryOf(items, year, input.timezone, complete) }
      : {}),
    seq: 0,
  };
}

// ── Data state: the range cache (ADR-033 §range state) ────────────────────────

/** Ranges fully loaded (older snapshots: their range, unless truncated). */
export const loadedOf = (p: CalendarPayload): DayRange[] =>
  p.loaded ?? (p.truncated ? [] : [p.range]);

/** Sorted, merged union of day ranges. */
function union(ranges: readonly DayRange[]): DayRange[] {
  const out: DayRange[] = [];
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from.localeCompare(b.from));
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.from <= last.to) last.to = r.to > last.to ? r.to : last.to;
    else out.push({ ...r });
  }
  return out;
}

/** Is every day of `range` loaded for this calendar scope? */
export function isCovered(p: CalendarPayload, range: DayRange, scope = p.scope ?? "all") {
  if ((p.scope ?? "all") !== scope) return false;
  return union(loadedOf(p)).some((r) => r.from <= range.from && r.to >= range.to);
}

/** Events per local day of one year. */
function summaryOf(events: readonly CalendarItem[], year: string, tz: string, complete: boolean) {
  const counts: Record<string, number> = {};
  for (const [day, n] of yearDensity(
    events.filter((e) => !e.busy),
    year,
    tz,
  ))
    counts[day] = n;
  return { year, counts, complete };
}

/**
 * Merges a read into the data state. Inside a COMPLETE read's range the read is authoritative
 * (gone there = deleted there); outside it everything known is kept; a truncated read only adds
 * and never counts as loaded. Never clears what was known, never doubles an event (provider ids
 * name account, calendar and event). Then bounded: the events nearest the anchor are kept and
 * coverage shrinks to match, so a trimmed range is read again instead of looking empty.
 */
export function mergeFetched(
  p: CalendarPayload,
  read: { events: readonly (CalendarEvent | CalendarItem)[]; range: DayRange; complete: boolean },
): CalendarPayload {
  const tz = p.timezone;
  const fresh = read.events
    .map((e) => ("provenance" in e ? calendarItem(e) : e))
    .filter((e) => e.status !== "cancelled" && !e.busy);
  const ids = new Set(fresh.map((e) => e.id));
  const inRange = (e: CalendarItem) => {
    const span = localSpan(e, tz);
    return span.last >= read.range.from && span.first < read.range.to;
  };
  let events = [
    ...p.events.filter((e) => !e.busy && !ids.has(e.id) && !(read.complete && inRange(e))),
    ...fresh,
  ];
  let loaded = union([...loadedOf(p), ...(read.complete ? [read.range] : [])]);
  // The year's density, from the read that covered it, kept apart from the detailed events.
  const year = read.range.from.slice(0, 4);
  const wholeYear =
    read.range.from <= `${year}-01-01` && read.range.to >= `${Number(year) + 1}-01-01`;
  let summary = p.summary;
  if (wholeYear) summary = summaryOf(fresh, year, tz, read.complete);
  else if (summary && read.complete) {
    const counts = { ...summary.counts };
    const fill = summaryOf(fresh, summary.year, tz, true).counts;
    for (const d of daysBetween(read.range.from, read.range.to)) {
      delete counts[d];
      if (fill[d]) counts[d] = fill[d];
    }
    summary = { ...summary, counts };
  }
  if (events.length > MAX_CALENDAR_EVENTS) {
    // ponytail: nearest-to-anchor trimming; per-range eviction if the cap ever bites in practice.
    const anchorAt = Date.parse(`${p.anchor}T12:00:00Z`);
    const dist = (e: CalendarItem) =>
      Math.abs(Date.parse(`${localSpan(e, tz).first}T12:00:00Z`) - anchorAt);
    events = [...events].sort((a, b) => dist(a) - dist(b)).slice(0, MAX_CALENDAR_EVENTS);
    const days = events.map((e) => localSpan(e, tz).first).sort();
    // Days at the cut edges may have lost events: only days strictly inside stay "loaded".
    const window = { from: addDays(days[0]!, 1), to: days.at(-1)! };
    loaded = loaded
      .map((r) => ({
        from: r.from > window.from ? r.from : window.from,
        to: r.to < window.to ? r.to : window.to,
      }))
      .filter((r) => r.to > r.from);
  }
  return {
    ...p,
    events: [...events, ...p.events.filter((e) => e.busy)],
    loaded,
    truncated: !read.complete,
    ...(summary ? { summary } : {}),
  };
}

/** The one read that refreshes everything loaded (after a write): a range, never per event. */
export function refreshRange(p: CalendarPayload): DayRange {
  const all = union([...loadedOf(p), p.range, viewRange(p.view, p.anchor, p.range)]);
  return { from: all[0]!.from, to: all.at(-1)!.to };
}

/** A refreshed dataset keeps how the user is looking at it; its data merges into what's known. */
export function keepPresentation(fresh: CalendarPayload, old: CalendarPayload): CalendarPayload {
  return mergeFetched(old, {
    events: fresh.events,
    range: fresh.range,
    complete: !fresh.truncated,
  });
}

export interface CalendarChange {
  view?: CalendarView;
  anchor?: string;
  /** -1 previous, 1 next, 0 today. */
  shift?: -1 | 0 | 1;
  hidden?: string[];
}

/** Is a presentation change numbered `seq` newer than what is shown? */
export const presentationNewer = (p: CalendarPayload, seq: number) => seq > (p.seq ?? 0);

/**
 * The next presentation (one anchor for every view: Year → Week returns to the same week), and
 * the range to read when the view needs days that aren't loaded. Known events stay meanwhile:
 * loading is never shown as empty.
 */
export function navigate(
  p: CalendarPayload,
  change: CalendarChange,
  today: string,
  seq = (p.seq ?? 0) + 1,
): { payload: CalendarPayload; fetch: DayRange | null } {
  const view = change.view ?? p.view;
  const anchor =
    change.anchor && isIsoDate(change.anchor)
      ? change.anchor
      : change.shift === 0
        ? today
        : change.shift
          ? shiftAnchor(view, p.anchor, change.shift, p.range)
          : p.anchor;
  // Agenda moved in time lists a window of the same length from the new date.
  const range =
    view === "agenda" && change.shift
      ? { from: anchor, to: addDays(anchor, Math.max(1, dayDiff(p.range.from, p.range.to))) }
      : p.range;
  const needed = viewRange(view, anchor, range);
  return {
    payload: { ...p, view, anchor, range, hidden: change.hidden ?? p.hidden, seq },
    fetch: isCovered(p, needed) ? null : needed,
  };
}

/** A view never asks for less than it shows: the tool's default limit (50) cut years short. */
export const CALENDAR_READ_LIMIT = 250;

/** The calendar read for a range of days (the tool's `to` date is inclusive). */
export const rangeArgs = (range: DayRange, scope = "all") => ({
  from: range.from,
  to: addDays(range.to, -1),
  limit: CALENDAR_READ_LIMIT,
  ...(scope !== "all" ? { calendar: scope } : {}),
});

/**
 * The ONE path every calendar change takes — a click on "Año", "Ponelo en vista anual", a date
 * or a filter (ADR-033). The presentation is decided first; only missing days are read (one
 * range read); then it settles against the state AT THAT MOMENT: data always merges (a late
 * answer still enriches the cache), the presentation applies only if it's still the newest, and
 * a failed read keeps everything known.
 */
export async function changeCalendar(input: {
  current: () => CalendarPayload | null | Promise<CalendarPayload | null>;
  change: CalendarChange;
  today: string;
  seq: number;
  read: (args: ReturnType<typeof rangeArgs>) => Promise<{ status: string; display?: unknown }>;
}): Promise<{
  /** Applies this change to the state AS IT IS when writing (call it right before saving). */
  settle: (current: CalendarPayload) => {
    payload: CalendarPayload;
    query: { tool: string; args: Record<string, unknown> };
  };
  read: "none" | "done" | "failed";
} | null> {
  const start = await input.current();
  if (!start) return null;
  const { payload: wanted, fetch } = navigate(start, input.change, input.today, input.seq);
  const scope = start.scope ?? "all";
  let got: Parameters<typeof mergeFetched>[1] | null = null;
  let read: "none" | "done" | "failed" = "none";
  if (fetch) {
    const outcome = await input.read(rangeArgs(fetch, scope)).catch(() => null);
    const display = outcome?.status === "succeeded" ? outcome.display : null;
    const list = display as { kind?: string; events?: CalendarEvent[]; complete?: boolean } | null;
    if (list?.kind === "event_list" && list.events) {
      got = { events: list.events, range: fetch, complete: list.complete !== false };
      read = "done";
    } else read = "failed";
  }
  const settle = (latest: CalendarPayload) => {
    // Data always merges (a late answer still enriches what's known); the presentation applies
    // only if no newer choice was made meanwhile.
    const data = got && (latest.scope ?? "all") === scope ? mergeFetched(latest, got) : latest;
    const payload = presentationNewer(latest, input.seq)
      ? {
          ...data,
          view: wanted.view,
          anchor: wanted.anchor,
          range: wanted.range,
          hidden: wanted.hidden,
          seq: input.seq,
        }
      : data;
    return {
      payload,
      query: { tool: "calendar.listEvents", args: rangeArgs(refreshRange(payload), scope) },
    };
  };
  return { settle, read };
}

/** Presentation changes are numbered by when they were asked; later asks always win. */
export const nextSeq = (p: CalendarPayload, now = Date.now()) => Math.max((p.seq ?? 0) + 1, now);

// ── Placing events ─────────────────────────────────────────────────────────────

export interface LocalSpan {
  /** First and last local day the event touches (inclusive). */
  first: string;
  last: string;
  /** Minutes from midnight on the first / last day (timed events). */
  startMin: number;
  endMin: number;
}

/** Where an event falls in the user's days. All-day dates are never shifted by timezones. */
export function localSpan(
  e: Pick<CalendarItem, "start" | "end" | "allDay">,
  tz: string,
): LocalSpan {
  if (e.allDay || (isIsoDate(e.start) && isIsoDate(e.end))) {
    const last = e.end > e.start ? addDays(e.end, -1) : e.start;
    return { first: e.start, last, startMin: 0, endMin: 1440 };
  }
  const s = toLocalDateTime(new Date(e.start), tz);
  const en = toLocalDateTime(new Date(e.end), tz);
  const min = (v: string) => Number(v.slice(11, 13)) * 60 + Number(v.slice(14, 16));
  let last = en.slice(0, 10);
  let endMin = min(en);
  // Ending exactly at midnight belongs to the day before.
  if (endMin === 0 && last > s.slice(0, 10)) {
    last = addDays(last, -1);
    endMin = 1440;
  }
  return { first: s.slice(0, 10), last, startMin: min(s), endMin: Math.max(endMin, 0) };
}

export const touches = (span: LocalSpan, day: string) => span.first <= day && span.last >= day;

/** Shown in the all-day strip: all-day events (any length). */
const isAllDay = (e: CalendarItem) => e.allDay || (isIsoDate(e.start) && isIsoDate(e.end));

export interface TimedBlock {
  item: CalendarItem;
  /** Minutes from midnight, clipped to this day. */
  from: number;
  to: number;
  col: number;
  cols: number;
}

/**
 * One day's timed events, laid out like a calendar: overlapping events share the width
 * side by side (never drawn over each other), each in the first free column of its cluster.
 */
export function dayBlocks(events: readonly CalendarItem[], day: string, tz: string): TimedBlock[] {
  const items = events
    .filter((e) => !isAllDay(e))
    .map((item) => ({ item, span: localSpan(item, tz) }))
    .filter(({ span }) => touches(span, day))
    .map(({ item, span }) => ({
      item,
      from: span.first === day ? span.startMin : 0,
      to: Math.max(
        span.last === day ? span.endMin : 1440,
        (span.first === day ? span.startMin : 0) + 15,
      ),
    }))
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const out: TimedBlock[] = [];
  let cluster: TimedBlock[] = [];
  let clusterEnd = -1;
  const close = () => {
    const cols = Math.max(1, ...cluster.map((b) => b.col + 1));
    for (const b of cluster) b.cols = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const e of items) {
    if (e.from >= clusterEnd && cluster.length) close();
    const used = new Set(cluster.filter((b) => b.to > e.from).map((b) => b.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...e, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, e.to);
  }
  if (cluster.length) close();
  return out;
}

export interface AllDayBar {
  item: CalendarItem;
  /** Column indexes within the shown days (inclusive), and the lane it sits in. */
  start: number;
  end: number;
  lane: number;
  /** It started before / continues after the shown days. */
  before: boolean;
  after: boolean;
}

/** All-day (and multi-day) events across the shown days, packed into lanes as spanning bars. */
export function allDayBars(events: readonly CalendarItem[], days: readonly string[], tz: string) {
  if (!days.length) return [];
  const first = days[0]!;
  const last = days.at(-1)!;
  const bars = events
    .filter(isAllDay)
    .map((item) => ({ item, span: localSpan(item, tz) }))
    .filter(({ span }) => span.first <= last && span.last >= first)
    .map(({ item, span }) => ({
      item,
      start: Math.max(0, dayDiff(first, span.first)),
      end: Math.min(days.length - 1, dayDiff(first, span.last)),
      before: span.first < first,
      after: span.last > last,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const lanes: number[] = [];
  return bars.map((b): AllDayBar => {
    let lane = lanes.findIndex((end) => end < b.start);
    if (lane === -1) lane = lanes.push(b.end) - 1;
    else lanes[lane] = b.end;
    return { ...b, lane };
  });
}

/** Events touching a day (month cells), all-day first, then by time. */
export function eventsOn(events: readonly CalendarItem[], day: string, tz: string) {
  return events
    .map((item) => ({ item, span: localSpan(item, tz) }))
    .filter(({ span }) => touches(span, day))
    .sort(
      (a, b) =>
        Number(isAllDay(b.item)) - Number(isAllDay(a.item)) ||
        (a.span.first === day ? a.span.startMin : 0) - (b.span.first === day ? b.span.startMin : 0),
    )
    .map(({ item }) => item);
}

/** Agenda: each event once, under the date it starts (or the first shown day), in order. */
export function agendaGroups(
  events: readonly CalendarItem[],
  range: { from: string; to: string },
  tz: string,
): { day: string; items: { item: CalendarItem; span: LocalSpan }[] }[] {
  const groups = new Map<string, { item: CalendarItem; span: LocalSpan }[]>();
  const sorted = events
    .map((item) => ({ item, span: localSpan(item, tz) }))
    .filter(({ span }) => span.last >= range.from && span.first < range.to)
    .sort(
      (a, b) =>
        a.span.first.localeCompare(b.span.first) ||
        Number(isAllDay(b.item)) - Number(isAllDay(a.item)) ||
        a.span.startMin - b.span.startMin,
    );
  for (const e of sorted) {
    const day = e.span.first < range.from ? range.from : e.span.first;
    groups.set(day, [...(groups.get(day) ?? []), e]);
  }
  return [...groups].map(([day, items]) => ({ day, items }));
}

/** Year overview: events per day of each month (density, never 365 labels). */
export function yearDensity(events: readonly CalendarItem[], year: string, tz: string) {
  const counts = new Map<string, number>();
  for (const e of events) {
    const span = localSpan(e, tz);
    for (let d = span.first; d <= span.last && d.startsWith(year); d = addDays(d, 1))
      counts.set(d, (counts.get(d) ?? 0) + 1);
    if (!span.first.startsWith(year) && span.last.startsWith(year))
      for (let d = `${year}-01-01`; d <= span.last; d = addDays(d, 1))
        counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return counts;
}

/** Visible after the calendar filter. */
export const visibleEvents = (p: Pick<CalendarPayload, "events" | "hidden">) =>
  p.events.filter((e) => !p.hidden.includes(e.calendarId));

/** The calendars present, for the filter (busy blocks aren't a calendar). */
export function calendarsOf(events: readonly CalendarItem[]) {
  const seen = new Map<string, { id: string; name: string; account: string }>();
  for (const e of events)
    if (!e.busy && !seen.has(e.calendarId))
      seen.set(e.calendarId, { id: e.calendarId, name: e.calendarName, account: e.account });
  return [...seen.values()];
}

/** "Weekly Meeting, miércoles 7 de octubre, 10:00 a 10:30" — what a screen reader hears. */
export function eventLabel(e: CalendarItem, tz: string, locale: "es" | "en"): string {
  const span = localSpan(e, tz);
  const day = (d: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${d}T12:00:00Z`));
  const hm = (m: number) =>
    `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const title = e.busy ? (locale === "es" ? "Ocupado" : "Busy") : e.title;
  if (isAllDay(e))
    return span.first === span.last
      ? `${title}, ${day(span.first)}, ${locale === "es" ? "todo el día" : "all day"}`
      : `${title}, ${day(span.first)} – ${day(span.last)}`;
  const to = locale === "es" ? "a" : "to";
  return span.first === span.last
    ? `${title}, ${day(span.first)}, ${hm(span.startMin)} ${to} ${hm(span.endMin)}`
    : `${title}, ${day(span.first)} ${hm(span.startMin)} ${to} ${day(span.last)} ${hm(span.endMin)}`;
}
