import "server-only";

import { cache } from "react";

import { AppError } from "@/core/errors";
import {
  availableModules,
  effectiveModules,
  isModuleKey,
  moduleDefinition,
  visibleModuleKeys,
  type ModuleStates,
  type NativeModuleKey,
} from "@/core/modules/registry";
import { logger } from "@/infrastructure/observability/logger";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Mi ELISE visibility (ADR-070): the one place that reads and changes which native modules show
 * in Mi ELISE. Desktop navigation, the phone drawer, the Mi ELISE page, Connections and
 * onboarding all ask here. It is visibility only: no tool, page, Morning Brief block or piece
 * of data depends on it.
 *
 * Stored per person and workspace in `user_preferences` (`my_elise.visibility`: an explicit
 * map of the choices made), so it survives refreshes, sign-ins, devices and deploys.
 */
const KEY = "my_elise.visibility";

async function savedChoices(auth: AuthContext): Promise<Record<string, boolean> | null> {
  const { data, error } = await auth.db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .eq("key", KEY)
    .maybeSingle();
  if (error) {
    // Never hide anything because a read failed.
    logger.warn("modules.read_failed", { code: error.code });
    return null;
  }
  const value = data?.value_json;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, boolean>)
    : null;
}

/** Whether each module shows in Mi ELISE; loaded once per request. */
export const moduleVisibility = cache(async (auth: AuthContext): Promise<ModuleStates> =>
  effectiveModules(await savedChoices(auth)),
);

export async function visibleModules(auth: AuthContext): Promise<NativeModuleKey[]> {
  return visibleModuleKeys(await moduleVisibility(auth));
}

export async function isModuleVisible(auth: AuthContext, key: NativeModuleKey): Promise<boolean> {
  return (await moduleVisibility(auth))[key];
}

function validKey(key: string): NativeModuleKey {
  if (!isModuleKey(key) || !moduleDefinition(key).available)
    throw new AppError("VALIDATION_ERROR", "That isn't a Mi ELISE module", { recovery: "review" });
  return key;
}

/**
 * Shows or hides modules in Mi ELISE. Nothing else changes — data, tools, providers, bindings,
 * connections and schedules stay exactly as they are — so there is nothing to confirm and
 * existing data never blocks it. Audited (module.shown / module.hidden).
 */
export async function setModuleVisibility(
  auth: AuthContext,
  changes: Partial<Record<string, boolean>>,
  origin: "user_ui" | "ai" | "onboarding",
): Promise<ModuleStates> {
  const entries = Object.entries(changes)
    .filter((e): e is [string, boolean] => typeof e[1] === "boolean")
    .map(([k, v]) => [validKey(k), v] as const);
  if (!entries.length) return moduleVisibility(auth);
  const saved = (await savedChoices(auth)) ?? {};
  const before = effectiveModules(Object.keys(saved).length ? saved : null);
  // The full effective map is written, so modules added later follow their own default.
  const next = { ...before, ...Object.fromEntries(entries) };
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: KEY,
      value_json: next as unknown as Json,
      source: origin === "onboarding" ? "onboarding" : "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save Mi ELISE", { cause: error });
  const changed = entries.filter(([k, v]) => before[k] !== v);
  if (changed.length)
    await auth.db.from("audit_events").insert(
      changed.map(([module_key, shown]) => ({
        workspace_id: auth.workspaceId,
        user_id: auth.userId,
        event_type: shown ? "module.shown" : "module.hidden",
        resource_type: "native_module",
        resource_id: module_key,
        origin: origin === "onboarding" ? "user_ui" : origin,
        result: "success" as const,
        metadata: { module: module_key, via: origin },
      })),
    );
  return next as ModuleStates;
}

/** Onboarding records an explicit choice for every module offered: the chosen ones shown. */
export async function chooseModules(auth: AuthContext, chosen: readonly string[]) {
  const keys = new Set(chosen.filter(isModuleKey));
  return setModuleVisibility(
    auth,
    Object.fromEntries(availableModules().map((m) => [m.key, keys.has(m.key as NativeModuleKey)])),
    "onboarding",
  );
}

/** Whether this person ever chose (onboarding, Connections, chat). */
export async function hasChosenModules(auth: AuthContext): Promise<boolean> {
  return (await savedChoices(auth)) !== null;
}
