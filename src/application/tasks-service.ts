import "server-only";

import { executeToolCall } from "@/core/agents/executor";
import type { Task } from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";

import type { AuthContext } from "./auth-context";
import { createExecutorPorts, toolContext } from "./elise";

/**
 * Tasks from the UI. Goes through exactly the same tool path as Chat (validation, provider
 * resolution, policy, audit), with origin `user_ui`, so both interfaces share one model.
 */
async function run(auth: AuthContext, name: string, args: unknown, idempotencyKey?: string) {
  const outcome = await executeToolCall(createExecutorPorts(auth), toolContext(auth, "user_ui"), {
    name,
    args,
    idempotencyKey: idempotencyKey ? `ui:${idempotencyKey}` : null,
  });
  if (outcome.status === "failed") {
    throw new AppError(outcome.error.code, outcome.error.message, {
      recovery: outcome.error.recovery,
    });
  }
  if (outcome.status !== "succeeded") {
    throw new AppError("PERMISSION_DENIED", "This action needs attention before it can run", {
      recovery: "review",
    });
  }
  return outcome;
}

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
