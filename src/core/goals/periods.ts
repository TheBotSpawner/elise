import { resolvePeriod, type Period } from "../periods";
import { addDays } from "../time";

/**
 * Goal time horizons (ADR-055, ADR-057). The period IS a date range: `period_start` /
 * `period_end` (local dates). Presets are only shortcuts that fill those two dates; nothing
 * stores a preset or a label. Deterministic: same preset and day in, same dates out.
 */

export const GOAL_PERIODS = [
  "this_quarter",
  "next_quarter",
  "q1",
  "q2",
  "q3",
  "q4",
  "this_year",
  /** From today to 31 Dec ("de hoy hasta fin de año"). */
  "rest_of_year",
  "next_year",
  "months_3",
  "months_6",
  "months_12",
  "custom",
  "none",
] as const;
export type GoalPeriodPreset = (typeof GOAL_PERIODS)[number];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parts = (d: string) => d.split("-").map(Number) as [number, number, number];

export function quarterPeriod(year: number, q: number): Period {
  const end = q * 3;
  return { from: `${year}-${pad(end - 2)}-01`, to: `${year}-${pad(end)}-${lastDay(year, end)}` };
}

/** The same day `n` months later (clamped to the month's end: 31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + n;
  const yy = Math.floor(index / 12);
  const mm = (index % 12) + 1;
  return `${yy}-${pad(mm)}-${pad(Math.min(d, lastDay(yy, mm)))}`;
}

/**
 * Dates for a preset in the user's local calendar. `null` clears the period ("Sin fecha");
 * `undefined` means the input can't be resolved (a custom range without both ends, or reversed).
 * Q1–Q4 without a year are the next such quarter that hasn't ended (Q1 in October → next year).
 */
export function resolveGoalPeriod(
  preset: GoalPeriodPreset,
  today: string,
  opts: { year?: number; from?: string; to?: string } = {},
): Period | null | undefined {
  const [y, m] = parts(today);
  const q = Math.ceil(m / 3);
  switch (preset) {
    case "none":
      return null;
    case "custom":
      return opts.from && opts.to && opts.from <= opts.to
        ? { from: opts.from, to: opts.to }
        : undefined;
    case "this_quarter":
      return resolvePeriod("this_quarter", today);
    case "next_quarter":
      return q === 4 ? quarterPeriod(y + 1, 1) : quarterPeriod(y, q + 1);
    case "q1":
    case "q2":
    case "q3":
    case "q4": {
      const n = Number(preset[1]);
      if (opts.year) return quarterPeriod(opts.year, n);
      const current = quarterPeriod(y, n);
      return current.to < today ? quarterPeriod(y + 1, n) : current;
    }
    case "this_year":
      return resolvePeriod("this_year", today);
    case "next_year":
      return { from: `${y + 1}-01-01`, to: `${y + 1}-12-31` };
    case "rest_of_year":
      return { from: today, to: `${y}-12-31` };
    case "months_3":
    case "months_6":
    case "months_12": {
      const n = Number(preset.split("_")[1]);
      return { from: today, to: addDays(addMonths(today, n), -1) };
    }
  }
}

/** Which preset these dates are, when they are exactly one (for the form's select). */
export function presetOf(p: Period | null, today: string): GoalPeriodPreset {
  if (!p) return "none";
  for (const preset of ["this_quarter", "next_quarter", "this_year", "next_year"] as const) {
    const r = resolveGoalPeriod(preset, today);
    if (r && r.from === p.from && r.to === p.to) return preset;
  }
  for (const preset of ["q1", "q2", "q3", "q4"] as const) {
    const r = resolveGoalPeriod(preset, today);
    if (r && r.from === p.from && r.to === p.to) return preset;
  }
  return "custom";
}

const isQuarterStart = (d: string) => {
  const [, m, day] = parts(d);
  return day === 1 && (m - 1) % 3 === 0;
};
const isQuarterEnd = (d: string) => {
  const [y, m, day] = parts(d);
  return m % 3 === 0 && day === lastDay(y, m);
};

const QUARTER = { es: "T", en: "Q" } as const;
const MONTHS = {
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
} as const;
const LONG_MONTHS = {
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
} as const;

/** "T1 · enero–marzo" / "Q1 · January–March" (the quarter picker). */
export function quarterName(q: number, locale: "es" | "en"): string {
  return `${QUARTER[locale]}${q} · ${LONG_MONTHS[locale][q * 3 - 3]}–${LONG_MONTHS[locale][q * 3 - 1]}`;
}

/** "13 oct 2026" / "Oct 13, 2026" — composed by hand so server and browser agree. */
export function dayLabel(d: string, locale: "es" | "en", withYear = true): string {
  const [y, m, day] = parts(d);
  const mon = MONTHS[locale][m - 1];
  if (locale === "es") return `${day} ${mon}${withYear ? ` ${y}` : ""}`;
  return `${mon} ${day}${withYear ? `, ${y}` : ""}`;
}

/**
 * A period in a few words, derived from its dates: "2026", "T4 2026", "T1–T2 2027",
 * "oct–nov 2026", or "13 oct 2026 – 12 ene 2027".
 */
export function periodLabel(p: Period, locale: "es" | "en"): string {
  const [fy, fm, fd] = parts(p.from);
  const [ty, tm, td] = parts(p.to);
  const Q = QUARTER[locale];
  if (isQuarterStart(p.from) && isQuarterEnd(p.to)) {
    const qf = Math.ceil(fm / 3);
    const qt = Math.ceil(tm / 3);
    if (fy === ty) {
      if (qf === 1 && qt === 4) return String(fy);
      return qf === qt ? `${Q}${qf} ${fy}` : `${Q}${qf}–${Q}${qt} ${fy}`;
    }
    if (qf === 1 && qt === 4) return `${fy}–${ty}`;
    return `${Q}${qf} ${fy} – ${Q}${qt} ${ty}`;
  }
  if (fd === 1 && td === lastDay(ty, tm)) {
    const mf = MONTHS[locale][fm - 1];
    const mt = MONTHS[locale][tm - 1];
    if (fy === ty) return fm === tm ? `${mf} ${fy}` : `${mf}–${mt} ${fy}`;
    return `${mf} ${fy} – ${mt} ${ty}`;
  }
  return `${dayLabel(p.from, locale, fy !== ty)} – ${dayLabel(p.to, locale)}`;
}

/**
 * How long a period is, deterministically (ADR-057): a familiar unit when the range is one
 * ("1 oct → 31 dic" or "14 oct → 14 abr" = 3 / 6 meses, a whole year = "1 año"), else days
 * under two months ("14 días"), else months and days ("5 meses y 12 días").
 */
export function durationLabel(from: string, to: string, locale: "es" | "en"): string {
  const es = locale === "es";
  const months = (n: number) =>
    n % 12 === 0
      ? es
        ? `${n / 12} ${n === 12 ? "año" : "años"}`
        : `${n / 12} ${n === 12 ? "year" : "years"}`
      : es
        ? `${n} ${n === 1 ? "mes" : "meses"}`
        : `${n} ${n === 1 ? "month" : "months"}`;
  const days = (n: number) =>
    es ? `${n} ${n === 1 ? "día" : "días"}` : `${n} ${n === 1 ? "day" : "days"}`;
  for (let n = 1; n <= 120; n++) {
    const end = addMonths(from, n);
    if (to === end || to === addDays(end, -1)) return months(n);
    if (end > to) break;
  }
  const total = daysBetween(from, to);
  if (total < 60) return days(Math.max(total, 1));
  let n = 0;
  while (addMonths(from, n + 1) <= to) n++;
  const rest = daysBetween(addMonths(from, n), to);
  return rest
    ? es
      ? `${months(n)} y ${days(rest)}`
      : `${months(n)} and ${days(rest)}`
    : months(n);
}

/** "14 oct → 13 ene 2027" (the year only where it isn't obvious). */
export function rangeLabel(from: string, to: string, locale: "es" | "en"): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${dayLabel(from, locale, !sameYear)} → ${dayLabel(to, locale)}`;
}

/** "2027-01" (a whole month) or a day, as the first or last day it covers. */
export function monthOrDay(value: string, edge: "start" | "end"): string {
  if (!/^\d{4}-\d{2}$/.test(value)) return value;
  const [y, m] = value.split("-").map(Number) as [number, number];
  return edge === "start" ? `${value}-01` : `${value}-${pad(lastDay(y, m))}`;
}

export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
