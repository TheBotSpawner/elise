import { z } from "zod";

import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
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
import { todayIn } from "../time";

function provider(env: ToolRunEnv) {
  return env.providers.get("habits", env.binding);
}

async function resolve(env: ToolRunEnv, ref: string): Promise<Habit> {
  return pickOne(await provider(env).find(ref), ref, "habit", (h) => h.name);
}

const today = (env: ToolRunEnv) => todayIn(env.ctx.timezone, env.ctx.now);

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
      },
      sourceOf(env.ctx),
    );
    return {
      ...(await result(env, [habit], { created: true })),
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
    const updated = await provider(env).update(habit.id, {
      name: u.name,
      description: u.description,
      frequency: u.frequency,
      target: u.target,
      unit: u.unit,
      preferredDays: u.preferredDays,
    });
    return {
      ...(await result(env, [updated], { updated: true })),
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
    const date = c.date ?? today(env);
    if (c.status === "undo") await provider(env).removeEntry(habit.id, date);
    else
      await provider(env).checkIn(
        habit.id,
        {
          date,
          // Done/not-done habits log one unit; measured habits log what the user said.
          value: c.value ?? (habit.unit ? habit.target : 1),
          mode: c.value === undefined ? "set" : c.mode,
          status: c.status,
          notes: c.notes ?? null,
        },
        sourceOf(env.ctx),
      );
    return { ...(await result(env, [habit], { date })), target: { type: "habit", id: habit.id } };
  },
};

const pauseInput = habitRefInput
  .extend({ resume: z.boolean().default(false).describe("true to resume a paused habit.") })
  .strict();

export const pauseHabitTool: ToolDefinition = {
  name: "habits.pause",
  capability: "habits",
  operation: "pause",
  description: "Pause a habit (kept with its history; no longer tracked), or resume it.",
  input: pauseInput,
  async describe(raw) {
    const p = pauseInput.parse(raw);
    return { summary: `${p.resume ? "Resume" : "Pause"} habit “${p.habit}”` };
  },
  async run(raw, env) {
    const { habit: ref, resume } = pauseInput.parse(raw);
    const habit = await resolve(env, ref);
    const updated = await provider(env).update(habit.id, { active: resume });
    return {
      output: { habit: updated.name, active: updated.active },
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

export const HABIT_TOOLS = [
  listHabitsTool,
  getProgressTool,
  createHabitTool,
  updateHabitTool,
  checkInTool,
  pauseHabitTool,
  archiveHabitTool,
];
