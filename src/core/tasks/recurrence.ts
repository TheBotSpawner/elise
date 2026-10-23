import { z } from "zod";

import { addDays, isIsoDate } from "../time";

/**
 * Recurring tasks (ADR-115). A task repeats by a rule stored as an RFC 5545 RRULE subset —
 * FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYDAY (with an ordinal for monthly: 2MO, -1FR),
 * BYMONTHDAY, COUNT and UNTIL — anchored at the series' first date (DTSTART). Tasks carry a
 * calendar date only (ADR-050), so every computation is on plain dates: DST can't shift them;
 * the user's IANA timezone only decides what "today" is.
 *
 * One deliberate departure from RFC 5545: "the 31st" in a month without one is that month's
 * last day (and 29 Feb is 28 Feb in a common year) — people mean "end of month", not "skip".
 */

export const WEEKDAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const REPEAT_FREQS = ["daily", "weekly", "monthly", "yearly"] as const;

export const repeatSchema = z
  .object({
    freq: z.enum(REPEAT_FREQS),
    interval: z.number().int().min(1).max(365).default(1).describe('"cada 2 semanas" → 2.'),
    days: z
      .array(z.enum(WEEKDAYS))
      .max(7)
      .optional()
      .describe('Weekly: "lunes y jueves" → ["mo","th"]. "Días hábiles" → mo..fr.'),
    monthDay: z
      .number()
      .int()
      .min(-1)
      .max(31)
      .refine((n) => n !== 0)
      .optional()
      .describe('Monthly: "el 15 de cada mes" → 15; "el último día del mes" → -1.'),
    ordinal: z
      .object({
        n: z
          .number()
          .int()
          .min(-1)
          .max(5)
          .refine((n) => n !== 0),
        day: z.enum(WEEKDAYS),
      })
      .strict()
      .optional()
      .describe(
        'Monthly: "el segundo martes" → {n:2, day:"tu"}; "el último viernes" → {n:-1, day:"fr"}.',
      ),
    until: z
      .string()
      .refine(isIsoDate)
      .optional()
      .describe('"hasta el 31/12" → that date (YYYY-MM-DD).'),
    count: z.number().int().min(1).max(1000).optional().describe('"10 veces" → 10.'),
  })
  .strict()
  .refine((r) => !(r.until && r.count), { message: "until or count, not both" })
  .refine((r) => !(r.monthDay && r.ordinal), { message: "monthDay or ordinal, not both" });

export type Repeat = z.infer<typeof repeatSchema>;

const RR_DAY: Record<Weekday, string> = {
  mo: "MO",
  tu: "TU",
  we: "WE",
  th: "TH",
  fr: "FR",
  sa: "SA",
  su: "SU",
};

/** The rule as an RRULE (without DTSTART: the series' anchor date is stored beside it). */
export function toRRule(r: Repeat): string {
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.freq === "weekly" && r.days?.length)
    parts.push(
      `BYDAY=${sortDays(r.days)
        .map((d) => RR_DAY[d])
        .join(",")}`,
    );
  if (r.freq === "monthly" && r.ordinal) parts.push(`BYDAY=${r.ordinal.n}${RR_DAY[r.ordinal.day]}`);
  if (r.freq === "monthly" && r.monthDay) parts.push(`BYMONTHDAY=${r.monthDay}`);
  if (r.count) parts.push(`COUNT=${r.count}`);
  if (r.until) parts.push(`UNTIL=${r.until.replace(/-/g, "")}`);
  return parts.join(";");
}

/** The subset above back into a rule; anything else is refused, never half-read. */
export function parseRRule(rrule: string): Repeat {
  const kv = new Map(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .filter(Boolean)
      .map((p) => p.split("=") as [string, string]),
  );
  const freq = kv.get("FREQ")?.toLowerCase();
  const day = (code: string) =>
    WEEKDAYS.find((d) => RR_DAY[d] === code.toUpperCase()) ??
    (() => {
      throw new Error(`Unsupported BYDAY ${code}`);
    })();
  const raw: Record<string, unknown> = { freq, interval: Number(kv.get("INTERVAL") ?? 1) };
  const byDay = kv.get("BYDAY");
  if (byDay) {
    const m = /^(-?\d)([A-Z]{2})$/i.exec(byDay);
    if (m) raw.ordinal = { n: Number(m[1]), day: day(m[2]!) };
    else raw.days = byDay.split(",").map(day);
  }
  if (kv.has("BYMONTHDAY")) raw.monthDay = Number(kv.get("BYMONTHDAY"));
  if (kv.has("COUNT")) raw.count = Number(kv.get("COUNT"));
  const until = kv.get("UNTIL");
  if (until) raw.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  return repeatSchema.parse(raw);
}

// ── Dates ────────────────────────────────────────────────────────────────────

const ymd = (d: string) => d.split("-").map(Number) as [number, number, number];
const iso = (y: number, m: number, day: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 0 = Monday … 6 = Sunday. */
const dow = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const sortDays = (days: readonly Weekday[]) =>
  [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The dates a monthly/yearly rule picks inside one month, in order. */
function inMonth(r: Repeat, y: number, m: number, anchor: string): string[] {
  const last = daysIn(y, m);
  if (r.freq === "monthly" && r.ordinal) {
    const { n, day } = r.ordinal;
    const target = WEEKDAYS.indexOf(day);
    const first = (target - dow(iso(y, m, 1)) + 7) % 7; // 0-based day of the first match
    const all: number[] = [];
    for (let d = first + 1; d <= last; d += 7) all.push(d);
    const pick = n > 0 ? all[n - 1] : all[all.length + n];
    return pick ? [iso(y, m, pick)] : [];
  }
  const want = r.freq === "monthly" && r.monthDay ? r.monthDay : ymd(anchor)[2];
  return [iso(y, m, want === -1 ? last : Math.min(want, last))];
}

/**
 * The first occurrence strictly after `after`, following the rule from `anchor` (the series'
 * first date), or null when the rule has ended by UNTIL. COUNT is the caller's to enforce (it
 * knows how many occurrences exist).
 */
export function nextOccurrence(r: Repeat, anchor: string, after: string): string | null {
  const ok = (d: string) => (r.until && d > r.until ? null : d);
  if (after < anchor) return ok(anchor);
  if (r.freq === "daily") {
    const k = Math.floor(daysBetween(anchor, after) / r.interval) + 1;
    return ok(addDays(anchor, k * r.interval));
  }
  if (r.freq === "weekly") {
    const days = r.days?.length ? sortDays(r.days) : [WEEKDAYS[dow(anchor)]!];
    const weekStart = addDays(anchor, -dow(anchor));
    // Walk at most a few periods: interval ≤ 365 weeks keeps this bounded.
    for (let d = addDays(after, 1), i = 0; i < 7 * (r.interval + 1); i++, d = addDays(d, 1)) {
      const week = Math.floor(daysBetween(weekStart, d) / 7);
      if (week % r.interval === 0 && days.includes(WEEKDAYS[dow(d)]!)) return ok(d);
    }
    return null;
  }
  const [ay, am] = ymd(anchor);
  const [y0, m0] = ymd(after);
  const step = r.freq === "yearly" ? 12 * r.interval : r.interval;
  // Months from the anchor's month to `after`'s, rounded down to a period of the rule.
  let k = Math.max(0, Math.floor(((y0 - ay) * 12 + (m0 - am)) / step));
  for (let guard = 0; guard < 50; guard++, k++) {
    const total = am - 1 + k * step;
    const y = ay + Math.floor(total / 12);
    const m = (total % 12) + 1;
    const month = r.freq === "yearly" && m !== am ? [] : inMonth(r, y, m, anchor);
    const hit = month.find((d) => d > after && d >= anchor);
    if (hit) return ok(hit);
  }
  return null;
}

/**
 * The next date to create after completing the occurrence of `current`: the rule's next date,
 * skipping the ones already in the past (a daily task completed a week late doesn't come back
 * seven times). Null when the series ended (UNTIL, or COUNT reached).
 */
export function nextAfterCompletion(
  r: Repeat,
  anchor: string,
  current: string,
  today: string,
  done: number,
): string | null {
  if (r.count && done >= r.count) return null;
  let next = nextOccurrence(r, anchor, current);
  for (let guard = 0; next && next < today && guard < 1000; guard++)
    next = nextOccurrence(r, anchor, next);
  return next;
}

// ── Words ────────────────────────────────────────────────────────────────────

const ES_DAY: Record<Weekday, string> = {
  mo: "lunes",
  tu: "martes",
  we: "miércoles",
  th: "jueves",
  fr: "viernes",
  sa: "sábados",
  su: "domingos",
};
const ES_ONE: Record<Weekday, string> = { ...ES_DAY, sa: "sábado", su: "domingo" };
const EN_DAY: Record<Weekday, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};
const ES_ORD: Record<number, string> = {
  1: "primer",
  2: "segundo",
  3: "tercer",
  4: "cuarto",
  5: "quinto",
  [-1]: "último",
};
const EN_ORD: Record<number, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  [-1]: "last",
};

const list = (items: string[], and: string) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${and} ${items.at(-1)}`;

/** "Cada 2 semanas, los lunes y jueves · 10 veces" — what the UI and ELISE say. */
export function describeRepeat(r: Repeat, anchor: string | null, locale: string): string {
  const es = !locale.startsWith("en");
  const days = r.days?.length ? sortDays(r.days) : null;
  const weekdays = days?.join() === "mo,tu,we,th,fr";
  let s: string;
  if (r.freq === "weekly" && weekdays && r.interval === 1) s = es ? "Días hábiles" : "Weekdays";
  else {
    const unit = es
      ? {
          daily: ["Todos los días", "días"],
          weekly: ["Todas las semanas", "semanas"],
          monthly: ["Todos los meses", "meses"],
          yearly: ["Todos los años", "años"],
        }[r.freq]
      : {
          daily: ["Every day", "days"],
          weekly: ["Every week", "weeks"],
          monthly: ["Every month", "months"],
          yearly: ["Every year", "years"],
        }[r.freq];
    s =
      r.interval === 1
        ? unit[0]!
        : es
          ? `Cada ${r.interval} ${unit[1]}`
          : `Every ${r.interval} ${unit[1]}`;
    if (r.freq === "weekly" && days)
      s += es
        ? `, los ${list(
            days.map((d) => ES_DAY[d]),
            "y",
          )}`
        : ` on ${list(
            days.map((d) => EN_DAY[d]),
            "and",
          )}`;
    if (r.freq === "monthly" && r.ordinal)
      s += es
        ? `, el ${ES_ORD[r.ordinal.n]} ${ES_ONE[r.ordinal.day]}`
        : ` on the ${EN_ORD[r.ordinal.n]} ${EN_DAY[r.ordinal.day]}`;
    else if (r.freq === "monthly") {
      const d = r.monthDay ?? (anchor ? ymd(anchor)[2] : null);
      if (d === -1) s += es ? ", el último día" : " on the last day";
      else if (d) s += es ? `, el día ${d}` : ` on day ${d}`;
    }
  }
  if (r.count) s += es ? ` · ${r.count} veces` : ` · ${r.count} times`;
  if (r.until) s += es ? ` · hasta el ${r.until}` : ` · until ${r.until}`;
  return s;
}
