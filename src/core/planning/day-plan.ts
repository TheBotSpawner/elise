import type { CalendarEvent } from "../capabilities/calendar";
import { addDays, toLocalDateTime, todayIn, zonedDateTimeToUtc } from "../time";

/**
 * A day's plan as a first-class result: time blocks proposed for one date in the user's
 * timezone, checked here — never by the model — against each other and against the calendar.
 * A proposal saves nothing; blocks become "saved" only when the calendar really holds them.
 */

export const BLOCK_CATEGORIES = [
  "work",
  "study",
  "class",
  "meeting",
  "exercise",
  "meal",
  "personal",
  "rest",
  "travel",
  "other",
] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

export interface DayPlanBlockInput {
  /** Local wall-clock "HH:mm"; an end may be "24:00". */
  start: string;
  end: string;
  label: string;
  category?: BlockCategory;
  notes?: string | null;
  /** The user said this time; otherwise it's ELISE's suggestion. */
  given?: boolean;
}

export interface DayPlanBlock {
  id: string;
  start: string;
  end: string;
  minutes: number;
  label: string;
  category: BlockCategory;
  notes: string | null;
  /** user: a time the user gave · suggested: ELISE's estimate · calendar: already booked. */
  origin: "user" | "suggested" | "calendar";
  /** proposed: a draft · saved: the calendar holds it (eventId). */
  state: "proposed" | "saved";
  eventId: string | null;
  /** Ids of blocks it overlaps. */
  conflicts: string[];
}

export type DayPlanWarning =
  | { kind: "overlap"; a: string; b: string }
  | { kind: "nonexistent_time"; at: string }
  | { kind: "calendar_unavailable" };

export interface DayPlan {
  date: string;
  timezone: string;
  title: string | null;
  blocks: DayPlanBlock[];
  /** Free stretches of 15 minutes or more between the first and the last block. */
  gaps: { start: string; end: string; minutes: number }[];
  warnings: DayPlanWarning[];
  /** Grows with each change to the same day's proposal. */
  version: number;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const MIN_GAP = 15;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "8", "8:00", "08.30", "8h" → "08:00"; null when it isn't a time of day. */
export function normalizeTime(raw: string): string | null {
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?h?s?$/i.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return hhmmOf(h * 60 + min);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A proposed block and a calendar event are the same booking: same times, related title. */
const sameBooking = (b: { start: string; end: string; label: string }, e: LocalEvent) => {
  if (b.start !== e.start || b.end !== e.end) return false;
  const x = norm(b.label);
  const y = norm(e.title);
  return x === y || x.includes(y) || y.includes(x);
};

interface LocalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
}

/** The day's timed events as local "HH:mm" spans (clipped to the day); all-day ones aren't blocks. */
export function eventsOnDay(
  events: readonly CalendarEvent[],
  date: string,
  timezone: string,
): LocalEvent[] {
  const next = addDays(date, 1);
  return events.flatMap((e) => {
    if (e.allDay || e.status === "cancelled") return [];
    const s = toLocalDateTime(new Date(e.start), timezone);
    const en = toLocalDateTime(new Date(e.end), timezone);
    if (en.slice(0, 10) < date || s.slice(0, 10) > date) return [];
    const start = s.slice(0, 10) < date ? "00:00" : s.slice(11, 16);
    const end = en.slice(0, 10) >= next ? "24:00" : en.slice(11, 16);
    return minutesOf(end) > minutesOf(start) ? [{ id: e.id, title: e.title, start, end }] : [];
  });
}

export type PlanDayResult = { ok: true; plan: DayPlan } | { ok: false; reason: string };

/**
 * Validates and assembles a day's plan. Rejected: a time that isn't a time, or a block that
 * ends before it starts (a block never crosses midnight — split it). Kept but flagged: overlaps
 * (with each other or with the calendar) and times the clock skips that day (DST).
 */
export function planDay(input: {
  date: string;
  timezone: string;
  title?: string | null;
  blocks: readonly DayPlanBlockInput[];
  /** The calendar's events (null: it couldn't be read). */
  events: readonly CalendarEvent[] | null;
  version?: number;
}): PlanDayResult {
  const { date, timezone } = input;
  const proposed: DayPlanBlock[] = [];
  for (const [i, b] of input.blocks.entries()) {
    const start = HHMM.test(b.start) ? b.start : normalizeTime(b.start);
    const end = HHMM.test(b.end) ? b.end : normalizeTime(b.end);
    const label = b.label.trim();
    if (!start || !end || start === "24:00")
      return { ok: false, reason: `"${label}": times must be HH:mm (got ${b.start}–${b.end}).` };
    if (minutesOf(end) <= minutesOf(start))
      return {
        ok: false,
        reason: `"${label}" ends (${end}) before it starts (${start}). A block can't cross midnight: split it or fix the times.`,
      };
    proposed.push({
      id: `b${i + 1}`,
      start,
      end,
      minutes: 0,
      label: label.slice(0, 120) || "—",
      category: b.category ?? "other",
      notes: b.notes?.trim().slice(0, 300) || null,
      origin: b.given ? "user" : "suggested",
      state: "proposed",
      eventId: null,
      conflicts: [],
    });
  }

  const warnings: DayPlanWarning[] = [];
  const calendar = input.events ? eventsOnDay(input.events, date, timezone) : [];
  if (!input.events) warnings.push({ kind: "calendar_unavailable" });
  // A block the calendar already holds is that booking, saved; the rest of the day's events
  // join the plan as they are (never duplicated, never invented).
  const used = new Set<string>();
  for (const b of proposed) {
    const match = calendar.find((e) => !used.has(e.id) && sameBooking(b, e));
    if (match) {
      used.add(match.id);
      b.state = "saved";
      b.eventId = match.id;
    }
  }
  const booked: DayPlanBlock[] = calendar
    .filter((e) => !used.has(e.id))
    .map((e, i) => ({
      id: `c${i + 1}`,
      start: e.start,
      end: e.end,
      minutes: 0,
      label: e.title.slice(0, 120) || "—",
      category: "meeting",
      notes: null,
      origin: "calendar",
      state: "saved",
      eventId: e.id,
      conflicts: [],
    }));

  const blocks = [...proposed, ...booked].sort(
    (a, b) => minutesOf(a.start) - minutesOf(b.start) || minutesOf(a.end) - minutesOf(b.end),
  );
  // Real durations: a day with a clock change has an hour more or less.
  const instant = (hhmm: string) =>
    hhmm === "24:00"
      ? zonedDateTimeToUtc(`${addDays(date, 1)}T00:00`, timezone)
      : zonedDateTimeToUtc(`${date}T${hhmm}`, timezone);
  const skipped = new Set<string>();
  for (const b of blocks) {
    b.minutes = Math.round((instant(b.end).getTime() - instant(b.start).getTime()) / 60000);
    for (const t of [b.start, b.end])
      if (t !== "24:00" && toLocalDateTime(instant(t), timezone).slice(11, 16) !== t)
        skipped.add(t);
  }
  for (const at of skipped) warnings.push({ kind: "nonexistent_time", at });
  for (let i = 0; i < blocks.length; i++)
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (minutesOf(b.start) >= minutesOf(a.end)) continue;
      a.conflicts.push(b.id);
      b.conflicts.push(a.id);
      warnings.push({ kind: "overlap", a: a.id, b: b.id });
    }

  const gaps: DayPlan["gaps"] = [];
  let reach = blocks[0] ? minutesOf(blocks[0].end) : 0;
  for (const b of blocks.slice(1)) {
    const s = minutesOf(b.start);
    if (s - reach >= MIN_GAP) gaps.push({ start: hhmmOf(reach), end: b.start, minutes: s - reach });
    reach = Math.max(reach, minutesOf(b.end));
  }

  return {
    ok: true,
    plan: {
      date,
      timezone,
      title: input.title?.trim().slice(0, 120) || null,
      blocks,
      gaps,
      warnings,
      version: input.version ?? 1,
    },
  };
}

// ── From words ───────────────────────────────────────────────────────────────

const RANGE =
  /(?:^|[\s(•*·\-–—])(?:de\s+|from\s+)?(\d{1,2}(?:[:.]\d{2})?)\s*(?:h|hs)?\s*(?:–|—|-|a|al|hasta|to|until)\s*(\d{1,2}(?:[:.]\d{2})?)\s*(?:h|hs)?\b\s*[:,.)–—-]?\s*([^\n]*)/gi;

/**
 * Time blocks written in a reply ("08:00–09:00 Desayuno", "• De 14:15 a 18:00: clase"): a
 * plan said only in words still gets its visual. One side must carry minutes or "hs" — "2-3
 * personas" is not a block. Fewer than three blocks is not a day plan.
 */
export function blocksFromText(text: string): DayPlanBlockInput[] {
  const out: DayPlanBlockInput[] = [];
  for (const line of text.split(/\n|(?<=\.)\s+(?=[A-ZÁÉÍÓÚ])/)) {
    RANGE.lastIndex = 0;
    const m = RANGE.exec(line);
    if (!m) continue;
    const [whole, a, b, rest] = m;
    if (!/[:.]\d{2}|hs?\b/i.test(whole!)) continue;
    const start = normalizeTime(a!);
    const end = normalizeTime(b!);
    if (!start || !end || minutesOf(end) <= minutesOf(start)) continue;
    const label = rest!
      .replace(/\*\*|__|`/g, "")
      .replace(/^[\s:,.\-–—]+/, "")
      .split(/[.;]\s|\s[—–]\s/)[0]!
      .trim()
      .slice(0, 80);
    if (!label) continue;
    out.push({ start, end, label, given: false });
  }
  return out.length >= 3 ? out : [];
}

// ── Which day ────────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * The day a request is about, from its own words, relative to `today` (YYYY-MM-DD in the
 * user's timezone). The latest mention wins, so "mañana… no, hoy lunes" is today. "La
 * mañana" / "por la mañana" is a morning, not tomorrow. Null when no day is named.
 */
export function targetDay(text: string, today: string): string | null {
  const t = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const re =
    /\b(pasado\s+manana|day\s+after\s+tomorrow|manana|tomorrow|hoy|today|domingo|lunes|martes|miercoles|jueves|viernes|sabado|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;
  let last: string | null = null;
  for (const m of t.matchAll(re)) {
    const word = m[1]!.replace(/\s+/g, " ");
    // "la mañana", "por la mañana", "esta mañana", "de mañana temprano"… is a time of day.
    if (word === "manana" && /\b(la|esta|una|cada|toda la|de la)\s+$/.test(t.slice(0, m.index)))
      continue;
    last = word;
  }
  if (!last) return null;
  if (last === "hoy" || last === "today") return today;
  if (last === "manana" || last === "tomorrow") return addDays(today, 1);
  if (last === "pasado manana" || last === "day after tomorrow") return addDays(today, 2);
  const wanted = WEEKDAYS[last]!;
  const now = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (wanted - now + 7) % 7);
}

/**
 * A reply that laid a day out only as words, as the planning.proposeDay read that shows it
 * (ADR-098): which day comes from the user's own words (latest correction wins), else the
 * reply's, else today.
 */
export function planFromReply(reply: string, message: string, timezone: string, now = new Date()) {
  const blocks = blocksFromText(reply);
  if (!blocks.length) return null;
  const today = todayIn(timezone, now);
  const date = targetDay(message, today) ?? targetDay(reply, today) ?? today;
  return { tool: "planning.proposeDay", args: { date, blocks } };
}
