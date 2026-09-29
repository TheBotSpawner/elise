"use server";

import { revalidatePath } from "next/cache";

import { requireAuthContext } from "@/application/auth-context";
import { mutateTask } from "@/application/tasks-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type TaskActionResult = { ok: true } | { ok: false; error: PublicError };

/**
 * Inputs are validated by the tool schemas inside the executor, never trusted here.
 * `idempotencyKey` comes from the form submission so double submits never duplicate a task.
 */
export async function taskAction(
  operation: "create" | "update" | "complete" | "reopen" | "delete",
  args: unknown,
  idempotencyKey?: string,
): Promise<TaskActionResult> {
  try {
    const auth = await requireAuthContext();
    await mutateTask(auth, operation, args, idempotencyKey);
    revalidatePath("/my-elise/tasks");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
