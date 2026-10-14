import { z } from "zod";

import { isSingleEmoji } from "../emoji";
import type { EntrySource } from "./habits";
import { GOAL_PERIODS } from "../goals/periods";
import { isIsoDate } from "../time";

/**
 * Goals and Visions (docs/architecture/10 §27-29, ADR-055).
 *
 * A Vision is a long-term, qualitative direction: no metric, no deadline, no percentage.
 * A Goal is a concrete outcome. Its time horizon is a property (period start/end), never a
 * separate kind of goal; its deadline (`targetDate`) follows the period's end unless overridden.
 *
 * Progress is explicit about where it comes from, and always computed here:
 * - manual: the user's value (binary done, a number toward a target, a percentage);
 * - linked: numeric goals add what their progress-driving links contributed inside the goal's
 *   window — each met habit day counts 1 (its quantity when the habit's unit is the goal's
 *   metric), each completed task counts 1. Binary/percentage goals take the share of their
 *   driving tasks completed. Habits never drive binary/percentage or lower-is-better goals;
 * - hybrid: numeric goals add the linked amount to the manual value; percentage goals average.
 * Goals that cannot be measured are never given an invented percentage.
 */

export type GoalStatus = "active" | "completed" | "paused" | "cancelled";
export type ProgressType = "binary" | "numeric" | "percentage";
export type ProgressMode = "manual" | "linked" | "hybrid";
export type LinkType = "habit" | "task" | "goal" | "note" | "vision";
export type Relationship = "supports" | "milestone" | "related";

export interface GoalLink {
  id: string;
  resourceType: LinkType;
  resourceId: string;
  /** Habits and tasks: supports/milestone drive progress, related is context only. */
  relationship: Relationship;
  /** Resolved for display: the linked record's title/name. */
  title: string | null;
  /** The linked habit's or Vision's icon. */
  icon?: string | null;
}

/** Does this link feed the goal's linked progress? */
export const drivesProgress = (l: Pick<GoalLink, "resourceType" | "relationship">) =>
  (l.resourceType === "habit" || l.resourceType === "task") && l.relationship !== "related";

export interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  /** The deadline. */
  targetDate: string | null;
  progressType: ProgressType;
  progressMode: ProgressMode;
  startValue: number | null;
  currentValue: number | null;
  targetValue: number | null;
  direction: "increase" | "decrease";
  /** Unit of a numeric goal ("clientes", "minutes"). */
  metric: string | null;
  /** Money goals: an ISO currency code. */
  currency?: string | null;
  icon?: string | null;
  area?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** "Contributes to" this goal. */
  parentGoalId: string | null;
  completedAt: string | null;
  archived?: boolean;
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
  currency?: string | null;
  icon?: string | null;
  area?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  parentGoalId?: string | null;
}

export type GoalPatch = Partial<NewGoal> & { status?: GoalStatus };

export type VisionStatus = "active" | "achieved" | "archived";

export interface Vision {
  id: string;
  title: string;
  description: string | null;
  icon: string | null;
  area: string | null;
  status: VisionStatus;
  achievedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewVision {
  title: string;
  description?: string | null;
  icon?: string | null;
  area?: string | null;
}

export type ProgressSource = "manual" | "habit" | "task" | "integration" | "system";

/** One entry of a goal's append-only progress history. */
export interface ProgressEvent {
  id: string;
  goalId: string;
  previousValue: number | null;
  newValue: number | null;
  sourceType: ProgressSource;
  sourceId: string | null;
  note: string | null;
  occurredAt: string;
}

/** Linked evidence the provider gathers for progress (never computed by the model). */
export interface LinkedStatus {
  /** Progress-driving tasks. */
  tasks: { total: number; completed: number; open: string[] };
  /** Every linked habit: this week's done / goal, and what it added inside the goal window. */
  habits: {
    id?: string;
    name: string;
    icon?: string | null;
    done: number;
    goal: number;
    drives?: boolean;
    contribution?: number;
  }[];
  /** Dated linked amounts (met habit days, completed tasks), oldest first, for history. */
  contributions?: { date: string; amount: number }[];
}

export interface GoalsProvider {
  list(opts: { status: GoalStatus | "all"; archived?: boolean }): Promise<Goal[]>;
  find(ref: string): Promise<Goal[]>;
  create(goal: NewGoal, source: EntrySource): Promise<Goal>;
  update(id: string, patch: GoalPatch): Promise<Goal>;
  archive(id: string): Promise<Goal>;
  unarchive?(id: string): Promise<Goal>;
  /** Destructive: the goal, its links and its history. */
  remove?(id: string): Promise<void>;
  link(
    goalId: string,
    link: { resourceType: LinkType; resourceId: string; relationship: Relationship },
  ): Promise<Goal>;
  unlink(goalId: string, link: { resourceType: LinkType; resourceId: string }): Promise<Goal>;
  linkedStatus(goal: Goal, today: string, timezone?: string): Promise<LinkedStatus>;
  /** The same for many goals at once (a fixed number of queries). */
  linkedStatuses?(
    goals: Goal[],
    today: string,
    timezone?: string,
  ): Promise<Map<string, LinkedStatus>>;
  /** ELISE tasks by id or title, for linking. */
  findTasks(ref: string): Promise<{ id: string; title: string }[]>;
  /** Newest first. */
  history?(goalId: string, limit: number): Promise<ProgressEvent[]>;
  record?(
    goalId: string,
    e: {
      previousValue: number | null;
      newValue: number | null;
      sourceType: ProgressSource;
      sourceId?: string | null;
      note?: string | null;
    },
  ): Promise<void>;
  listVisions?(opts: { includeArchived: boolean }): Promise<Vision[]>;
  findVision?(ref: string): Promise<Vision[]>;
  createVision?(v: NewVision, source: EntrySource): Promise<Vision>;
  updateVision?(id: string, patch: Partial<NewVision> & { status?: VisionStatus }): Promise<Vision>;
  removeVision?(id: string): Promise<void>;
}

// ── Deterministic progress ───────────────────────────────────────────────────

export interface GoalProgress {
  /** 0–100, or null when the goal has no measurable progress. */
  percent: number | null;
  /** The number the percent comes from (numeric: in the goal's units; percentage: 0–100). */
  value: number | null;
  basis: "completed" | "manual" | "linked" | "hybrid" | "none";
  /** Percent from the manual value alone. */
  manual: number | null;
  /** Percent from linked records alone. */
  linked: number | null;
  /** What linked records added to a numeric goal's value (null: nothing drives it). */
  linkedValue: number | null;
  /** The target is met; completing the goal is still the user's call. */
  reached: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Where `value` sits from `start` to `target` (works for lower-is-better too). */
export function towardTarget(value: number, start: number | null, target: number): number | null {
  if (start === null || start === target) return value === target ? 100 : null;
  return clamp(((value - start) / (target - start)) * 100);
}

/** What progress-driving links added (null when nothing drives the goal). */
export function linkedAmount(status: LinkedStatus): number | null {
  const drivers = status.habits.filter((h) => h.drives);
  if (!drivers.length && !status.tasks.total) return null;
  return round2(drivers.reduce((s, h) => s + (h.contribution ?? 0), 0) + status.tasks.completed);
}

/** Kept for callers that only want the manual percent. */
export function manualPercent(goal: Goal): number | null {
  return goalProgress(goal, NO_LINKS).manual;
}

export const NO_LINKS: LinkedStatus = { tasks: { total: 0, completed: 0, open: [] }, habits: [] };

export function goalProgress(goal: Goal, status: LinkedStatus): GoalProgress {
  const taskShare = status.tasks.total
    ? clamp((status.tasks.completed / status.tasks.total) * 100)
    : null;
  let manual: number | null = null;
  let linked: number | null = null;
  let value: number | null = null;
  let percent: number | null = null;
  let linkedValue: number | null = null;
  let reached = false;

  if (goal.progressType === "numeric") {
    const increase = goal.direction !== "decrease";
    const target = goal.targetValue;
    const start = goal.startValue ?? (increase ? 0 : null);
    // Linked records only ever add (sessions, articles); a lower-is-better value is manual.
    linkedValue = increase && goal.progressMode !== "manual" ? linkedAmount(status) : null;
    const at = (v: number | null) =>
      v === null || target === null ? null : towardTarget(v, start, target);
    manual = at(goal.currentValue);
    linked = linkedValue === null ? null : at((start ?? 0) + linkedValue);
    if (goal.progressMode === "manual") value = goal.currentValue;
    else if (goal.progressMode === "linked")
      value = linkedValue === null ? null : round2((start ?? 0) + linkedValue);
    // Hybrid: the manual value is the base the linked amount adds to.
    else
      value =
        linkedValue === null
          ? goal.currentValue
          : round2((goal.currentValue ?? start ?? 0) + linkedValue);
    percent = at(value);
    reached = value !== null && target !== null && (increase ? value >= target : value <= target);
  } else if (goal.progressType === "percentage") {
    manual = goal.currentValue === null ? null : clamp(goal.currentValue);
    linked = taskShare;
    const parts = [manual, linked].filter((v): v is number => v !== null);
    percent =
      goal.progressMode === "manual"
        ? manual
        : goal.progressMode === "linked"
          ? linked
          : parts.length
            ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length)
            : null;
    value = percent;
    reached = percent !== null && percent >= 100;
  } else {
    // Binary: not done until completed by hand, or every driving task is done.
    manual = 0;
    linked = taskShare;
    if (goal.progressMode === "manual") percent = 0;
    else percent = taskShare ?? (goal.progressMode === "hybrid" ? 0 : null);
    reached = goal.progressMode !== "manual" && taskShare === 100;
  }

  if (goal.status === "completed")
    return { percent: 100, value, basis: "completed", manual, linked, linkedValue, reached: true };
  return {
    percent,
    value,
    basis: percent === null ? "none" : goal.progressMode,
    manual,
    linked,
    linkedValue,
    reached,
  };
}

/** The basis in words, for the model. */
export function basisText(p: GoalProgress): string {
  return {
    completed: "completed",
    manual: "manual value",
    linked: "linked habits/tasks",
    hybrid: "manual value plus linked habits/tasks",
    none: "not measurable yet",
  }[p.basis];
}

// ── Validation (server-side, also used by the forms) ─────────────────────────

export type GoalProblem =
  | "target_required"
  | "target_positive"
  | "target_direction"
  | "start_required"
  | "percentage_range"
  | "currency_required"
  | "period_order";

/** Deterministic checks of a goal's fields after a create or an update is applied. */
export function goalProblems(g: Partial<NewGoal>): GoalProblem[] {
  const out: GoalProblem[] = [];
  if (g.progressType === "numeric") {
    const t = g.targetValue;
    if (t === null || t === undefined || !Number.isFinite(t)) out.push("target_required");
    else if (g.direction === "decrease") {
      if (g.startValue === null || g.startValue === undefined) out.push("start_required");
      else if (t >= g.startValue) out.push("target_direction");
      if (t < 0) out.push("target_positive");
    } else {
      if (t <= 0) out.push("target_positive");
      else if (g.startValue !== null && g.startValue !== undefined && t <= g.startValue)
        out.push("target_direction");
    }
  }
  if (
    g.progressType === "percentage" &&
    g.currentValue !== null &&
    g.currentValue !== undefined &&
    (g.currentValue < 0 || g.currentValue > 100)
  )
    out.push("percentage_range");
  if (g.currency !== undefined && g.currency !== null && !/^[A-Z]{3}$/.test(g.currency))
    out.push("currency_required");
  if (g.periodStart && g.periodEnd && g.periodStart > g.periodEnd) out.push("period_order");
  return out;
}

export const PROBLEM_TEXT: Record<GoalProblem, string> = {
  target_required: "A numeric goal needs a target value",
  target_positive: "The target must be greater than 0",
  target_direction:
    "The target must be above the starting value (or below it for lower-is-better goals)",
  start_required: "A lower-is-better goal needs its current starting value",
  percentage_range: "A percentage goes from 0 to 100",
  currency_required: "Use a 3-letter currency code (ARS, USD)",
  period_order: "The period must start before it ends",
};

/** Would making `parentId` the parent of `goalId` loop back? (`parents`: id → parent id). */
export function createsCycle(
  goalId: string,
  parentId: string | null,
  parents: ReadonlyMap<string, string | null>,
): boolean {
  for (let cur = parentId, guard = 0; cur && guard < 100; cur = parents.get(cur) ?? null, guard++)
    if (cur === goalId) return true;
  return false;
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const date = z.string().refine(isIsoDate, "Expected YYYY-MM-DD");
const goalRef = z.string().trim().min(1).max(300).describe("The goal's id or title.");
const visionRef = z.string().trim().min(1).max(500).describe("The Vision's id or name.");
export const isGoalIcon = isSingleEmoji;
const icon = z.string().trim().refine(isGoalIcon, "Expected one emoji");
const area = z.string().trim().min(1).max(60);
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());

/** A day, or a whole month ("2027-01" = from its first day / to its last day). */
const dayOrMonth = z
  .string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, "Expected YYYY-MM-DD or YYYY-MM")
  .refine((v) => v.length === 7 || isIsoDate(v), "Invalid date");

const period = {
  period: z
    .enum(GOAL_PERIODS)
    .optional()
    .describe(
      'Shortcut that fills the period dates: "este año" → this_year, "de hoy hasta fin de año" → rest_of_year, "este trimestre" → this_quarter, "el próximo trimestre" → next_quarter, "en los próximos seis meses" → months_6, none to clear. For explicit dates use from/to instead.',
    ),
  year: z.number().int().min(2000).max(2100).optional().describe("For q1–q4."),
  from: dayOrMonth
    .optional()
    .describe(
      'Period start: "entre el 15 de noviembre y el 10 de febrero" → 2026-11-15; "entre enero y abril" → "2027-01".',
    ),
  to: dayOrMonth.optional().describe('Period end ("2027-02-10", or "2027-04" = end of April).'),
  duration: z
    .object({
      months: z.number().int().min(0).max(120).optional(),
      weeks: z.number().int().min(0).max(520).optional(),
      days: z.number().int().min(0).max(3650).optional(),
    })
    .strict()
    .optional()
    .describe(
      '"Que dure tres meses" → {months: 3}: from `from` (or the current start, or today). ELISE computes the end.',
    ),
};

const habitLinks = z
  .array(
    z
      .object({
        habit: z.string().trim().min(1).max(200),
        useForProgress: z
          .boolean()
          .default(false)
          .describe("true only when each check-in of this habit should count toward the goal."),
      })
      .strict(),
  )
  .max(10);

const measureFields = {
  progressType: z
    .enum(["binary", "numeric", "percentage"])
    .describe(
      "binary: done or not · numeric: a number toward a target (counts, money, times) · percentage: 0–100 by hand.",
    ),
  progressMode: z.enum(["manual", "linked", "hybrid"]),
  startValue: z.number().finite().optional(),
  currentValue: z.number().finite().optional(),
  targetValue: z
    .number()
    .finite()
    .optional()
    .describe("Numeric target in `metric` units. Times as minutes (1:45 → 105)."),
  direction: z
    .enum(["increase", "decrease"])
    .describe("decrease for lower-is-better goals (race times, weight, hours spent)."),
  metric: z
    .string()
    .trim()
    .max(60)
    .optional()
    .describe('The unit: "clientes", "artículos", "minutes".'),
  currency: currency.optional().describe("Money goals: ARS, USD… (then metric can be omitted)."),
};

export const createGoalInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().max(5000).optional(),
    icon: icon.optional().describe("One emoji (🎯 💰 📚 🏋). Omit to let ELISE suggest one."),
    area: area.optional().describe('Optional area: "Salud", "Marketing", "Firbot Academy".'),
    ...period,
    targetDate: date
      .optional()
      .describe("Deadline, only if the user gives one. It is separate from the period."),
    progressType: measureFields.progressType.default("binary"),
    progressMode: measureFields.progressMode.default("manual"),
    startValue: measureFields.startValue,
    currentValue: measureFields.currentValue,
    targetValue: measureFields.targetValue,
    direction: measureFields.direction.default("increase"),
    metric: measureFields.metric,
    currency: measureFields.currency,
    visions: z
      .array(visionRef)
      .max(5)
      .optional()
      .describe("Visions it contributes to. Linked only when the name matches one clearly."),
    habits: habitLinks.optional().describe("Existing habits related to the goal."),
    parentGoal: goalRef.optional().describe("A goal this one contributes to."),
  })
  .strict();

export const updateGoalInput = z
  .object({
    goal: goalRef,
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    icon: icon.nullable().optional(),
    area: area.nullable().optional(),
    ...period,
    targetDate: date.nullable().optional().describe("Deadline; null removes it."),
    progressType: measureFields.progressType.optional(),
    progressMode: measureFields.progressMode.optional(),
    startValue: z.number().finite().nullable().optional(),
    currentValue: z.number().finite().nullable().optional(),
    targetValue: z.number().finite().nullable().optional(),
    direction: measureFields.direction.optional(),
    metric: z.string().trim().max(60).nullable().optional(),
    currency: currency.nullable().optional(),
    status: z
      .enum(["active", "paused", "cancelled"])
      .optional()
      .describe("active resumes a paused goal."),
    parentGoal: goalRef
      .nullable()
      .optional()
      .describe("Contributes to this goal; null removes it."),
    visions: z
      .array(visionRef)
      .max(5)
      .optional()
      .describe("Replaces the Visions it contributes to."),
    habits: habitLinks.optional().describe("Replaces its related habits."),
    relatedGoals: z.array(goalRef).max(10).optional().describe("Replaces its related goals."),
  })
  .strict();

export const progressUpdateInput = z
  .object({
    goal: goalRef,
    value: z
      .number()
      .finite()
      .optional()
      .describe('The new current value: "ya conseguí 7 de los 12" → 7. Percentage goals: 0–100.'),
    add: z
      .number()
      .finite()
      .optional()
      .describe('"sumá 2 clientes" → 2 (adds to the current value).'),
    note: z.string().trim().max(500).optional().describe('Why it changed: "Cerré ACME".'),
  })
  .strict()
  .refine((p) => (p.value === undefined) !== (p.add === undefined), {
    message: "Pass value or add",
  });

export const goalRefInput = z.object({ goal: goalRef }).strict();

export const GOAL_LIST_STATUSES = [
  "active",
  "at_risk",
  "completed",
  "paused",
  "archived",
  "all",
] as const;

export const listGoalsInput = z
  .object({
    status: z
      .enum([...GOAL_LIST_STATUSES, "cancelled"])
      .default("active")
      .describe("at_risk: active goals behind their pace or past their deadline."),
    ...period,
    vision: visionRef.optional().describe("Only goals contributing to this Vision."),
    area: area.optional(),
  })
  .strict();

export const linkInput = z
  .object({
    goal: goalRef,
    resourceType: z.enum(["habit", "task", "goal", "note", "vision"]),
    resource: z.string().trim().min(1).max(500).describe("The linked record's id or name/title."),
    relationship: z.enum(["supports", "milestone", "related"]).optional(),
    useForProgress: z
      .boolean()
      .optional()
      .describe(
        "Habits/tasks: true when each check-in or completed task should count toward the goal. Default: tasks true, habits only for numeric goals measured in sessions.",
      ),
  })
  .strict();

export const unlinkInput = z
  .object({
    goal: goalRef,
    resourceType: z.enum(["habit", "task", "goal", "note", "vision"]),
    resource: z.string().trim().min(1).max(500),
  })
  .strict();

export const createVisionInput = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('The Vision statement: "Firbot Academy es la academia de referencia…".'),
    description: z.string().trim().max(5000).optional(),
    icon: icon.optional(),
    area: area.optional(),
  })
  .strict();

export const updateVisionInput = z
  .object({
    vision: visionRef,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    icon: icon.nullable().optional(),
    area: area.nullable().optional(),
    status: z.enum(["active", "achieved", "archived"]).optional(),
  })
  .strict();

export const visionRefInput = z.object({ vision: visionRef }).strict();
