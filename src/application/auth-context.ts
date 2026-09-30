import "server-only";

import { cache } from "react";

import { isSupabaseConfigured } from "@/config/env";
import { AppError } from "@/core/errors";
import { createClient, type ServerSupabase } from "@/infrastructure/supabase/server";

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
  const [profileRes, workspacesRes] = await Promise.all([
    db.from("user_profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("workspaces").select("id, type").is("archived_at", null).order("created_at"),
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
    },
  };
});

export async function requireAuthContext(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
  return auth;
}
