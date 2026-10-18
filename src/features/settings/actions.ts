"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  clearMemory,
  editMemoryFact,
  forgetFact,
  rememberFact,
  setMemoryEnabled,
} from "@/application/memory-service";
import {
  setPersonality,
  setPreferredVoice,
  updatePreferences,
  updateVoiceSettings,
} from "@/application/settings-service";
import { deleteStoredFile } from "@/application/storage-service";
import { toPublicError, type PublicError } from "@/core/errors";
import { PERSONALITIES } from "@/core/personality";
import { isValidTimezone } from "@/core/time";
import { VOICE_KEYS } from "@/core/voice/catalog";
import { VOICE_LANGUAGES } from "@/core/voice/preferences";
import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n";
import { ACCENTS, THEME_COOKIE, THEMES } from "@/lib/theme";

const ONE_YEAR = 60 * 60 * 24 * 365;

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  language: z.enum(LOCALES),
  timezone: z.string().refine(isValidTimezone),
});

export async function updateProfile(
  input: z.input<typeof profileSchema>,
): Promise<{ ok: true } | { ok: false; error: PublicError }> {
  try {
    const data = profileSchema.parse(input);
    const auth = await requireAuthContext();
    const { error } = await auth.db
      .from("user_profiles")
      .update({ display_name: data.displayName })
      .eq("id", auth.userId);
    if (error) throw error;
    // Language and time zone go through the audited preferences path.
    await updatePreferences(auth, { language: data.language, timezone: data.timezone });
    (await cookies()).set(LOCALE_COOKIE, data.language, {
      path: "/",
      maxAge: ONE_YEAR,
      sameSite: "lax",
    });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

export async function setTheme(theme: string): Promise<void> {
  const parsed = z.enum(THEMES).parse(theme);
  await updatePreferences(await requireAuthContext(), { theme: parsed });
  (await cookies()).set(THEME_COOKIE, parsed, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
  revalidatePath("/", "layout");
}

export async function setAccent(accent: string): Promise<void> {
  await updatePreferences(await requireAuthContext(), { accent: z.enum(ACCENTS).parse(accent) });
  revalidatePath("/", "layout");
}

const voiceSchema = z
  .object({
    continuous: z.boolean(),
    language: z.enum(VOICE_LANGUAGES),
    voice: z.enum(VOICE_KEYS),
  })
  .strict();

type Result = { ok: true } | { ok: false; error: PublicError };

async function attempt(fn: () => Promise<void>, path = "/", type?: "layout"): Promise<Result> {
  try {
    await fn();
    revalidatePath(path, type);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/**
 * Voice (ADR-068): continuous conversation, the voice language and the voice — the only
 * choices. The wake phrase is always "Elise"; the rest are defaults (see core/voice/preferences).
 */
export async function setVoicePreferences(input: z.input<typeof voiceSchema>): Promise<Result> {
  return attempt(
    async () => {
      const v = voiceSchema.parse(input);
      const auth = await requireAuthContext();
      // The same preference ELISE changes from chat (ADR-030): one voice, wherever it's set.
      await setPreferredVoice(auth, v.voice, "user_ui");
      await updateVoiceSettings(auth, { continuous: v.continuous, language: v.language });
      await auth.db.from("audit_events").insert({
        workspace_id: auth.workspaceId,
        user_id: auth.userId,
        event_type: "settings.voice_changed",
        resource_type: "user_profile",
        resource_id: auth.userId,
        origin: "user_ui",
        result: "success",
        metadata: v,
      });
    },
    "/",
    "layout",
  );
}

/**
 * ELISE's personality (ADR-076), from Settings or onboarding: the same preference chat and
 * voice change. Tone only — permissions and approvals never depend on it.
 */
export async function setPersonalityAction(
  personality: string,
  from: "settings" | "onboarding" = "settings",
): Promise<Result> {
  return attempt(
    async () => {
      const p = z.enum(PERSONALITIES).parse(personality);
      await setPersonality(
        await requireAuthContext(),
        p,
        "user_ui",
        from === "onboarding" ? "onboarding" : "user",
      );
    },
    "/",
    "layout",
  );
}

const CONSENT_KEY = "voice.continuous_consent";

/**
 * The explicit choice about continuous conversation (onboarding, ADR-068): saved with when and
 * where it was made. Never turned on without it.
 */
export async function chooseContinuousConversation(
  enabled: boolean,
  source: "onboarding" | "settings",
): Promise<Result> {
  return attempt(
    async () => {
      const on = z.boolean().parse(enabled);
      const auth = await requireAuthContext();
      await updateVoiceSettings(auth, { continuous: on });
      await auth.db.from("user_preferences").upsert(
        {
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          key: CONSENT_KEY,
          value_json: { enabled: on, at: new Date().toISOString(), source },
          source: source === "onboarding" ? "onboarding" : "user",
        },
        { onConflict: "workspace_id,user_id,key" },
      );
    },
    "/",
    "layout",
  );
}

// ── Memory (ADR-068) ─────────────────────────────────────────────────────────

const id = z.uuid();
const factValue = z.string().trim().min(1).max(300);

export async function setMemoryEnabledAction(enabled: boolean): Promise<Result> {
  return attempt(
    async () => setMemoryEnabled(await requireAuthContext(), z.boolean().parse(enabled)),
    "/settings/memory",
  );
}

export async function addMemoryAction(input: { key: string; value: string }): Promise<Result> {
  return attempt(async () => {
    const v = z.object({ key: z.string().trim().min(1).max(60), value: factValue }).parse(input);
    await rememberFact(await requireAuthContext(), {
      ...v,
      confidence: "stated",
      conversationId: null,
    });
  }, "/settings/memory");
}

export async function editMemoryAction(factId: string, value: string): Promise<Result> {
  return attempt(
    async () =>
      editMemoryFact(await requireAuthContext(), id.parse(factId), factValue.parse(value)),
    "/settings/memory",
  );
}

export async function forgetMemoryAction(factId: string): Promise<Result> {
  return attempt(
    async () => void (await forgetFact(await requireAuthContext(), id.parse(factId))),
    "/settings/memory",
  );
}

export async function clearMemoryAction(): Promise<Result> {
  return attempt(async () => clearMemory(await requireAuthContext()), "/settings/memory");
}

// ── Storage (ADR-068) ────────────────────────────────────────────────────────

/** Removes a file uploaded to Knowledge, with what ELISE learned from it. */
export async function deleteStoredFileAction(itemId: string): Promise<Result> {
  return attempt(
    async () => deleteStoredFile(await requireAuthContext(), id.parse(itemId)),
    "/settings/storage",
    "layout",
  );
}
