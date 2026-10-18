import "server-only";

import { cache } from "react";

import { isSupabaseConfigured } from "@/config/env";
import { DATE_ORDER_PREFERENCE_KEY, resolveDateOrder, type DateOrder } from "@/core/dates";
import { AppError } from "@/core/errors";
import {
  PERSONALITY_PREFERENCE_KEY,
  resolvePersonality,
  type ElisePersonality,
} from "@/core/personality";
import { resolveVoice, type VoiceKey } from "@/core/voice/catalog";
import { voicePreferences } from "@/core/voice/preferences";
import { availableVoiceKeys } from "@/infrastructure/ai/voices";
import { createClient, type ServerSupabase } from "@/infrastructure/supabase/server";

/** Voice preferences (ADR-014); allowlisted in the database. */
export interface VoicePreferences {
  enabled: boolean;
  /** Speak replies aloud (voice input still works with it off). */
  speak: boolean;
  language: "auto" | "es" | "en";
  /** The curated voice in use (ADR-030), resolved against what's configured now. */
  voice: VoiceKey;
  /** After a reply, keep listening (ADR-017). */
  continuous: boolean;
  /** Speaking over ELISE interrupts her. */
  bargeIn: boolean;
  /** A sleeping session wakes on the wake phrase (where the device can detect it). */
  wakeEnabled: boolean;
  wakePhrase: "elise" | "hey_elise" | "oye_elise" | "liz";
  /** Which voice runtime this deployment offers (ADR-026); set by the page, not stored. */
  runtime?: "legacy" | "live";
}

export interface AuthContext {
  db: ServerSupabase;
  userId: string;
  email: string | null;
  workspaceId: string;
  profile: {
    displayName: string | null;
    locale: "es" | "en";
    timezone: string;
    onboardingStatus: "pending" | "completed" | "skipped";
    theme: "system" | "dark" | "light";
    accent: "cyan" | "blue" | "violet" | "green" | "amber";
    voice: VoicePreferences;
    /** ELISE's base personality (ADR-076): tone only. */
    personality: ElisePersonality;
    /** Short dates: day first unless the user chose month first (ADR-078). */
    dateOrder: DateOrder;
  };
}

/**
 * Resolves the authenticated user and their active workspace for this request
 * (docs/engineering/17 §5). Identity comes from the verified session, never from client input.
 * Memoized per request.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  // No project configured means no accounts yet: behave as signed out.
  if (!isSupabaseConfigured()) return null;
  const db = await createClient();
  const { data } = await db.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;

  // RLS only returns workspaces the user is an active member of.
  // The chosen voice is read alongside, so speech never waits on another round trip.
  const [profileRes, workspacesRes, voiceRes] = await Promise.all([
    db.from("user_profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("workspaces").select("id, type").is("archived_at", null).order("created_at"),
    db
      .from("user_preferences")
      .select("workspace_id, key, value_json")
      .eq("user_id", userId)
      .in("key", [VOICE_PREFERENCE_KEY, PERSONALITY_PREFERENCE_KEY, DATE_ORDER_PREFERENCE_KEY]),
  ]);
  if (profileRes.error || workspacesRes.error) {
    throw new AppError("INTERNAL_ERROR", "Could not load account", {
      cause: profileRes.error ?? workspacesRes.error,
    });
  }

  // MVP: every user operates in their personal workspace; team workspaces come later.
  const workspace = workspacesRes.data.find((w) => w.type === "personal") ?? workspacesRes.data[0];
  if (!profileRes.data || !workspace) {
    throw new AppError("AUTH_ERROR", "Account setup is incomplete", { recovery: "sign_in" });
  }

  const profile = profileRes.data;
  // A failed read never blocks the request: the voice falls back to ELISE.
  const stored = (key: string) =>
    voiceRes.data?.find((r) => r.workspace_id === workspace.id && r.key === key)?.value_json;
  const storedVoice = stored(VOICE_PREFERENCE_KEY);
  return {
    db,
    userId,
    email: typeof data.claims.email === "string" ? data.claims.email : null,
    workspaceId: workspace.id,
    profile: {
      displayName: profile.display_name,
      locale: profile.preferred_language,
      timezone: profile.timezone,
      onboardingStatus: profile.onboarding_status,
      theme: profile.theme,
      accent: profile.accent,
      voice: voicePreferences(profile, resolveVoice(storedVoice, availableVoiceKeys())),
      personality: resolvePersonality(stored(PERSONALITY_PREFERENCE_KEY)),
      dateOrder: resolveDateOrder(stored(DATE_ORDER_PREFERENCE_KEY)),
    },
  };
});

/** Where the chosen voice lives (`user_preferences`, per person and workspace, under RLS). */
export const VOICE_PREFERENCE_KEY = "voice.preferred_voice_key";

export async function requireAuthContext(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
  return auth;
}
