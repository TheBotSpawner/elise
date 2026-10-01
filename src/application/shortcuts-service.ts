import "server-only";

import { AppError } from "@/core/errors";
import {
  parseSteps,
  phraseKey,
  validatePhrases,
  type NewShortcut,
  type Shortcut,
  type ShortcutStore,
} from "@/core/shortcuts/model";
import { logger } from "@/infrastructure/observability/logger";
import type { Json, ShortcutRow } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Shortcuts store (ADR-017 §10): the author's own rows (RLS). Steps are validated against the
 * allowlist on every write and on every read — a stored step the registry no longer knows
 * makes the Shortcut unusable, never powerful.
 */

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Json;

function toShortcut(r: ShortcutRow): Shortcut | null {
  let steps: Shortcut["steps"];
  try {
    steps = parseSteps(r.steps);
  } catch {
    logger.warn("shortcut.invalid_steps", { shortcut_id: r.id });
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: r.enabled,
    phrases: r.trigger_phrases,
    language: r.language,
    steps,
    contextId: r.context_profile_id,
    requiresConfirmation: r.requires_confirmation,
    lastRunAt: r.last_run_at,
    runCount: r.run_count,
  };
}

function dbError(error: { code?: string; message?: string } | null): never {
  if (error?.message?.includes("already uses that phrase"))
    throw new AppError("CONFLICT", "Another shortcut already uses that phrase", {
      recovery: "review",
      cause: error,
    });
  throw new AppError("INTERNAL_ERROR", "Could not save the shortcut", { cause: error });
}

export function shortcutStore(auth: AuthContext): ShortcutStore {
  const rows = () =>
    auth.db
      .from("shortcuts")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId);
  const one = async (id: string) => {
    const { data } = await rows().eq("id", id).maybeSingle();
    const s = data ? toShortcut(data) : null;
    if (!s) throw new AppError("NOT_FOUND", "Shortcut not found", { recovery: "review" });
    return s;
  };
  return {
    async list() {
      const { data } = await rows().order("created_at");
      return (data ?? []).map(toShortcut).filter((s): s is Shortcut => s !== null);
    },
    async create(input: NewShortcut) {
      const phrases = validatePhrases(input.phrases);
      const { data, error } = await auth.db
        .from("shortcuts")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          name: input.name.trim().slice(0, 80),
          description: input.description ?? null,
          trigger_phrases: phrases,
          phrase_keys: phrases.map(phraseKey),
          language: input.language ?? null,
          steps: json(parseSteps(input.steps)),
          context_profile_id: input.contextId ?? null,
          requires_confirmation: input.requiresConfirmation ?? false,
        })
        .select("*")
        .single();
      if (error || !data) dbError(error);
      logger.info("shortcut.created", { steps: input.steps.length });
      return toShortcut(data)!;
    },
    async update(id, patch) {
      const phrases = patch.phrases ? validatePhrases(patch.phrases) : null;
      const { error } = await auth.db
        .from("shortcuts")
        .update({
          ...(patch.name ? { name: patch.name.trim().slice(0, 80) } : {}),
          ...(phrases ? { trigger_phrases: phrases, phrase_keys: phrases.map(phraseKey) } : {}),
          ...(patch.steps ? { steps: json(parseSteps(patch.steps)) } : {}),
          ...(patch.contextId !== undefined ? { context_profile_id: patch.contextId } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.requiresConfirmation !== undefined
            ? { requires_confirmation: patch.requiresConfirmation }
            : {}),
        })
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId);
      if (error) dbError(error);
      return one(id);
    },
    async remove(id) {
      await auth.db
        .from("shortcuts")
        .delete()
        .eq("id", id)
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId);
      logger.info("shortcut.deleted", {});
    },
    async markRun(id) {
      const s = await one(id);
      await auth.db
        .from("shortcuts")
        .update({ last_run_at: new Date().toISOString(), run_count: s.runCount + 1 })
        .eq("id", id)
        .eq("user_id", auth.userId);
    },
  };
}

/** For the chat turn: the enabled shortcuts (never blocks a turn). */
export async function enabledShortcuts(auth: AuthContext): Promise<Shortcut[]> {
  try {
    return (await shortcutStore(auth).list()).filter((s) => s.enabled);
  } catch {
    return [];
  }
}
