import {
  currentStreak,
  dayMet,
  isScheduled,
  weekStart,
  type Habit,
  type HabitEntry,
} from "../capabilities/habits";
import { resolvePeriod, shiftPeriod, type Period } from "../periods";
import { addDays } from "../time";

/**
 * Habits analytics (ADR-053): the one deterministic implementation behind the Habits screen,
 * Live Canvas Surfaces, chat answers and the Morning Brief. The model explains these numbers;
 * it never computes them.
 *
 * Definitions, per habit and range:
 * - A day is *expected* when the habit is scheduled that day and on/after its start (or the
 *   user recorded it anyway: backfilled history counts).
 * - daily / specific_days: `goal` = expected days in the whole range; `done` = met days.
 * - weekly: each ISO week contributes `target × (its days inside the range) / 7`; `done` sums
 *   sessions (or the quantity) per week, capped at that week's share, so an over-achieving
 *   week can't hide a missed one.
 * - `progress` = done / goal (the whole period, future days included: "2 / 3 this week").
 * - `rate` (completion) = done / expected *so far* (only days up to today): what the user
 *   actually achieved. Past periods have progress = rate.
 * - Paused or archived habits are evaluated only when shown explicitly; summaries cover
 *   active habits.
 */

export type HabitView = "week" | "month" | "year" | "custom";
export const HABIT_VIEWS: readonly HabitView[] = ["week", "month", "year", "custom"];

export interface HabitRange extends Period {
  view: HabitView;
}

export type Granularity = "day" | "week" | "month";

/** The range a view shows around `anchor` (week Mon–Sun, calendar month, calendar year). */
export function habitRange(view: HabitView, anchor: string, custom?: Period): HabitRange {
  if (view === "custom" && custom && custom.from <= custom.to) return { view, ...custom };
  if (view === "month") return { view, ...resolvePeriod("this_month", anchor) };
  if (view === "year") return { view, ...resolvePeriod("this_year", anchor) };
  const from = weekStart(anchor);
  return { view: "week", from, to: addDays(from, 6) };
}

/** ‹ / ›: the same span one step back or forward. */
export function shiftHabitRange(r: HabitRange, dir: -1 | 1): HabitRange {
  return { view: r.view, ...shiftPeriod(r, dir) };
}

/** The equivalent period right before (for comparisons). */
export function previousRange(r: HabitRange): HabitRange {
  return shiftHabitRange(r, -1);
}

export function daysIn(p: Period): number {
  return (Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000 + 1;
}

/** ≤ 14 days → day, ≤ 120 → week, longer → month. */
export function granularityFor(p: Period): Granularity {
  const n = daysIn(p);
  return n <= 14 ? "day" : n <= 120 ? "week" : "month";
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? Math.min(1, a / b) : null);

export type DayState = "done" | "partial" | "missed" | "pending" | "rest" | "future" | "skipped";

export interface DayCell {
  date: string;
  /** The habit is expected that day (schedule + start date). */
  scheduled: boolean;
  value: number;
  met: boolean;
  state: DayState;
}

export interface HabitStats {
  habitId: string;
  range: Period;
  done: number;
  goal: number;
  /** done / goal for the whole period, 0–1. */
  progress: number | null;
  /** done / expected so far, 0–1 (null when nothing was expected yet). */
  rate: number | null;
  expectedSoFar: number;
  days: DayCell[];
  /** Measured habits: total and averages over days with a value. */
  quantity: { total: number; activeDays: number; perActiveDay: number | null } | null;
  /** Measured daily habits: average share of the daily target reached, 0–1. */
  attainment: number | null;
}

function dayCells(habit: Habit, byDate: Map<string, HabitEntry>, p: Period, today: string) {
  const cells: DayCell[] = [];
  for (let date = p.from; date <= p.to; date = addDays(date, 1)) {
    const entry = byDate.get(date);
    const done = entry?.status === "done";
    const scheduled =
      habit.frequency === "weekly"
        ? date >= habit.startDate || done
        : isScheduled(habit, date) && (date >= habit.startDate || done);
    const met = dayMet(habit, entry);
    const value = done ? entry!.value : 0;
    const state: DayState =
      date > today
        ? "future"
        : entry?.status === "skipped"
          ? "skipped"
          : met
            ? "done"
            : value > 0
              ? "partial"
              : !scheduled || habit.frequency === "weekly"
                ? "rest"
                : date === today
                  ? "pending"
                  : "missed";
    cells.push({ date, scheduled, value, met, state });
  }
  return cells;
}

export function habitStats(
  habit: Habit,
  entries: HabitEntry[],
  range: Period,
  today: string,
): HabitStats {
  const byDate = new Map(entries.filter((e) => e.habitId === habit.id).map((e) => [e.date, e]));
  const days = dayCells(habit, byDate, range, today);
  let done = 0;
  let goal = 0;
  let expected = 0;
  let achieved = 0;
  if (habit.frequency === "weekly") {
    for (let w = weekStart(range.from); w <= range.to; w = addDays(w, 7)) {
      const inRange = days.filter((d) => d.date >= w && d.date <= addDays(w, 6));
      const share = habit.target * (inRange.filter((d) => d.scheduled).length / 7);
      const elapsed =
        habit.target * (inRange.filter((d) => d.scheduled && d.date <= today).length / 7);
      const amount = inRange.reduce((s, d) => s + (habit.unit ? d.value : d.met ? 1 : 0), 0);
      done += amount;
      goal += share;
      expected += elapsed;
      achieved += Math.min(amount, share);
    }
  } else {
    const due = days.filter((d) => d.scheduled);
    done = due.filter((d) => d.met).length;
    goal = due.length;
    expected = due.filter((d) => d.date <= today).length;
    achieved = due.filter((d) => d.met && d.date <= today).length;
  }
  const valued = days.filter((d) => d.value > 0);
  const total = valued.reduce((s, d) => s + d.value, 0);
  const dueSoFar = days.filter((d) => d.scheduled && d.date <= today);
  return {
    habitId: habit.id,
    range: { from: range.from, to: range.to },
    done: round2(done),
    // Sessions are whole numbers (a month of 3×/week is 13); quantities keep a decimal.
    goal: habit.frequency === "weekly" ? (habit.unit ? round1(goal) : Math.round(goal)) : goal,
    progress: ratio(done, goal),
    rate: ratio(achieved, expected),
    expectedSoFar: round2(expected),
    days,
    quantity: habit.unit
      ? {
          total: round2(total),
          activeDays: valued.length,
          perActiveDay: valued.length ? round2(total / valued.length) : null,
        }
      : null,
    attainment:
      habit.unit && habit.frequency !== "weekly" && dueSoFar.length
        ? round2(
            dueSoFar.reduce((s, d) => s + Math.min(1, d.value / habit.target), 0) / dueSoFar.length,
          )
        : null,
  };
}

/**
 * Longest streak in the history given (same rule as the current streak: consecutive scheduled
 * days met, or consecutive weeks whose target was reached; unscheduled days don't break it).
 */
export function longestStreak(
  habit: Habit,
  entries: HabitEntry[],
  today: string,
): { count: number; unit: "days" | "weeks" } {
  const own = entries.filter((e) => e.habitId === habit.id);
  const byDate = new Map(own.map((e) => [e.date, e]));
  const first = own.reduce(
    (min, e) => (e.status === "done" && e.date < min ? e.date : min),
    habit.startDate,
  );
  let best = 0;
  let run = 0;
  if (habit.frequency === "weekly") {
    for (let w = weekStart(first); w <= today; w = addDays(w, 7)) {
      let total = 0;
      for (let i = 0; i < 7; i++) {
        const e = byDate.get(addDays(w, i));
        if (e?.status === "done") total += habit.unit ? e.value : 1;
      }
      if (total >= habit.target) best = Math.max(best, ++run);
      else if (w !== weekStart(today)) run = 0;
    }
    return { count: best, unit: "weeks" };
  }
  for (let d = first, guard = 0; d <= today && guard < 3700; d = addDays(d, 1), guard++) {
    if (!isScheduled(habit, d)) continue;
    if (dayMet(habit, byDate.get(d))) best = Math.max(best, ++run);
    else if (d !== today) run = 0;
  }
  return { count: best, unit: "days" };
}

export interface HabitsSummary {
  range: Period;
  /** Active habits evaluated. */
  active: number;
  /** Completion so far over all active habits (sum achieved / sum expected), 0–1. */
  rate: number | null;
  /** This week only: habits whose weekly target needs every slot left. */
  atRisk: string[];
  bestStreak: { habitId: string; name: string; count: number; unit: "days" | "weeks" } | null;
  perHabit: HabitStats[];
}

/** Every active habit over a range, plus the overall numbers. */
export function habitsSummary(
  habits: Habit[],
  entries: HabitEntry[],
  range: Period,
  today: string,
  atRisk: string[] = [],
): HabitsSummary {
  const active = habits.filter((h) => h.active && !h.archived);
  const perHabit = active.map((h) => habitStats(h, entries, range, today));
  let achieved = 0;
  let expected = 0;
  for (const s of perHabit) {
    if (s.rate === null) continue;
    achieved += s.rate * s.expectedSoFar;
    expected += s.expectedSoFar;
  }
  let bestStreak: HabitsSummary["bestStreak"] = null;
  for (const h of active) {
    const s = currentStreak(h, entries, today);
    if (s.count > 0 && (!bestStreak || s.count > bestStreak.count))
      bestStreak = { habitId: h.id, name: h.name, ...s };
  }
  return {
    range: { from: range.from, to: range.to },
    active: active.length,
    rate: expected > 0 ? round2(achieved / expected) : null,
    atRisk,
    bestStreak,
    perHabit,
  };
}

export interface TrendPoint {
  key: string;
  from: string;
  to: string;
  /** Completion over active habits in that bucket (null: nothing expected / future). */
  rate: number | null;
}

/** Overall (or one habit's) completion per bucket across the range. */
export function habitsTrend(
  habits: Habit[],
  entries: HabitEntry[],
  range: Period,
  today: string,
  granularity: Granularity = granularityFor(range),
): { granularity: Granularity; points: TrendPoint[] } {
  const points: TrendPoint[] = [];
  let cursor = range.from;
  while (cursor <= range.to && points.length < 400) {
    const bucketEnd =
      granularity === "day"
        ? cursor
        : granularity === "week"
          ? addDays(weekStart(cursor), 6)
          : resolvePeriod("this_month", cursor).to;
    const to = bucketEnd > range.to ? range.to : bucketEnd;
    const key =
      granularity === "month"
        ? cursor.slice(0, 7)
        : granularity === "week"
          ? weekStart(cursor)
          : cursor;
    const rate =
      cursor > today ? null : habitsSummary(habits, entries, { from: cursor, to }, today).rate;
    points.push({ key, from: cursor, to, rate });
    cursor = addDays(to, 1);
  }
  return { granularity, points };
}

/** Per weekday (0=Sun…6=Sat): expected days so far and how many were missed. */
export function weekdayMisses(
  habits: Habit[],
  entries: HabitEntry[],
  range: Period,
  today: string,
): { weekday: number; expected: number; missed: number }[] {
  const out = Array.from({ length: 7 }, (_, weekday) => ({ weekday, expected: 0, missed: 0 }));
  for (const h of habits.filter((x) => x.active && !x.archived && x.frequency !== "weekly")) {
    for (const d of habitStats(h, entries, range, today).days) {
      if (!d.scheduled || d.date >= today) continue;
      const slot = out[new Date(`${d.date}T00:00:00Z`).getUTCDay()]!;
      slot.expected++;
      if (!d.met) slot.missed++;
    }
  }
  return out;
}

/** Calendar heatmap: per day, the share of active habits with a done check-in, 0–1. */
export function dailyIntensity(
  habits: Habit[],
  entries: HabitEntry[],
  range: Period,
  today: string,
): { date: string; value: number | null }[] {
  const active = habits.filter((h) => h.active && !h.archived);
  const ids = new Set(active.map((h) => h.id));
  const doneBy = new Map<string, number>();
  for (const e of entries)
    if (e.status === "done" && ids.has(e.habitId))
      doneBy.set(e.date, (doneBy.get(e.date) ?? 0) + 1);
  const out: { date: string; value: number | null }[] = [];
  for (let d = range.from; d <= range.to && out.length < 400; d = addDays(d, 1))
    out.push({
      date: d,
      value: d > today || !active.length ? null : round2((doneBy.get(d) ?? 0) / active.length),
    });
  return out;
}

/** Percentage points between two completion rates (null if either is unknown). */
export function rateDelta(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : Math.round((current - previous) * 100);
}

/** Per calendar month of a year: one habit's completion (or all habits when `habit` is null). */
export function monthlyRates(
  habits: Habit[],
  entries: HabitEntry[],
  year: string,
  today: string,
): { month: string; rate: number | null }[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const p = resolvePeriod("this_month", `${month}-01`);
    return {
      month,
      rate: p.from > today ? null : habitsSummary(habits, entries, p, today).rate,
    };
  });
}

/** The window of entries a view needs: its range, the previous one, and 26 weeks for streaks. */
export function entriesWindow(range: Period, today: string): Period {
  const prev = shiftPeriod(range, -1);
  const streakFrom = addDays(weekStart(today), -7 * 26);
  const from = [prev.from, streakFrom].sort()[0]!;
  const to = [range.to, addDays(weekStart(today), 6)].sort().at(-1)!;
  return { from, to };
}

/** Deterministic icon suggestion from the habit's name (the user can change or remove it). */
const ICON_WORDS: [RegExp, string][] = [
  [/entren|workout|gym|gimnas|pesas|crossfit|ejercicio/i, "🏋️"],
  [/corr|run|trot/i, "🏃"],
  [/camin|walk|paso/i, "🚶"],
  [/le[eé]r|lectura|libro|read|book/i, "📚"],
  [/medit|respir|mindful/i, "🧘"],
  [/agua|water|hidrat|vaso/i, "💧"],
  [/comida|comer|salud|healthy|ensalada|verdura|fruta|meal|diet/i, "🥗"],
  [/cama|bed/i, "🛏️"],
  [/despert|levant|wake|madrug/i, "🌅"],
  [/dorm|sleep|sueño/i, "😴"],
  [/limpi|clean|casa|house|orden/i, "🧹"],
  [/cocin|cook/i, "🍳"],
  [/estudi|study|curso|aprend|idioma|ingl/i, "🎓"],
  [/escrib|journal|diario|write/i, "✍️"],
  [/planific|plan|agenda/i, "🗓️"],
  [/bici|bike|cicl/i, "🚴"],
  [/nad|swim|pileta/i, "🏊"],
  [/yoga|estir|stretch/i, "🤸"],
  [/vitamin|pastilla|medic|pill/i, "💊"],
  [/ahorr|save|plata|money|gasto/i, "💰"],
  [/music|guitar|piano|instrument/i, "🎸"],
  [/llam|call|famil|amig/i, "📞"],
  [/pantalla|celular|phone|screen|redes/i, "📵"],
  [/alcohol|fumar|smok/i, "🚭"],
];

export function suggestHabitIcon(name: string): string | null {
  return ICON_WORDS.find(([re]) => re.test(name))?.[1] ?? null;
}

/** Whether a range contains today (for "Hoy"). */
export const containsToday = (r: Period, today: string) => r.from <= today && today <= r.to;

export interface HabitStatsRow {
  habitId: string;
  name: string;
  icon: string | null;
  frequency: Habit["frequency"];
  unit: string | null;
  target: number;
  done: number;
  goal: number;
  progress: number | null;
  rate: number | null;
  previousRate: number | null;
  streak: { count: number; unit: "days" | "weeks" };
  /** Only when the full history was loaded (one habit). */
  longest: { count: number; unit: "days" | "weeks" } | null;
  quantity: HabitStats["quantity"];
  attainment: number | null;
  /** Day cells for short ranges (≤ 42 days) or a single habit. */
  days: DayCell[] | null;
}

export interface HabitStatsReport {
  range: HabitRange;
  /** The local day it was computed for (grids mark it). */
  today: string;
  previous: Period;
  overall: {
    rate: number | null;
    previousRate: number | null;
    /** Percentage points vs the previous equivalent period. */
    delta: number | null;
    active: number;
    bestStreak: HabitsSummary["bestStreak"];
  };
  habits: HabitStatsRow[];
  trend: { granularity: Granularity; points: TrendPoint[] };
  weekdays: { weekday: number; expected: number; missed: number }[];
}

/** Everything "¿cómo vengo con mis hábitos?" needs, for any range, computed in one place. */
export function buildHabitStatsReport(
  habits: Habit[],
  entries: HabitEntry[],
  range: HabitRange,
  today: string,
  opts: { fullHistory?: boolean } = {},
): HabitStatsReport {
  const previous = previousRange(range);
  const current = habitsSummary(habits, entries, range, today);
  const before = habitsSummary(habits, entries, previous, today);
  const short = daysIn(range) <= 42;
  const rows = habits.map((h): HabitStatsRow => {
    const s = habitStats(h, entries, range, today);
    const p = habitStats(h, entries, previous, today);
    return {
      habitId: h.id,
      name: h.name,
      icon: h.icon,
      frequency: h.frequency,
      unit: h.unit,
      target: h.target,
      done: s.done,
      goal: s.goal,
      progress: s.progress,
      rate: s.rate,
      previousRate: p.rate,
      streak: currentStreak(h, entries, today),
      longest: opts.fullHistory ? longestStreak(h, entries, today) : null,
      quantity: s.quantity,
      attainment: s.attainment,
      days: short || habits.length === 1 ? s.days : null,
    };
  });
  return {
    range,
    today,
    previous: { from: previous.from, to: previous.to },
    overall: {
      rate: current.rate,
      previousRate: before.rate,
      delta: rateDelta(current.rate, before.rate),
      active: current.active,
      bestStreak: current.bestStreak,
    },
    habits: rows,
    trend: habitsTrend(habits, entries, range, today),
    weekdays: weekdayMisses(habits, entries, range, today),
  };
}
