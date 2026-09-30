import { z } from "zod";

import { addDays, isIsoDate, todayIn } from "../time";

/**
 * Habits (docs/architecture/10 §13-15). All progress is computed here, deterministically;
 * the model only explains it.
 *
 * Frequencies:
 * - daily: `target` per day (1 = done/not done; 2 liters; 30 minutes).
 * - weekly: `target` per ISO week (Mon–Sun). Without a unit it counts days with a done
 *   check-in ("run 3×/week"); with a unit it sums the values ("20 km/week").
 * - specific_days: `target` on each chosen weekday ("run Tue + Sat").
 *
 * A day is "met" when its entry is done and its value reaches the daily target (for weekly
 * habits without a unit, any done check-in counts). Skipped days never count.
 */

export type HabitFrequency = "daily" | "weekly" | "specific_days";
export type EntrySource = "user_ui" | "ai" | "schedule" | "import" | "system";

export interface Habit {
  id: string;
  name: string;
  description: string | null;
  frequency: HabitFrequency;
  target: number;
  unit: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  preferredDays: number[];
  active: boolean;
  startDate: string;
  createdAt: string;
}

export interface HabitEntry {
  id: string;
  habitId: string;
  /** Local calendar date of the check-in (user's timezone). */
  date: string;
  value: number;
  status: "done" | "skipped";
  notes: string | null;
  source: EntrySource;
}

export interface NewHabit {
  name: string;
  description?: string | null;
  frequency: HabitFrequency;
  target: number;
  unit?: string | null;
  preferredDays?: number[];
  startDate: string;
}

export interface HabitsProvider {
  list(opts: { includeInactive: boolean }): Promise<Habit[]>;
  /** By id, or by (case-insensitive) name; several matches are returned for disambiguation. */
  find(ref: string): Promise<Habit[]>;
  create(habit: NewHabit, source: EntrySource): Promise<Habit>;
  update(id: string, patch: Partial<NewHabit> & { active?: boolean }): Promise<Habit>;
  archive(id: string): Promise<Habit>;
  entries(habitIds: string[], from: string, to: string): Promise<HabitEntry[]>;
  /** One entry per habit per day: `add` accumulates, `set` replaces. */
  checkIn(
    habitId: string,
    entry: {
      date: string;
      value: number;
      mode: "add" | "set";
      status: "done" | "skipped";
      notes?: string | null;
    },
    source: EntrySource,
  ): Promise<HabitEntry>;
  removeEntry(habitId: string, date: string): Promise<void>;
}

// ── Deterministic progress ───────────────────────────────────────────────────

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Monday of the ISO week containing `date`. */
export function weekStart(date: string): string {
  const day = weekday(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

/** Is this habit expected on this date? */
export function isScheduled(habit: Pick<Habit, "frequency" | "preferredDays">, date: string) {
  return habit.frequency !== "specific_days" || habit.preferredDays.includes(weekday(date));
}

function dayMet(habit: Habit, entry: HabitEntry | undefined): boolean {
  if (!entry || entry.status !== "done") return false;
  if (habit.frequency === "weekly") return habit.unit ? entry.value > 0 : true;
  return entry.value >= habit.target;
}

export interface WeekDay {
  date: string;
  scheduled: boolean;
  value: number;
  met: boolean;
  skipped: boolean;
  future: boolean;
}

export interface HabitProgress {
  habitId: string;
  name: string;
  frequency: HabitFrequency;
  unit: string | null;
  target: number;
  today: { date: string; scheduled: boolean; value: number; met: boolean };
  week: {
    start: string;
    days: WeekDay[];
    /** Weekly habits: sessions or quantity so far; others: days met. */
    done: number;
    /** Weekly habits: target; others: scheduled days this week. */
    goal: number;
    remaining: number;
    /** Not reachable anymore with the days left this week. */
    atRisk: boolean;
  };
  /** See `streak()` for the exact rule per frequency. */
  streak: { count: number; unit: "days" | "weeks" };
}

export function habitProgress(habit: Habit, entries: HabitEntry[], today: string): HabitProgress {
  const byDate = new Map(entries.filter((e) => e.habitId === habit.id).map((e) => [e.date, e]));
  const start = weekStart(today);
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    const entry = byDate.get(date);
    return {
      date,
      scheduled: isScheduled(habit, date) && date >= habit.startDate,
      value: entry?.status === "done" ? entry.value : 0,
      met: dayMet(habit, entry),
      skipped: entry?.status === "skipped",
      future: date > today,
    };
  });

  let done: number;
  let goal: number;
  let remainingSlots: number;
  if (habit.frequency === "weekly") {
    done = habit.unit ? days.reduce((s, d) => s + d.value, 0) : days.filter((d) => d.met).length;
    goal = habit.target;
    // Days still available this week (today counts unless already met).
    remainingSlots = days.filter((d) => d.date > today || (d.date === today && !d.met)).length;
  } else {
    done = days.filter((d) => d.scheduled && d.met).length;
    goal = days.filter((d) => d.scheduled).length;
    remainingSlots = days.filter(
      (d) => d.scheduled && (d.date > today || (d.date === today && !d.met)),
    ).length;
  }
  const remaining = Math.max(0, round(goal - done));
  const todayEntry = days.find((d) => d.date === today)!;
  const atRisk =
    remaining > 0 &&
    (habit.frequency === "weekly" && habit.unit
      ? remainingSlots === 0
      : remaining > remainingSlots);

  return {
    habitId: habit.id,
    name: habit.name,
    frequency: habit.frequency,
    unit: habit.unit,
    target: habit.target,
    today: {
      date: today,
      scheduled: todayEntry.scheduled,
      value: todayEntry.value,
      met: todayEntry.met,
    },
    week: { start, days, done: round(done), goal, remaining, atRisk },
    streak: streak(habit, byDate, today),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Streaks:
 * - daily / specific_days: consecutive scheduled days met, counting back from today. Today
 *   only counts once met; an unmet today doesn't break the streak until the day is over.
 *   Unscheduled days are skipped over.
 * - weekly: consecutive ISO weeks whose target was reached, counting back from last week;
 *   the current week is added once its target is already reached.
 */
function streak(
  habit: Habit,
  byDate: Map<string, HabitEntry>,
  today: string,
): { count: number; unit: "days" | "weeks" } {
  if (habit.frequency === "weekly") {
    const weekDone = (monday: string) => {
      let total = 0;
      for (let i = 0; i < 7; i++) {
        const e = byDate.get(addDays(monday, i));
        if (!e || e.status !== "done") continue;
        total += habit.unit ? e.value : 1;
      }
      return total >= habit.target;
    };
    let count = 0;
    const current = weekStart(today);
    if (weekDone(current)) count++;
    for (
      let w = addDays(current, -7);
      w >= weekStart(habit.startDate) && count < 520;
      w = addDays(w, -7)
    ) {
      if (!weekDone(w)) break;
      count++;
    }
    return { count, unit: "weeks" };
  }
  let count = 0;
  for (
    let d = today, guard = 0;
    d >= habit.startDate && guard < 3660;
    d = addDays(d, -1), guard++
  ) {
    if (!isScheduled(habit, d)) continue;
    const met = dayMet(habit, byDate.get(d));
    if (met) count++;
    else if (d !== today) break;
  }
  return { count, unit: "days" };
}

/** Local window to load entries for progress + streaks. */
export function progressWindow(today: string): { from: string; to: string } {
  return { from: addDays(weekStart(today), -7 * 26), to: addDays(weekStart(today), 6) };
}

export function localToday(timezone: string, now: Date) {
  return todayIn(timezone, now);
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const date = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
const habitRef = z.string().trim().min(1).max(200).describe('The habit\'s id or name, e.g. "gym".');
const days = z
  .array(z.number().int().min(0).max(6))
  .max(7)
  .describe("Weekdays 0=Sun…6=Sat (required for specific_days).");

export const createHabitInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    frequency: z.enum(["daily", "weekly", "specific_days"]),
    target: z
      .number()
      .positive()
      .max(100000)
      .default(1)
      .describe('Per day (daily/specific_days) or per week (weekly). 3 for "3 times a week".'),
    unit: z
      .string()
      .trim()
      .max(30)
      .optional()
      .describe('For quantities: "liters", "km", "minutes". Omit for done/not-done habits.'),
    preferredDays: days.optional(),
    startDate: date.optional().describe("Local date; defaults to today."),
  })
  .strict()
  .refine((h) => h.frequency !== "specific_days" || (h.preferredDays?.length ?? 0) > 0, {
    message: "specific_days needs preferredDays",
  });

export const updateHabitInput = z
  .object({
    habit: habitRef,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    frequency: z.enum(["daily", "weekly", "specific_days"]).optional(),
    target: z.number().positive().max(100000).optional(),
    unit: z.string().trim().max(30).nullable().optional(),
    preferredDays: days.optional(),
  })
  .strict();

export const checkInInput = z
  .object({
    habit: habitRef,
    date: date.optional().describe("Local date; defaults to today."),
    value: z
      .number()
      .min(0)
      .max(1000000)
      .optional()
      .describe("Quantity for measured habits (1.5 liters, 8 km). Omit for done/not-done habits."),
    mode: z
      .enum(["add", "set"])
      .default("add")
      .describe("add: adds to what's logged that day. set: corrects the day's value."),
    status: z
      .enum(["done", "skipped", "undo"])
      .default("done")
      .describe("undo removes the day's check-in."),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();

export const habitRefInput = z.object({ habit: habitRef }).strict();

export const progressInput = z
  .object({
    habit: habitRef.optional().describe("Omit for all active habits."),
    from: date.optional().describe("For totals over a period, e.g. this month."),
    to: date.optional(),
  })
  .strict();

export type CreateHabitInput = z.infer<typeof createHabitInput>;
