/** Timezone-aware date helpers. Dates are ISO calendar dates (YYYY-MM-DD). */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date "now" corresponds to in `timezone`. */
export function todayIn(timezone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Human-readable "now" for model context, e.g. "Tuesday, 2026-09-29 14:05 (America/Argentina/Buenos_Aires)". */
export function describeNow(timezone: string, now: Date = new Date()): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(
    now,
  );
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return `${weekday}, ${todayIn(timezone, now)} ${time} (${timezone})`;
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isLocalDateTime(value: string): boolean {
  const m = LOCAL_DATETIME.exec(value);
  if (!m) return false;
  return isIsoDate(value.slice(0, 10)) && Number(m[4]) < 24 && Number(m[5]) < 60;
}

/** Offset of `timezone` from UTC at `instant`, in minutes (e.g. -180 for Buenos Aires). */
export function timezoneOffsetMinutes(timezone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * Converts a wall-clock time in `timezone` ("2026-09-30T15:00") to the UTC instant.
 * Deterministic and DST-aware; the model never does timezone arithmetic.
 */
export function zonedDateTimeToUtc(local: string, timezone: string): Date {
  const m = LOCAL_DATETIME.exec(local);
  if (!m) throw new Error(`Invalid local date-time: ${local}`);
  const guess = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  const first = timezoneOffsetMinutes(timezone, new Date(guess));
  let utc = guess - first * 60000;
  const second = timezoneOffsetMinutes(timezone, new Date(utc));
  if (second !== first) utc = guess - second * 60000;
  return new Date(utc);
}

/** Wall-clock representation of an instant in `timezone`: "2026-09-30T15:00". */
export function toLocalDateTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Start of a calendar day in `timezone`, as a UTC instant. */
export function startOfDayUtc(isoDate: string, timezone: string): Date {
  return zonedDateTimeToUtc(`${isoDate}T00:00`, timezone);
}
