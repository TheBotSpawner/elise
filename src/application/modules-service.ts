import "server-only";

import { cache } from "react";

import { AppError } from "@/core/errors";
import {
  availableModules,
  effectiveModules,
  enabledModuleKeys,
  isModuleKey,
  moduleDefinition,
  type ModuleStates,
  type NativeModuleKey,
} from "@/core/modules/registry";
import { logger } from "@/infrastructure/observability/logger";

import type { AuthContext } from "./auth-context";

/**
 * Mi ELISE (ADR-064): the one place that reads and changes which native modules a person uses.
 * Navigation, route guards, Connections, onboarding, chat tools, the context builder and the
 * Morning Brief all ask here — never their own copy of the rule.
 */

/** Effective state of every module for this person; loaded once per request. */
export const moduleStates = cache(async (auth: AuthContext): Promise<ModuleStates> => {
  const { data, error } = await auth.db
    .from("user_module_preferences")
    .select("module_key, enabled")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId);
  // Before migration 047 the table doesn't exist: everything stays as it was (all on).
  if (error) {
    logger.warn("modules.read_failed", { code: error.code });
    return effectiveModules([]);
  }
  return effectiveModules(data ?? []);
});

export async function enabledModules(auth: AuthContext): Promise<NativeModuleKey[]> {
  return enabledModuleKeys(await moduleStates(auth));
}

export async function isModuleEnabled(auth: AuthContext, key: NativeModuleKey): Promise<boolean> {
  return (await moduleStates(auth))[key];
}

function validKey(key: string): NativeModuleKey {
  if (!isModuleKey(key) || !moduleDefinition(key).available)
    throw new AppError("VALIDATION_ERROR", "That isn't a Mi ELISE module", { recovery: "review" });
  return key;
}

/**
 * Turns modules on or off. Nothing else changes: data, providers, bindings and connections stay
 * exactly as they are. Audited (module.enabled / module.disabled), never an approval.
 */
export async function setModules(
  auth: AuthContext,
  changes: Partial<Record<string, boolean>>,
  origin: "user_ui" | "ai" | "onboarding",
): Promise<ModuleStates> {
  const entries = Object.entries(changes)
    .filter((e): e is [string, boolean] => typeof e[1] === "boolean")
    .map(([k, v]) => [validKey(k), v] as const);
  if (!entries.length) return moduleStates(auth);
  const before = await moduleStates(auth);
  const { error } = await auth.db.from("user_module_preferences").upsert(
    entries.map(([module_key, enabled]) => ({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      module_key,
      enabled,
    })),
    { onConflict: "workspace_id,user_id,module_key" },
  );
  if (error) {
    // 42P01: the table isn't there yet (migration 047 not applied).
    if (error.code === "42P01" || error.code === "PGRST205")
      throw new AppError("SERVER_NOT_CONFIGURED", "This needs the latest ELISE database update", {
        recovery: "configure",
        details: { setup: "database_update", missing: ["migration 20261028000047"] },
      });
    throw new AppError("INTERNAL_ERROR", "Could not save Mi ELISE", { cause: error });
  }
  const changed = entries.filter(([k, v]) => before[k] !== v);
  if (changed.length)
    await auth.db.from("audit_events").insert(
      changed.map(([module_key, enabled]) => ({
        workspace_id: auth.workspaceId,
        user_id: auth.userId,
        event_type: enabled ? "module.enabled" : "module.disabled",
        resource_type: "native_module",
        resource_id: module_key,
        origin: origin === "onboarding" ? "user_ui" : origin,
        result: "success" as const,
        metadata: { module: module_key, via: origin },
      })),
    );
  return { ...before, ...Object.fromEntries(entries) } as ModuleStates;
}

/** Onboarding writes an explicit choice for every module offered: the chosen ones on. */
export async function chooseModules(auth: AuthContext, chosen: readonly string[]) {
  const keys = new Set(chosen.filter(isModuleKey));
  return setModules(
    auth,
    Object.fromEntries(availableModules().map((m) => [m.key, keys.has(m.key as NativeModuleKey)])),
    "onboarding",
  );
}

/** Whether this person ever chose (onboarding, Connections, chat) — existing accounts did. */
export async function hasChosenModules(auth: AuthContext): Promise<boolean> {
  const { count, error } = await auth.db
    .from("user_module_preferences")
    .select("module_key", { count: "exact", head: true })
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId);
  return !error && (count ?? 0) > 0;
}
