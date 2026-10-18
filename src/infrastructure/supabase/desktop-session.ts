import "server-only";

import { createClient } from "@supabase/supabase-js";

import { supabasePublicConfig } from "@/config/env";
import { AppError } from "@/core/errors";

import { createAdminClient } from "./admin";

export interface MintedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

/**
 * A normal Supabase session for a person who just approved ELISE Desktop in their own browser
 * (ADR-081). Only called after a verified single-use PKCE code: an admin-generated magic-link
 * token (never emailed) is verified at once, so the result is the same session a sign-in gives.
 */
export async function mintSessionForUser(userId: string): Promise<MintedSession> {
  const admin = createAdminClient();
  const { data: user, error: userError } = await admin.auth.admin.getUserById(userId);
  const email = user?.user?.email;
  if (userError || !email)
    throw new AppError("AUTH_ERROR", "This account can't sign in to ELISE Desktop yet", {
      recovery: "sign_in",
    });
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash)
    throw new AppError("INTERNAL_ERROR", "Could not sign in ELISE Desktop", { cause: linkError });
  const { url, publishableKey } = supabasePublicConfig();
  const anon = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error || !data.session || data.session.user.id !== userId)
    throw new AppError("INTERNAL_ERROR", "Could not sign in ELISE Desktop", { cause: error });
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? null,
  };
}
