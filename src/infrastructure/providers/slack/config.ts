import "server-only";

import { oauthCallbackUrl } from "@/config/app-url";
import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import type { SlackOAuthConfig } from "./oauth";

/**
 * The one place Slack's configuration is read (ADR-062): Connections availability, the OAuth
 * start and callback, token refresh and the background worker all use it. Names, never values.
 */
export const SLACK_CALLBACK_PATH = "/api/connections/slack/callback";

export interface SlackSetup {
  missing: ("SLACK_CLIENT_ID" | "SLACK_CLIENT_SECRET")[];
  /** The encrypted credential vault the tokens are written to. */
  vaultMissing: ("ELISE_ENCRYPTION_KEY" | "SUPABASE_SECRET_KEY")[];
  /**
   * The Slack app is distributed but not Marketplace-listed: Slack allows it neither Real-time
   * Search nor more than 15 messages per history read, so ELISE uses legacy search and small pages.
   */
  unlisted: boolean;
  ready: boolean;
}

export function slackSetup(): SlackSetup {
  const env = serverEnv();
  const missing: SlackSetup["missing"] = [];
  if (!env.SLACK_CLIENT_ID) missing.push("SLACK_CLIENT_ID");
  if (!env.SLACK_CLIENT_SECRET) missing.push("SLACK_CLIENT_SECRET");
  const vaultMissing: SlackSetup["vaultMissing"] = [];
  if (!env.ELISE_ENCRYPTION_KEY) vaultMissing.push("ELISE_ENCRYPTION_KEY");
  if (!env.SUPABASE_SECRET_KEY) vaultMissing.push("SUPABASE_SECRET_KEY");
  return {
    missing,
    vaultMissing,
    unlisted: env.SLACK_LEGACY_SEARCH === "true",
    ready: missing.length === 0 && vaultMissing.length === 0,
  };
}

export function isSlackConfigured(): boolean {
  return slackSetup().ready;
}

export function slackRedirectUri(origin?: string): string {
  return oauthCallbackUrl(SLACK_CALLBACK_PATH, origin);
}

/**
 * Validated client settings, or SERVER_NOT_CONFIGURED naming what is missing — on Vercel or on
 * the Trigger.dev worker alike, never shown as "Slack isn't connected".
 */
export function getSlackOAuthConfig(origin?: string): SlackOAuthConfig {
  const setup = slackSetup();
  if (setup.missing.length)
    throw new AppError("SERVER_NOT_CONFIGURED", "Slack is not configured on this server", {
      recovery: "configure",
      details: { setup: "slack_oauth", missing: setup.missing },
    });
  if (setup.vaultMissing.length)
    throw new AppError("SERVER_NOT_CONFIGURED", "The credential vault is not configured", {
      recovery: "configure",
      details: { setup: "credential_vault", missing: setup.vaultMissing },
    });
  const env = serverEnv();
  return {
    clientId: env.SLACK_CLIENT_ID!,
    clientSecret: env.SLACK_CLIENT_SECRET!,
    redirectUri: slackRedirectUri(origin),
  };
}
