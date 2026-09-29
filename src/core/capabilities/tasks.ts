import { z } from "zod";

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
  provenance: { providerKey: ProviderKey; connectionId: string; externalId: string };
}

const isoDate = z.string().refine(isIsoDate, "Expected a valid date as YYYY-MM-DD");
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const createTaskInput = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: optionalText(5000),
    notes: optionalText(5000),
    priority: z.enum(TASK_PRIORITIES).optional(),
    category: optionalText(80),
    dueDate: isoDate.optional(),
  })
  .strict();

export const updateTaskInput = z
  .object({
    taskId: z.uuid(),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(["pending", "in_progress", "cancelled"]).optional(),
    priority: z.enum(TASK_PRIORITIES).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    dueDate: isoDate.nullable().optional(),
  })
  .strict();

export const taskIdInput = z.object({ taskId: z.uuid() }).strict();

export const listTasksInput = z
  .object({
    status: z.enum(["open", "completed", "all"]).default("open"),
    due: z.enum(["any", "today", "overdue", "this_week", "no_date"]).default("any"),
    search: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20),
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

export interface TaskWriteMeta {
  userId: string;
  source: "user_ui" | "ai" | "schedule" | "import" | "system";
}

/** Contract every Tasks provider implements (ELISE Native today, Google Tasks next). */
export interface TaskProvider {
  list(query: TaskQuery): Promise<Task[]>;
  get(taskId: string): Promise<Task | null>;
  create(input: CreateTaskInput, meta: TaskWriteMeta): Promise<Task>;
  update(input: UpdateTaskInput): Promise<Task>;
  complete(taskId: string): Promise<Task>;
  reopen(taskId: string): Promise<Task>;
  /** Soft delete where the provider supports it. */
  archive(taskId: string): Promise<Task>;
}
