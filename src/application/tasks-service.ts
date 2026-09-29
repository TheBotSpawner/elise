import "server-only";

import type { Task } from "@/core/capabilities/tasks";

import type { AuthContext } from "./auth-context";
import { runUserTool as run } from "./elise";

export async function listTasks(
  auth: AuthContext,
  status: "open" | "completed" | "all" = "all",
): Promise<Task[]> {
  const outcome = await run(auth, "tasks.list", { status, limit: 50 });
  return outcome.display?.kind === "task_list" ? outcome.display.tasks : [];
}

export async function mutateTask(
  auth: AuthContext,
  operation: "create" | "update" | "complete" | "reopen" | "delete",
  args: unknown,
  idempotencyKey?: string,
): Promise<Task | null> {
  const outcome = await run(auth, `tasks.${operation}`, args, idempotencyKey);
  return outcome.display?.kind === "task" ? outcome.display.task : null;
}
