"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext, type AuthContext } from "@/application/auth-context";
import { shortcutStore } from "@/application/shortcuts-service";
import { AppError, toPublicError, type PublicError } from "@/core/errors";
import { phraseConflicts } from "@/core/shortcuts/match";
import { parseSteps, STEP_TYPE_KEYS, type StepType } from "@/core/shortcuts/model";

/**
 * My Elise › Shortcuts (ADR-017 §14): the same store and validation ELISE uses, audited as the
 * user's own change. A Shortcut only names allowlisted steps; it never grants anything.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise/shortcuts");
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: toPublicError(
        error instanceof z.ZodError
          ? new AppError("VALIDATION_ERROR", "Review the shortcut's steps", { recovery: "review" })
          : error,
      ),
    };
  }
}

const shortcutInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    phrases: z.array(z.string().trim().min(1).max(60)).min(1).max(5),
    steps: z
      .array(
        z
          .object({
            type: z.enum(STEP_TYPE_KEYS as [StepType, ...StepType[]]),
            config: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    contextId: z.uuid().nullable(),
    requiresConfirmation: z.boolean(),
  })
  .strict();

async function audit(auth: AuthContext, event: string, id: string, metadata = {}) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: event,
    resource_type: "shortcut",
    resource_id: id,
    origin: "user_ui",
    result: "success",
    metadata,
  });
}

/** A phrase another enabled Shortcut already answers to is refused (clear, not silent). */
async function checkConflicts(auth: AuthContext, phrases: string[], except: string | null) {
  const others = (await shortcutStore(auth).list()).filter((s) => s.id !== except);
  const [clash] = phraseConflicts(phrases, others);
  if (clash)
    throw new AppError("CONFLICT", `Another shortcut already uses “${clash}”`, {
      recovery: "review",
    });
}

export async function createShortcutAction(input: z.input<typeof shortcutInput>) {
  return run(async () => {
    const auth = await requireAuthContext();
    const q = shortcutInput.parse(input);
    await checkConflicts(auth, q.phrases, null);
    const s = await shortcutStore(auth).create({ ...q, steps: parseSteps(q.steps) });
    await audit(auth, "shortcut.created", s.id, { steps: s.steps.map((x) => x.type) });
    return { id: s.id };
  });
}

export async function updateShortcutAction(id: string, input: z.input<typeof shortcutInput>) {
  return run(async () => {
    const auth = await requireAuthContext();
    const q = shortcutInput.parse(input);
    await checkConflicts(auth, q.phrases, z.uuid().parse(id));
    await shortcutStore(auth).update(id, { ...q, steps: parseSteps(q.steps) });
    await audit(auth, "shortcut.updated", id);
    return null;
  });
}

export async function setShortcutEnabledAction(id: string, enabled: boolean) {
  return run(async () => {
    const auth = await requireAuthContext();
    const store = shortcutStore(auth);
    const s = (await store.list()).find((x) => x.id === z.uuid().parse(id));
    if (!s) throw new AppError("NOT_FOUND", "Shortcut not found", { recovery: "review" });
    if (enabled) await checkConflicts(auth, s.phrases, s.id);
    await store.update(id, { enabled });
    await audit(auth, enabled ? "shortcut.enabled" : "shortcut.disabled", id);
    return null;
  });
}

export async function deleteShortcutAction(id: string) {
  return run(async () => {
    const auth = await requireAuthContext();
    await shortcutStore(auth).remove(z.uuid().parse(id));
    await audit(auth, "shortcut.deleted", id);
    return null;
  });
}
