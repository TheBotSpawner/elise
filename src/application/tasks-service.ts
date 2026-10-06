import "server-only";

import { taskCounts, type Task, type TaskList } from "@/core/capabilities/tasks";
import { todayIn } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { runUserTool as run } from "./elise";

/**
 * The one Tasks read path for Home, My Elise → Tasks and anything else in the UI. It goes
 * through tasks.list (same resolution, provenance and definitions as Chat and the Morning
 * Brief): every enabled task account, each read live from its own source of truth. Nothing is
 * cached server-side; screens re-read when their snapshot is stale (use-refresh-when-stale).
 */

/** Enough for every open task a person realistically has, across all accounts. */
export const OPEN_LIMIT = 500;
const COMPLETED_LIMIT = 50;

export interface TaskSource {
  connectionId: string;
  label: string;
  providerKey: string;
}

async function listTasks(
  auth: AuthContext,
  status: "open" | "completed",
  limit: number,
): Promise<{ tasks: Task[]; unavailable: string[] }> {
  const outcome = await run(auth, "tasks.list", { status, limit });
  const unavailable =
    (outcome.output as { unavailable?: { account: string }[] } | null)?.unavailable?.map(
      (u) => u.account,
    ) ?? [];
  return {
    tasks: outcome.display?.kind === "task_list" ? outcome.display.tasks : [],
    unavailable,
  };
}

export async function openTasks(auth: AuthContext) {
  const { tasks, unavailable } = await listTasks(auth, "open", OPEN_LIMIT);
  const today = todayIn(auth.profile.timezone);
  return { tasks, unavailable, today, counts: taskCounts(tasks, today) };
}

export interface TasksOverview {
  open: Task[];
  completed: Task[] | null;
  lists: TaskList[];
  sources: TaskSource[];
  counts: ReturnType<typeof taskCounts>;
  today: string;
  unavailable: string[];
  /** When every account was read (live): screens refresh a snapshot older than this. */
  fetchedAt: string;
}

export async function tasksOverview(
  auth: AuthContext,
  options: { includeCompleted: boolean },
): Promise<TasksOverview> {
  const [open, completed, lists] = await Promise.all([
    openTasks(auth),
    options.includeCompleted ? listTasks(auth, "completed", COMPLETED_LIMIT) : null,
    run(auth, "tasks.listLists", {}),
  ]);
  const allLists = lists.display?.kind === "task_lists" ? lists.display.lists : [];
  const sources = new Map<string, TaskSource>();
  for (const l of allLists) {
    sources.set(l.provenance.connectionId, {
      connectionId: l.provenance.connectionId,
      label: l.provenance.source,
      providerKey: l.provenance.providerKey,
    });
  }
  // ELISE first, then accounts by name.
  const ordered = [...sources.values()].sort(
    (a, b) =>
      Number(b.providerKey === "elise_native") - Number(a.providerKey === "elise_native") ||
      a.label.localeCompare(b.label),
  );
  return {
    open: open.tasks,
    completed: completed?.tasks ?? null,
    lists: allLists,
    sources: ordered,
    counts: open.counts,
    today: open.today,
    unavailable: [...new Set([...open.unavailable, ...(completed?.unavailable ?? [])])],
    fetchedAt: new Date().toISOString(),
  };
}

export async function mutateTask(
  auth: AuthContext,
  operation: "create" | "update" | "complete" | "reopen" | "delete" | "createList",
  args: unknown,
  idempotencyKey?: string,
): Promise<Task | null> {
  const outcome = await run(auth, `tasks.${operation}`, args, idempotencyKey);
  return outcome.display?.kind === "task" ? outcome.display.task : null;
}
