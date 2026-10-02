import { z } from "zod";

import { destinationField } from "../providers/destination";
import type { ProviderKey } from "../providers/types";
import { addDays, isIsoDate, todayIn } from "../time";

/** Canonical Tasks model. Every provider (ELISE Native, Google Tasks...) maps into this. */
export const TASK_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: TaskStatus;
  priority: TaskPriority | null;
  category: string | null;
  /** Calendar date in the user's timezone. */
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where this task lives. Needed to write back to the right account. */
  provenance: {
    providerKey: ProviderKey;
    connectionId: string;
    externalId: string;
    /** User-facing account name ("ELISE", "Personal", "Acme"). */
    source: string;
    /** Task list at the provider, when the provider has lists. */
    listId?: string;
    listName?: string;
    url?: string;
  };
}

export interface TaskList {
  /**
   * Canonical id to pass back as `list` when creating tasks. Scoped by provider/connection:
   * ELISE list UUIDs, Google lists as connection refs — never assumed globally unique.
   */
  id: string;
  name: string;
  /** Where new tasks go when no list is named (ELISE's Inbox, Google's first list). */
  isDefault?: boolean;
  provenance: { providerKey: ProviderKey; connectionId: string; source: string };
}

/**
 * Task ids are opaque: ELISE Native uses UUIDs, external providers use connection-scoped refs
 * (see providers/refs.ts). Always pass back an id exactly as returned by tasks.list.
 */
const taskId = z.string().trim().min(1).max(600);

const isoDate = z.string().refine(isIsoDate, "Expected a valid date as YYYY-MM-DD");
/** Titles that only name the kind of thing ("Tarea", "New task"), never what to do. */
const PLACEHOLDER_TITLES = new Set([
  "tarea",
  "nueva tarea",
  "una tarea",
  "task",
  "new task",
  "a task",
  "to do",
  "todo",
  "pendiente",
  "recordatorio",
  "reminder",
  "sin titulo",
  "untitled",
]);
export const isPlaceholderTitle = (title: string) =>
  PLACEHOLDER_TITLES.has(
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N} ]/gu, "")
      .trim(),
  );

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const createTaskInput = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "What the user said the task is, in their words. Never a placeholder: if they didn't say, ask.",
      )
      // A generic word is not a task: the user never said what to do (ask, don't invent).
      .refine((t) => !isPlaceholderTitle(t), {
        message: "That isn't what the task is: ask the user what the task should say.",
      }),
    description: optionalText(5000),
    notes: optionalText(5000),
    priority: z.enum(TASK_PRIORITIES).optional(),
    category: optionalText(80),
    dueDate: isoDate.optional(),
    list: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      .describe(
        'Task list: its id from tasks.listLists, or its name ("Clients", "Shopping"). Omit for the default list.',
      ),
    destination: destinationField,
  })
  .strict();

export const createTaskListInput = z.object({ name: z.string().trim().min(1).max(120) }).strict();

export const updateTaskInput = z
  .object({
    taskId,
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(["pending", "in_progress", "cancelled"]).optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    list: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      .describe("Move to another list of the same account (id or name)."),
  })
  .strict();

export const taskIdInput = z.object({ taskId }).strict();

export const listTaskListsInput = z.object({ destination: destinationField }).strict();

export const listTasksInput = z
  .object({
    status: z.enum(["open", "completed", "all"]).default("open"),
    due: z.enum(["any", "today", "overdue", "this_week", "no_date"]).default("any"),
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(500).default(20),
    destination: destinationField,
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type ListTasksInput = z.infer<typeof listTasksInput>;

/** Concrete, provider-agnostic query produced deterministically from ListTasksInput. */
export interface TaskQuery {
  status: "open" | "completed" | "all";
  dueFrom?: string;
  dueTo?: string;
  noDueDate?: boolean;
  search?: string;
  limit: number;
}

export function toTaskQuery(
  input: ListTasksInput,
  timezone: string,
  now: Date = new Date(),
): TaskQuery {
  const today = todayIn(timezone, now);
  const base = { status: input.status, search: input.search, limit: input.limit };
  switch (input.due) {
    case "today":
      return { ...base, dueFrom: today, dueTo: today };
    case "overdue":
      return { ...base, status: "open", dueTo: addDays(today, -1) };
    case "this_week":
      return { ...base, dueFrom: today, dueTo: addDays(today, 6) };
    case "no_date":
      return { ...base, noDueDate: true };
    default:
      return base;
  }
}

/**
 * The single definition of open / due today / overdue used by Home, the Tasks screen, Chat and
 * the Morning Brief, so a count and the list behind it always agree.
 */
export function isOpenTask(task: Pick<Task, "status">): boolean {
  return task.status === "pending" || task.status === "in_progress";
}

export type TaskView = "open" | "today" | "overdue" | "completed";

export function inTaskView(task: Task, view: TaskView, today: string): boolean {
  switch (view) {
    case "open":
      return isOpenTask(task);
    case "today":
      return isOpenTask(task) && task.dueDate === today;
    case "overdue":
      return isOpenTask(task) && task.dueDate !== null && task.dueDate < today;
    case "completed":
      return task.status === "completed";
  }
}

export function taskCounts(tasks: Task[], today: string) {
  return {
    open: tasks.filter((t) => inTaskView(t, "open", today)).length,
    dueToday: tasks.filter((t) => inTaskView(t, "today", today)).length,
    overdue: tasks.filter((t) => inTaskView(t, "overdue", today)).length,
  };
}

const normName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * A list the user named, within one account: exact id, then exact name, then partial name.
 * Several matches are returned so the caller asks instead of guessing.
 */
export function matchTaskLists<T extends { id: string; name: string }>(
  lists: T[],
  ref: string,
): T[] {
  const byId = lists.filter((l) => l.id === ref);
  if (byId.length) return byId;
  const wanted = normName(ref);
  const exact = lists.filter((l) => normName(l.name) === wanted);
  if (exact.length) return exact;
  return lists.filter((l) => normName(l.name).includes(wanted));
}

export interface TaskWriteMeta {
  userId: string;
  source: "user_ui" | "ai" | "schedule" | "import" | "system";
}

/** Contract every Tasks provider implements (ELISE Native today, Google Tasks next). */
export interface TaskProvider {
  listLists(): Promise<TaskList[]>;
  /** Providers with user-managed lists in ELISE (ELISE Native). */
  createList?(name: string): Promise<TaskList>;
  list(query: TaskQuery): Promise<Task[]>;
  get(taskId: string): Promise<Task | null>;
  create(input: CreateTaskInput, meta: TaskWriteMeta): Promise<Task>;
  update(input: UpdateTaskInput): Promise<Task>;
  complete(taskId: string): Promise<Task>;
  reopen(taskId: string): Promise<Task>;
  /** Soft delete where the provider supports it. */
  archive(taskId: string): Promise<Task>;
}
