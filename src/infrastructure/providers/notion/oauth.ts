import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import { NOTION_API, type FetchLike } from "./http";

/** Notion public integration OAuth (authorization code). Tokens never reach the browser. */
export const NOTION_AUTH_URL = `${NOTION_API}/oauth/authorize`;
export const NOTION_CALLBACK_PATH = "/api/connections/notion/callback";

export interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function isNotionConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.NOTION_OAUTH_CLIENT_ID &&
    env.NOTION_OAUTH_CLIENT_SECRET &&
    env.ELISE_ENCRYPTION_KEY &&
    env.SUPABASE_SECRET_KEY,
  );
}

export function notionOAuthConfig(origin?: string): NotionOAuthConfig {
  const env = serverEnv();
  if (!isNotionConfigured() || !env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) {
    throw new AppError("SERVER_NOT_CONFIGURED", "Notion is not configured on this server", {
      recovery: "configure",
    });
  }
  const base = (env.NEXT_PUBLIC_APP_URL ?? origin ?? "").replace(/\/$/, "");
  return {
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
    redirectUri: `${base}${NOTION_CALLBACK_PATH}`,
  };
}

export function buildNotionAuthorizationUrl(config: NotionOAuthConfig, state: string): string {
  const url = new URL(NOTION_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    owner: "user",
    state,
  }).toString();
  return url.toString();
}

export interface NotionGrant {
  accessToken: string;
  refreshToken: string | null;
  botId: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
}

export async function exchangeNotionCode(
  config: NotionOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<NotionGrant> {
  let res: Response;
  try {
    res = await fetchImpl(`${NOTION_API}/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Notion did not respond", { cause });
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    bot_id?: string;
    workspace_id?: string;
    workspace_name?: string;
    owner?: { user?: { person?: { email?: string } } };
    error?: string;
  };
  if (!res.ok || !json.access_token || !json.workspace_id || !json.bot_id) {
    throw new AppError("PERMISSION_DENIED", "Notion access was not granted", {
      recovery: "retry",
      details: { providerCode: json.error ?? String(res.status) },
    });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    botId: json.bot_id,
    workspaceId: json.workspace_id,
    workspaceName: json.workspace_name ?? null,
    ownerEmail: json.owner?.user?.person?.email ?? null,
  };
}
