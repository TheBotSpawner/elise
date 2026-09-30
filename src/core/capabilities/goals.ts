import { z } from "zod";

import { isIsoDate } from "../time";
import type { EntrySource } from "./habits";

/**
 * Goals (docs/architecture/10 §27-29). Progress is explicit about where it comes from:
 * - manual: the user's value (binary done, a number toward a target, or a percentage);
 * - linked: derived from linked tasks (share completed) and habits (this week's share met);
 * - hybrid: the average of both.
 * Goals that cannot be measured are never given an invented percentage.
 */

export type GoalStatus = "active" | "completed" | "paused" | "cancelled";
export type ProgressType = "binary" | "numeric" | "percentage";
export type ProgressMode = "manual" | "linked" | "hybrid";
export type LinkType = "habit" | "task" | "goal" | "note";

export interface GoalLink {
  id: string;
  resourceType: LinkType;
  resourceId: string;
  relationship: "supports" | "milestone" | "related";
  /** Resolved for display: the linked record's title/name. */
  title: string | null;
}

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  targetDate: string | null;
  progressType: ProgressType;
  progressMode: ProgressMode;
  startValue: number | null;
  currentValue: number | null;
  targetValue: number | null;
  direction: "increase" | "decrease";
  metric: string | null;
  parentGoalId: string | null;
  completedAt: string | null;
  links: GoalLink[];
  createdAt: string;
  updatedAt: string;
}

export interface NewGoal {
  title: string;
  description?: string | null;
  targetDate?: string | null;
  progressType: ProgressType;
  progressMode: ProgressMode;
  startValue?: number | null;
  currentValue?: number | null;
  targetValue?: number | null;
  direction?: "increase" | "decrease";
  metric?: string | null;
  parentGoalId?: string | null;
}

/** Linked evidence the provider gathers for progress (never computed by the model). */
export interface LinkedStatus {
  tasks: { total: number; completed: number; open: string[] };
  /** Per linked habit: this week's done / goal. */
  habits: { name: string; done: number; goal: number }[];
}

export interface GoalsProvider {
  list(opts: { status: GoalStatus | "all" }): Promise<Goal[]>;
  find(ref: string): Promise<Goal[]>;
  create(goal: NewGoal, source: EntrySource): Promise<Goal>;
  update(id: string, patch: Partial<NewGoal> & { status?: GoalStatus }): Promise<Goal>;
  archive(id: string): Promise<Goal>;
  link(
    goalId: string,
    link: { resourceType: LinkType; resourceId: string; relationship: GoalLink["relationship"] },
  ): Promise<Goal>;
  unlink(goalId: string, link: { resourceType: LinkType; resourceId: string }): Promise<Goal>;
  linkedStatus(goal: Goal, today: string): Promise<LinkedStatus>;
  /** ELISE tasks by id or title, for linking. */
  findTasks(ref: string): Promise<{ id: string; title: string }[]>;
}

export interface GoalProgress {
  /** 0–100, or null when the goal has no measurable progress. */
  percent: number | null;
  basis: string;
  manual: number | null;
  linked: number | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function manualPercent(goal: Goal): number | null {
  if (goal.status === "completed") return 100;
  switch (goal.progressType) {
    case "binary":
      return 0;
    case "percentage":
      return goal.currentValue === null ? null : clamp(goal.currentValue);
    case "numeric": {
      const { currentValue: cur, targetValue: target } = goal;
      if (cur === null || target === null) return null;
      const start = goal.startValue ?? (goal.direction === "decrease" ? null : 0);
      if (start === null || start === target) return cur === target ? 100 : null;
      return clamp(((cur - start) / (target - start)) * 100);
    }
  }
}

export function linkedPercent(status: LinkedStatus): number | null {
  const parts: number[] = [];
  if (status.tasks.total > 0) parts.push((status.tasks.completed / status.tasks.total) * 100);
  for (const h of status.habits) if (h.goal > 0) parts.push(Math.min(1, h.done / h.goal) * 100);
  return parts.length ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
}

export function goalProgress(goal: Goal, status: LinkedStatus): GoalProgress {
  const manual = manualPercent(goal);
  const linked = linkedPercent(status);
  if (goal.status === "completed") return { percent: 100, basis: "completed", manual, linked };
  switch (goal.progressMode) {
    case "manual":
      return {
        percent: manual,
        basis: manual === null ? "not measurable yet" : "manual",
        manual,
        linked,
      };
    case "linked":
      return {
        percent: linked,
        basis: linked === null ? "nothing linked yet" : "linked tasks and habits",
        manual,
        linked,
      };
    case "hybrid": {
      const values = [manual, linked].filter((v): v is number => v !== null);
      return {
        percent: values.length ? clamp(values.reduce((a, b) => a + b, 0) / values.length) : null,
        basis: "average of manual progress and linked tasks/habits",
        manual,
        linked,
      };
    }
  }
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const date = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
const goalRef = z.string().trim().min(1).max(300).describe("The goal's id or title.");

export const createGoalInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).optional(),
    targetDate: date.optional(),
    progressType: z
      .enum(["binary", "numeric", "percentage"])
      .default("binary")
      .describe(
        "binary: done or not · numeric: a number toward a target · percentage: 0–100 by hand.",
      ),
    progressMode: z.enum(["manual", "linked", "hybrid"]).default("manual"),
    startValue: z.number().optional(),
    currentValue: z.number().optional(),
    targetValue: z
      .number()
      .optional()
      .describe("Numeric target in `metric` units. Times as minutes (1:45 → 105)."),
    direction: z
      .enum(["increase", "decrease"])
      .default("increase")
      .describe("decrease for 'under X' goals like race times."),
    metric: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe('e.g. "minutes", "clients", "USD/month".'),
    parentGoal: goalRef.optional(),
  })
  .strict();

export const updateGoalInput = z
  .object({
    goal: goalRef,
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    targetDate: date.nullable().optional(),
    progressType: z.enum(["binary", "numeric", "percentage"]).optional(),
    progressMode: z.enum(["manual", "linked", "hybrid"]).optional(),
    startValue: z.number().nullable().optional(),
    currentValue: z.number().nullable().optional(),
    targetValue: z.number().nullable().optional(),
    direction: z.enum(["increase", "decrease"]).optional(),
    metric: z.string().trim().max(60).nullable().optional(),
    status: z
      .enum(["active", "paused", "cancelled"])
      .optional()
      .describe("active resumes a paused goal."),
  })
  .strict();

export const goalRefInput = z.object({ goal: goalRef }).strict();

export const listGoalsInput = z
  .object({
    status: z.enum(["active", "completed", "paused", "cancelled", "all"]).default("active"),
  })
  .strict();

export const linkInput = z
  .object({
    goal: goalRef,
    resourceType: z.enum(["habit", "task", "goal", "note"]),
    resource: z.string().trim().min(1).max(300).describe("The linked record's id or name/title."),
    relationship: z.enum(["supports", "milestone", "related"]).default("supports"),
  })
  .strict();
