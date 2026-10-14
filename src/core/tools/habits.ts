import { z } from "zod";

import { syncHabitGoals } from "./goals";
import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  checkInDate,
  checkInInput,
  createHabitInput,
  habitProgress,
  habitRefInput,
  progressInput,
  progressWindow,
  updateHabitInput,
  type Habit,
  type HabitProgress,
} from "../capabilities/habits";
import { AppError } from "../errors";
import {
  buildHabitStatsReport,
  entriesWindow,
  habitRange,
  suggestHabitIcon,
  type HabitView,
} from "../habits/analytics";
import { PERIODS, resolvePeriod } from "../periods";
import { addDays, isIsoDate, todayIn } from "../time";

function provider(env: ToolRunEnv) {
  return env.providers.get("habits", env.binding);
}

async function resolve(env: ToolRunEnv, ref: string): Promise<Habit> {
  return pickOne(await provider(env).find(ref), ref, "habit", (h) => h.name);
}

const today = (env: ToolRunEnv) => todayIn(env.ctx.timezone, env.ctx.now);

/** Pauses with an end date resume on that local day (ADR-053), before anything is read. */
export async function resumeDuePauses(env: ToolRunEnv): Promise<void> {
  const p = provider(env);
  const day = today(env);
  const paused = (await p.list({ includeInactive: true })).filter(
    (h) => !h.active && h.pausedUntil && h.pausedUntil <= day,
  );
  for (const h of paused) await p.update(h.id, { active: true });
}

/** Progress computed in code for these habits (current week, today, streak). */
export async function progressFor(env: ToolRunEnv, habits: Habit[]): Promise<HabitProgress[]> {
  if (!habits.length) return [];
  const day = today(env);
  const window = progressWindow(day);
  const entries = await provider(env).entries(
    habits.map((h) => h.id),
    window.from,
    window.to,
  );
  return habits.map((h) => habitProgress(h, entries, day));
}

export function progressForModel(p: HabitProgress) {
  const unit = p.unit ? ` ${p.unit}` : "";
  return {
    habitId: p.habitId,
    name: p.name,
    frequency: p.frequency,
    target: `${p.target}${unit}${p.frequency === "weekly" ? "/week" : "/day"}`,
    today: p.today.scheduled ? { value: p.today.value, met: p.today.met } : "not scheduled today",
    thisWeek: `${p.week.done}${p.frequency === "weekly" ? unit : ""} / ${p.week.goal}${p.frequency === "weekly" ? unit : " days"}`,
    remainingThisWeek: p.week.remaining,
    ...(p.week.atRisk ? { atRisk: "can no longer reach this week's target" } : {}),
    streak: `${p.streak.count} ${p.streak.unit}`,
  };
}

const result = async (env: ToolRunEnv, habits: Habit[], extra: Record<string, unknown> = {}) => {
  const progress = await progressFor(env, habits);
  return {
    output: { ...extra, habits: progress.map(progressForModel) },
    display: { kind: "habits" as const, progress },
  };
};

export const listHabitsTool: ToolDefinition = {
  name: "habits.list",
  capability: "habits",
  operation: "list",
  description:
    "The user's habits with this week's progress, today's status and streaks (computed by ELISE).",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List habits" };
  },
  async run(_input, env) {
    await resumeDuePauses(env);
    return result(env, await provider(env).list({ includeInactive: false }));
  },
};

export const getProgressTool: ToolDefinition = {
  name: "habits.getProgress",
  capability: "habits",
  operation: "getProgress",
  description:
    'Deterministic habit progress: this week, today, streak; with from/to also totals over a period ("how many times did I run this month?"). Never compute these yourself.',
  input: progressInput,
  async describe() {
    return { summary: "Habit progress" };
  },
  async run(raw, env) {
    const q = progressInput.parse(raw);
    await resumeDuePauses(env);
    const habits = q.habit
      ? [await resolve(env, q.habit)]
      : await provider(env).list({ includeInactive: false });
    const extra: Record<string, unknown> = {};
    if (q.from) {
      const to = q.to ?? today(env);
      const entries = (
        await provider(env).entries(
          habits.map((h) => h.id),
          q.from,
          to,
        )
      ).filter((e) => e.status === "done");
      extra.period = {
        from: q.from,
        to,
        totals: habits.map((h) => {
          const own = entries.filter((e) => e.habitId === h.id);
          return {
            name: h.name,
            daysDone: own.length,
            ...(h.unit ? { total: `${own.reduce((s, e) => s + e.value, 0)} ${h.unit}` } : {}),
          };
        }),
      };
    }
    return result(env, habits, extra);
  },
};

export const createHabitTool: ToolDefinition = {
  name: "habits.create",
  capability: "habits",
  operation: "create",
  description:
    'Create a habit. "Run 3 times a week" → frequency weekly, target 3. "Drink 2 liters a day" → daily, target 2, unit liters. "Run Tue and Sat" → specific_days [2,6].',
  input: createHabitInput,
  async describe(raw) {
    return { summary: `Create habit “${createHabitInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const h = createHabitInput.parse(raw);
    const habit = await provider(env).create(
      {
        name: h.name,
        description: h.description ?? null,
        frequency: h.frequency,
        target: h.target,
        unit: h.unit ?? null,
        preferredDays: h.preferredDays ?? [],
        startDate: h.startDate ?? today(env),
        // The model's emoji, else a deterministic one from the name; the user can change it.
        icon: h.icon ?? suggestHabitIcon(h.name),
      },
      sourceOf(env.ctx),
    );
    const notes = h.goals?.length ? await syncHabitGoals(env, habit.id, h.goals) : [];
    return {
      ...(await result(env, [habit], { created: true, ...(notes.length ? { notes } : {}) })),
      target: { type: "habit", id: habit.id },
    };
  },
};

export const updateHabitTool: ToolDefinition = {
  name: "habits.update",
  capability: "habits",
  operation: "update",
  description:
    'Change a habit (name, frequency, target, unit, days). "Change gym to 3 times per week" → target 3.',
  input: updateHabitInput,
  async describe(raw) {
    return { summary: `Update habit “${updateHabitInput.parse(raw).habit}”` };
  },
  async run(raw, env) {
    const u = updateHabitInput.parse(raw);
    const habit = await resolve(env, u.habit);
    // Only its related goals changed: the habit itself stays as it is.
    const onlyGoals = Object.keys(u).every((k) => k === "habit" || k === "goals");
    const updated = onlyGoals
      ? habit
      : await provider(env).update(habit.id, {
          name: u.name,
          description: u.description,
          frequency: u.frequency,
          target: u.target,
          unit: u.unit,
          preferredDays: u.preferredDays,
          icon: u.icon,
        });
    const notes = u.goals ? await syncHabitGoals(env, habit.id, u.goals) : [];
    return {
      ...(await result(env, [updated], { updated: true, ...(notes.length ? { notes } : {}) })),
      target: { type: "habit", id: habit.id },
    };
  },
};

export const checkInTool: ToolDefinition = {
  name: "habits.checkIn",
  capability: "habits",
  operation: "checkIn",
  description:
    'Log a habit for a day (default today). "Mark gym as done" → no value. "Drank 1.5 liters" → value 1.5 (adds to the day). "Actually it was 2 liters" → mode set. status skipped for "I skipped it", undo to remove the day\'s check-in. One entry per habit per day, so repeating never duplicates.',
  input: checkInInput,
  async describe(raw) {
    return { summary: `Check in “${checkInInput.parse(raw).habit}”` };
  },
  async run(raw, env) {
    const c = checkInInput.parse(raw);
    const habit = await resolve(env, c.habit);
    const date = checkInDate(today(env), c);
    if (date > today(env))
      throw new AppError("VALIDATION_ERROR", "A check-in can't be for a future day", {
        recovery: "review",
      });
    if (c.status === "undo") await provider(env).removeEntry(habit.id, date);
    else
      await provider(env).checkIn(
        habit.id,
        {
          date,
          // Done/not-done habits log one unit; measured habits log what the user said.
          value: c.value ?? (habit.unit ? habit.target : 1),
          // A past day without an explicit mode is a correction of that day (ADR-053).
          mode: c.value === undefined ? "set" : (c.mode ?? (date === today(env) ? "add" : "set")),
          status: c.status,
          notes: c.notes ?? null,
        },
        sourceOf(env.ctx),
      );
    return { ...(await result(env, [habit], { date })), target: { type: "habit", id: habit.id } };
  },
};

const pauseInput = habitRefInput
  .extend({
    resume: z.boolean().default(false).describe("true to resume a paused habit."),
    days: z
      .number()
      .int()
      .min(1)
      .max(366)
      .optional()
      .describe('"por dos semanas" → 14. ELISE resumes it then.'),
    until: z
      .string()
      .refine(isIsoDate, "Expected YYYY-MM-DD")
      .optional()
      .describe("Resume on this local date."),
  })
  .strict();

export const pauseHabitTool: ToolDefinition = {
  name: "habits.pause",
  capability: "habits",
  operation: "pause",
  description:
    "Pause a habit (kept with its history; no targets while paused), optionally for N days, or resume it.",
  input: pauseInput,
  async describe(raw) {
    const p = pauseInput.parse(raw);
    return { summary: `${p.resume ? "Resume" : "Pause"} habit “${p.habit}”` };
  },
  async run(raw, env) {
    const { habit: ref, resume, days, until } = pauseInput.parse(raw);
    const habit = await resolve(env, ref);
    const end = resume ? null : (until ?? (days ? addDays(today(env), days) : null));
    const updated = await provider(env).update(habit.id, {
      active: resume,
      ...(resume ? {} : { pausedUntil: end }),
    });
    return {
      output: {
        habit: updated.name,
        active: updated.active,
        ...(end ? { resumesOn: end } : {}),
      },
      target: { type: "habit", id: habit.id },
    };
  },
};

export const archiveHabitTool: ToolDefinition = {
  name: "habits.archive",
  capability: "habits",
  operation: "archive",
  description:
    "Archive a habit the user no longer wants (history kept). Needs the user's approval.",
  input: habitRefInput,
  async describe(raw, env) {
    const habit = await resolve(env, habitRefInput.parse(raw).habit);
    return { summary: `Archive habit “${habit.name}”`, target: { type: "habit", id: habit.id } };
  },
  async run(raw, env) {
    const habit = await resolve(env, habitRefInput.parse(raw).habit);
    await provider(env).archive(habit.id);
    return { output: { archived: habit.name }, target: { type: "habit", id: habit.id } };
  },
};

export const restoreHabitTool: ToolDefinition = {
  name: "habits.restore",
  capability: "habits",
  operation: "restore",
  description: "Bring an archived habit back to active tracking (its history is intact).",
  input: habitRefInput,
  async describe(raw) {
    return { summary: `Restore habit “${habitRefInput.parse(raw).habit}”` };
  },
  async run(raw, env) {
    const ref = habitRefInput.parse(raw).habit;
    const p = provider(env);
    const archived = await p.list({ includeInactive: true, archived: true });
    const habit = pickOne(
      archived.filter((h) => h.id === ref || h.name.toLowerCase().includes(ref.toLowerCase())),
      ref,
      "habit",
      (h) => h.name,
    );
    if (!p.unarchive) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    const restored = await p.unarchive(habit.id);
    return { ...(await result(env, [restored])), target: { type: "habit", id: habit.id } };
  },
};

export const deleteHabitTool: ToolDefinition = {
  name: "habits.delete",
  capability: "habits",
  operation: "delete",
  description:
    "Delete a habit and ALL its history for good. Only when the user explicitly says delete/borrar (archive keeps history). Needs approval.",
  input: habitRefInput,
  async describe(raw, env) {
    const habit = await resolve(env, habitRefInput.parse(raw).habit);
    return {
      summary: `Delete habit “${habit.name}” and its history`,
      target: { type: "habit", id: habit.id },
    };
  },
  async run(raw, env) {
    const habit = await resolve(env, habitRefInput.parse(raw).habit);
    const p = provider(env);
    if (!p.remove) throw new AppError("CAPABILITY_UNAVAILABLE", "Not supported here");
    await p.remove(habit.id);
    return { output: { deleted: habit.name }, target: { type: "habit", id: habit.id } };
  },
};

const statsInput = z
  .object({
    habit: z.string().trim().min(1).max(200).optional().describe("Omit for all active habits."),
    view: z
      .enum(["week", "month", "year"])
      .optional()
      .describe("This week (default), this month, this year."),
    period: z
      .enum(PERIODS)
      .optional()
      .describe(
        'Any calendar period: "el último trimestre" → last_quarter, "el mes pasado" → last_month.',
      ),
    from: z.string().refine(isIsoDate).optional(),
    to: z.string().refine(isIsoDate).optional(),
  })
  .strict();

const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)}%`);

export const habitStatsTool: ToolDefinition = {
  name: "habits.getStats",
  capability: "habits",
  operation: "getStats",
  description:
    '"¿Cómo vengo con mis hábitos este mes?", "¿cuál estoy cumpliendo menos?", "estadísticas de Workout del último trimestre": completion %, done/target, streaks, trend, comparison with the previous period and weekdays most missed — all computed by ELISE. Quote these numbers; never compute them.',
  input: statsInput,
  async describe() {
    return { summary: "Habit statistics" };
  },
  async run(raw, env) {
    const q = statsInput.parse(raw);
    await resumeDuePauses(env);
    const day = today(env);
    const p = provider(env);
    const habits = q.habit
      ? [await resolve(env, q.habit)]
      : await p.list({ includeInactive: false });
    const view: HabitView = q.from || q.period ? "custom" : (q.view ?? "week");
    const custom = q.from
      ? { from: q.from, to: q.to ?? day }
      : q.period
        ? resolvePeriod(q.period, day)
        : undefined;
    const range = habitRange(view, day, custom);
    const window = entriesWindow(range, day);
    // One habit: its whole history, for the longest streak.
    const from = q.habit ? [habits[0]!.startDate, window.from].sort()[0]! : window.from;
    const entries = await p.entries(
      habits.map((h) => h.id),
      from,
      window.to,
    );
    const report = buildHabitStatsReport(habits, entries, range, day, {
      fullHistory: Boolean(q.habit),
    });
    const best = report.overall.bestStreak;
    return {
      output: {
        range: { from: range.from, to: range.to },
        overall: {
          completion: pct(report.overall.rate),
          previousPeriod: pct(report.overall.previousRate),
          ...(report.overall.delta !== null ? { changePoints: report.overall.delta } : {}),
          activeHabits: report.overall.active,
          ...(best ? { bestStreak: `${best.name}: ${best.count} ${best.unit}` } : {}),
        },
        habits: report.habits.map((h) => ({
          name: h.name,
          done: `${h.done} / ${h.goal}${h.unit ? ` ${h.unit}` : ""}`,
          completion: pct(h.rate),
          previousPeriod: pct(h.previousRate),
          streak: `${h.streak.count} ${h.streak.unit}`,
          ...(h.longest ? { longestStreak: `${h.longest.count} ${h.longest.unit}` } : {}),
          ...(h.quantity
            ? {
                total: `${h.quantity.total} ${h.unit}`,
                averagePerActiveDay: h.quantity.perActiveDay,
              }
            : {}),
          ...(h.attainment !== null ? { targetAttainment: pct(h.attainment) } : {}),
        })),
        mostMissedWeekdays: report.weekdays
          .filter((w) => w.missed > 0)
          .sort((a, b) => b.missed / b.expected - a.missed / a.expected)
          .slice(0, 2)
          .map((w) => ({ weekday: w.weekday, missed: `${w.missed} / ${w.expected}` })),
        note: "Completion counts days up to today only. Explain; don't recompute.",
      },
      display: { kind: "habit_stats" as const, report },
    };
  },
};

export const HABIT_TOOLS = [
  habitStatsTool,
  restoreHabitTool,
  deleteHabitTool,
  listHabitsTool,
  getProgressTool,
  createHabitTool,
  updateHabitTool,
  checkInTool,
  pauseHabitTool,
  archiveHabitTool,
];
