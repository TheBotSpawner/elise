import "server-only";

import {
  ACCENTS,
  THEMES,
  type Accent,
  type ElisePreferences,
  type Notify,
  type SettingsStore,
  type Theme,
} from "@/core/capabilities/settings";
import { AppError } from "@/core/errors";
import { isValidTimezone } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { listConnections } from "./connections-service";
import { listSchedules, setSchedulePaused, updateSchedule } from "./schedules-service";

/**
 * ELISE Self-Control store (ADR-012): the user's own preferences, through their session (RLS).
 * Values are validated again here, whoever calls — the tools, the Settings UI or anything else.
 */

const EVENTS = {
  language: "settings.language_changed",
  timezone: "settings.timezone_changed",
  theme: "appearance.theme_changed",
  accent: "appearance.accent_changed",
} as const;

type Origin = "ai" | "user_ui";

async function audit(
  auth: AuthContext,
  origin: Origin,
  eventType: string,
  metadata: Record<string, string>,
) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: "user_profile",
    resource_id: auth.userId,
    origin,
    result: "success",
    metadata,
  });
}

export async function getPreferences(auth: AuthContext): Promise<ElisePreferences> {
  const { data, error } = await auth.db
    .from("user_profiles")
    .select("display_name, preferred_language, timezone, theme, accent")
    .eq("id", auth.userId)
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load settings", { cause: error });
  return {
    displayName: data.display_name,
    language: data.preferred_language,
    timezone: data.timezone,
    theme: data.theme,
    accent: data.accent,
  };
}

export async function updatePreferences(
  auth: AuthContext,
  patch: Partial<Pick<ElisePreferences, "language" | "timezone" | "theme" | "accent">>,
  origin: Origin = "user_ui",
): Promise<ElisePreferences> {
  if (patch.language && !["es", "en"].includes(patch.language)) throw invalid("language");
  if (patch.timezone && !isValidTimezone(patch.timezone)) throw invalid("time zone");
  if (patch.theme && !THEMES.includes(patch.theme as Theme)) throw invalid("theme");
  if (patch.accent && !ACCENTS.includes(patch.accent as Accent)) throw invalid("accent");
  const before = await getPreferences(auth);
  const { error } = await auth.db
    .from("user_profiles")
    .update({
      ...(patch.language ? { preferred_language: patch.language } : {}),
      ...(patch.timezone ? { timezone: patch.timezone } : {}),
      ...(patch.theme ? { theme: patch.theme } : {}),
      ...(patch.accent ? { accent: patch.accent } : {}),
    })
    .eq("id", auth.userId);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save settings", { cause: error });
  for (const key of Object.keys(EVENTS) as (keyof typeof EVENTS)[]) {
    const value = patch[key];
    if (value && value !== before[key])
      await audit(auth, origin, EVENTS[key], { from: before[key], to: value });
  }
  return { ...before, ...patch };
}

const invalid = (what: string) =>
  new AppError("VALIDATION_ERROR", `That ${what} isn't one ELISE supports`, { recovery: "review" });

/** The store ELISE's tools use; changes are audited with origin "ai". */
export function settingsStore(auth: AuthContext): SettingsStore {
  return {
    get: () => getPreferences(auth),
    update: (patch) => updatePreferences(auth, patch, "ai"),
    async schedules() {
      const { schedules } = await listSchedules(auth);
      return schedules.map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        notify: s.input.delivery.notify as Notify,
        nextRunAt: s.nextRunAt,
      }));
    },
    setSchedulePaused: (id, paused) => setSchedulePaused(auth, id, paused),
    async setScheduleNotify(id, notify) {
      const { schedules } = await listSchedules(auth);
      const s = schedules.find((x) => x.id === id);
      if (!s) throw new AppError("NOT_FOUND", "Schedule not found");
      await updateSchedule(auth, id, { ...s.input, delivery: { ...s.input.delivery, notify } });
      await audit(auth, "ai", "notifications.updated", { schedule: id, notify });
    },
    async connections() {
      const { connections } = await listConnections(auth);
      // Names and permissions only: never tokens, scopes or internal ids.
      return connections
        .filter((c) => c.providerKey !== "elise_native")
        .map((c) => ({
          name: c.displayName,
          provider: c.providerKey,
          account: c.accountLabel,
          status: c.status,
          capabilities: c.capabilities.filter((x) => x.enabled && x.granted).map((x) => x.key),
        }));
    },
  };
}
