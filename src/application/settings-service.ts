import "server-only";

import {
  ACCENTS,
  THEMES,
  type Accent,
  type ElisePreferences,
  type Notify,
  type SettingsStore,
  type Theme,
  type VoiceSettings,
} from "@/core/capabilities/settings";
import { AppError } from "@/core/errors";
import { availableModules, type NativeModuleKey } from "@/core/modules/registry";
import {
  isPersonality,
  PERSONALITY_PREFERENCE_KEY,
  type ElisePersonality,
} from "@/core/personality";
import { canonicalTimezone, isValidTimezone } from "@/core/time";
import { isVoiceKey, type VoiceKey } from "@/core/voice/catalog";
import { VOICE_LANGUAGES } from "@/core/voice/preferences";
import { availableVoiceKeys } from "@/infrastructure/ai/voices";

import { VOICE_PREFERENCE_KEY, type AuthContext } from "./auth-context";
import { listConnections } from "./connections-service";
import { reflectOnMemory } from "./memory-reflect";
import { forgetFact, getMemory, rememberFact, setLearning } from "./memory-service";
import { moduleVisibility, setModuleVisibility } from "./modules-service";
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
  // Aliases ("America/Buenos_Aires") are saved as the canonical id (ADR-069).
  if (patch.timezone) patch = { ...patch, timezone: canonicalTimezone(patch.timezone) };
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
    async modules() {
      const states = await moduleVisibility(auth);
      return availableModules().map((m) => ({
        key: m.key,
        enabled: states[m.key as NativeModuleKey],
      }));
    },
    setModules: async (changes) => void (await setModuleVisibility(auth, changes, "ai")),
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
    voice: () => getVoiceSettings(auth),
    async updateVoice(patch) {
      const v = await updateVoiceSettings(auth, patch);
      await audit(auth, "ai", "settings.voice_changed", {
        continuous: String(v.continuous),
        language: v.language,
      });
      return v;
    },
    voices: async () => ({ current: auth.profile.voice.voice, available: availableVoiceKeys() }),
    setVoice: (key) => setPreferredVoice(auth, key, "ai"),
    personality: async () => auth.profile.personality,
    setPersonality: (p) => setPersonality(auth, p, "ai"),
    async memory() {
      const m = await getMemory(auth);
      return {
        enabled: m.enabled,
        learning: { on: m.learning.on, available: m.learning.available },
        facts: m.facts,
        profile: m.profile,
      };
    },
    // Audit rows carry metadata only (ADR-107): never the fact, its key or its value.
    async remember(input) {
      const r = await rememberFact(auth, input);
      if (r.kind !== "kept")
        await audit(auth, "ai", "memory.remembered", {
          category: r.fact.category,
          provenance: r.fact.provenance,
          replaced: String(r.kind === "replace"),
        });
      return r;
    },
    async forget(idOrKey) {
      const r = await forgetFact(auth, idOrKey);
      if (r.forgotten) await audit(auth, "ai", "memory.forgotten", { count: String(r.forgotten) });
      return r;
    },
    reflect: (question, range) => reflectOnMemory(auth, question, range),
    async stopLearning() {
      const wasOn = (await getMemory(auth)).learning.on;
      await setLearning(auth, false);
      await audit(auth, "ai", "memory.learning_stopped", { was_on: String(wasOn) });
      return wasOn;
    },
  };
}

/**
 * The voice (ADR-030): one preference whoever changes it — Settings, chat or voice. Only a
 * curated key that's configured now is accepted; the provider's own voice id is never stored.
 * The request's context follows at once, so the rest of this turn already uses it; every later
 * request (each spoken sentence) reads it again.
 */
export async function setPreferredVoice(
  auth: AuthContext,
  key: VoiceKey,
  origin: Origin,
): Promise<VoiceKey> {
  if (!isVoiceKey(key) || !availableVoiceKeys().includes(key))
    throw new AppError("VALIDATION_ERROR", "That voice isn't available", { recovery: "review" });
  const from = auth.profile.voice.voice;
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: VOICE_PREFERENCE_KEY,
      value_json: key,
      source: "user",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the voice", { cause: error });
  auth.profile.voice.voice = key;
  if (from !== key) await audit(auth, origin, "settings.voice_changed", { from, voice: key });
  return key;
}

/**
 * ELISE's base personality (ADR-076): one preference whoever changes it — Settings, onboarding,
 * chat or voice. Validated against the presets; the request's context follows at once, so the
 * rest of this turn already sounds that way. Tone only: nothing about permissions changes.
 */
export async function setPersonality(
  auth: AuthContext,
  personality: ElisePersonality,
  origin: Origin,
  source: "user" | "onboarding" = "user",
): Promise<ElisePersonality> {
  if (!isPersonality(personality))
    throw new AppError("VALIDATION_ERROR", "That personality doesn't exist", {
      recovery: "review",
    });
  const from = auth.profile.personality;
  const { error } = await auth.db.from("user_preferences").upsert(
    {
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      key: PERSONALITY_PREFERENCE_KEY,
      value_json: personality,
      source,
    },
    { onConflict: "workspace_id,user_id,key" },
  );
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not save the personality", { cause: error });
  auth.profile.personality = personality;
  if (from !== personality)
    await audit(auth, origin, "settings.personality_changed", { from, personality });
  return personality;
}

/** Voice behavior (ADR-068): the same columns the Settings page writes. */
export async function getVoiceSettings(auth: AuthContext): Promise<VoiceSettings> {
  const { data, error } = await auth.db
    .from("user_profiles")
    .select("voice_continuous, voice_language")
    .eq("id", auth.userId)
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not load voice settings", { cause: error });
  return { continuous: data.voice_continuous ?? false, language: data.voice_language };
}

export async function updateVoiceSettings(
  auth: AuthContext,
  patch: Partial<VoiceSettings>,
): Promise<VoiceSettings> {
  if (patch.language && !(VOICE_LANGUAGES as readonly string[]).includes(patch.language))
    throw invalid("voice language");
  const { error } = await auth.db
    .from("user_profiles")
    .update({
      ...(patch.continuous !== undefined
        ? // The wake column mirrors it for older clients: "Elise" wakes only in continuous mode.
          { voice_continuous: patch.continuous, voice_wake_enabled: patch.continuous }
        : {}),
      ...(patch.language ? { voice_language: patch.language } : {}),
    })
    .eq("id", auth.userId);
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not save voice settings", { cause: error });
  return getVoiceSettings(auth);
}
