import { addDays } from "./time";

/**
 * Calendar periods in the user's local dates, shared by Finance and Recall ("this month",
 * "last week"…). Weeks run Monday–Sunday. Deterministic: same date in, same range out.
 */

export const PERIODS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "last_30_days",
  "last_90_days",
] as const;
export type PeriodPreset = (typeof PERIODS)[number];

export interface Period {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function monthPeriod(y: number, m: number): Period {
  // Normalize month overflow (m can be 0 or 13 when stepping).
  const d = new Date(Date.UTC(y, m - 1, 1));
  const yy = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  return { from: ymd(yy, mm, 1), to: ymd(yy, mm, lastDay(yy, mm)) };
}

function quarterPeriod(y: number, q: number): Period {
  const first = monthPeriod(y, q * 3 - 2);
  const last = monthPeriod(y, q * 3);
  return { from: first.from, to: last.to };
}

/** Calendar periods in the user's local dates. Weeks run Monday–Sunday. */
export function resolvePeriod(preset: PeriodPreset, today: string): Period {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const q = Math.ceil(m / 3);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week":
      return { from: addDays(today, -weekday), to: addDays(today, 6 - weekday) };
    case "last_week":
      return { from: addDays(today, -weekday - 7), to: addDays(today, -weekday - 1) };
    case "this_month":
      return monthPeriod(y, m);
    case "last_month":
      return monthPeriod(y, m - 1);
    case "this_quarter":
      return quarterPeriod(y, q);
    case "last_quarter":
      return q === 1 ? quarterPeriod(y - 1, 4) : quarterPeriod(y, q - 1);
    case "this_year":
      return { from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
    case "last_year":
      return { from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31) };
    case "last_30_days":
      return { from: addDays(today, -29), to: today };
    case "last_90_days":
      return { from: addDays(today, -89), to: today };
  }
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The period to compare against. "previous": the preceding calendar month/quarter/year when
 * the period is exactly one, else the same number of days right before. "last_year": the same
 * dates one year earlier.
 */
export function comparisonPeriod(p: Period, mode: "previous" | "last_year"): Period {
  const [fy, fm, fd] = p.from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = p.to.split("-").map(Number) as [number, number, number];
  if (mode === "last_year") {
    const to = ymd(ty - 1, tm, Math.min(td, lastDay(ty - 1, tm)));
    return { from: ymd(fy - 1, fm, Math.min(fd, lastDay(fy - 1, fm))), to };
  }
  const wholeMonths = fd === 1 && td === lastDay(ty, tm);
  if (wholeMonths) {
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    const start = monthPeriod(fy, fm - months);
    const end = monthPeriod(fy, fm - 1);
    return { from: start.from, to: end.to };
  }
  const length = daysBetween(p.from, p.to) + 1;
  return { from: addDays(p.from, -length), to: addDays(p.from, -1) };
}
