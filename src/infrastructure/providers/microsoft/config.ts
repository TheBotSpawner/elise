import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import type { MicrosoftOAuthConfig } from "./oauth";

export const MICROSOFT_CALLBACK_PATH = "/api/connections/microsoft/callback";

export function isMicrosoftConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.MICROSOFT_OAUTH_CLIENT_ID &&
    env.MICROSOFT_OAUTH_CLIENT_SECRET &&
    env.ELISE_ENCRYPTION_KEY &&
    env.SUPABASE_SECRET_KEY,
  );
}

/** The redirect URI must match the Microsoft Entra app registration exactly. */
export function microsoftOAuthConfig(origin?: string): MicrosoftOAuthConfig {
  const env = serverEnv();
  if (
    !isMicrosoftConfigured() ||
    !env.MICROSOFT_OAUTH_CLIENT_ID ||
    !env.MICROSOFT_OAUTH_CLIENT_SECRET
  ) {
    throw new AppError(
      "SERVER_NOT_CONFIGURED",
      "Microsoft connections are not configured on this server",
      { recovery: "configure" },
    );
  }
  const base = (env.NEXT_PUBLIC_APP_URL ?? origin ?? "").replace(/\/$/, "");
  return {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
    redirectUri: `${base}${MICROSOFT_CALLBACK_PATH}`,
    tenant: env.MICROSOFT_OAUTH_TENANT ?? "common",
  };
}
