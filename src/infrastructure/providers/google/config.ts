import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import type { GoogleOAuthConfig } from "./oauth";

export const GOOGLE_CALLBACK_PATH = "/api/connections/google/callback";

export function isGoogleConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.ELISE_ENCRYPTION_KEY &&
    env.SUPABASE_SECRET_KEY,
  );
}

/** OAuth client settings. The redirect URI must match Google Cloud Console exactly. */
export function googleOAuthConfig(origin?: string): GoogleOAuthConfig {
  const env = serverEnv();
  if (!isGoogleConfigured() || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new AppError(
      "SERVER_NOT_CONFIGURED",
      "Google connections are not configured on this server",
      {
        recovery: "configure",
      },
    );
  }
  const base = (env.NEXT_PUBLIC_APP_URL ?? origin ?? "").replace(/\/$/, "");
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: `${base}${GOOGLE_CALLBACK_PATH}`,
  };
}
