import type { TeamAccess } from "@/core/capabilities/team-messaging";
import { AppError } from "@/core/errors";

import type { FetchLike, TokenSet } from "../google/oauth";

/**
 * Slack OAuth v2 (ADR-062): user-token scopes only — ELISE acts as the user who connected, never
 * as a bot, so private channels and DMs are searchable only when that user allows them, and
 * Real-time Search needs no action_token. Each workspace + user is its own connection. Slack
 * accumulates scopes on every consent, so asking for one more permission extends the same grant.
 */
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_API = "https://slack.com/api";

/**
 * What the user chooses, in product terms, and exactly the user scopes each needs. Only scopes
 * ELISE uses are requested (search, the conversation reads that expand a result, people names,
 * posting and reacting). `public` is the base every connection has.
 */
export const SLACK_PERMISSIONS = {
  public: [
    "search:read.public",
    "search:read.users",
    "channels:read",
    "channels:history",
    "users:read",
    "team:read",
  ],
  private: ["search:read.private", "groups:read", "groups:history"],
  direct: [
    "search:read.im",
    "search:read.mpim",
    "im:read",
    "im:history",
    "mpim:read",
    "mpim:history",
  ],
  files: ["search:read.files"],
  // im:write opens the direct conversation with a person before posting to it.
  send: ["chat:write", "im:write"],
  reactions: ["reactions:write"],
} as const;

export type SlackPermission = keyof typeof SLACK_PERMISSIONS;
export const SLACK_PERMISSION_KEYS = Object.keys(SLACK_PERMISSIONS) as SlackPermission[];
/** Legacy search (search.messages): only for an app Slack doesn't allow Real-time Search for. */
export const LEGACY_SEARCH_SCOPE = "search:read";

export function isSlackPermission(value: string): value is SlackPermission {
  return (SLACK_PERMISSION_KEYS as string[]).includes(value);
}

/** User scopes for these permissions; `public` (the base) is always included. */
export function scopesFor(permissions: readonly SlackPermission[], legacySearch = false): string[] {
  const keys = new Set<SlackPermission>(["public", ...permissions]);
  return [
    ...new Set([
      ...[...keys].flatMap((k) => SLACK_PERMISSIONS[k]),
      ...(legacySearch ? [LEGACY_SEARCH_SCOPE] : []),
    ]),
  ];
}

/**
 * What a grant can reach. A permission counts only when the scopes ELISE uses for it are there:
 * the conversation reads, plus search (Real-time, or the legacy fallback when it was granted).
 */
export function grantedAccess(scopes: readonly string[]): TeamAccess[] {
  const has = new Set(scopes);
  const search = (rts: string) => has.has(rts) || has.has(LEGACY_SEARCH_SCOPE);
  const access: TeamAccess[] = [];
  if (search("search:read.public") && has.has("channels:history")) access.push("public");
  if (search("search:read.private") && has.has("groups:history")) access.push("private");
  if (search("search:read.im") && has.has("im:history")) access.push("direct");
  if (search("search:read.files")) access.push("files");
  if (has.has("users:read")) access.push("people");
  if (has.has("chat:write")) access.push("send");
  if (has.has("reactions:write")) access.push("reactions");
  return access;
}

/** Permissions whose scopes were all granted (what Connections shows as allowed). */
export function grantedPermissions(scopes: readonly string[]): SlackPermission[] {
  const has = new Set(scopes);
  return SLACK_PERMISSION_KEYS.filter((k) =>
    SLACK_PERMISSIONS[k].every(
      (s) => has.has(s) || (s.startsWith("search:read.") && has.has(LEGACY_SEARCH_SCOPE)),
    ),
  );
}

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildAuthorizationUrl(
  config: SlackOAuthConfig,
  params: { userScopes: string[]; state: string; team?: string | null },
): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    // User scopes only: no bot scopes, no bot user.
    user_scope: params.userScopes.join(","),
    redirect_uri: config.redirectUri,
    state: params.state,
    // Reconnecting or extending: suggest that same workspace (Slack may still let the user pick).
    ...(params.team ? { team: params.team } : {}),
  }).toString();
  return url.toString();
}

/** One authorized user in one workspace, as Slack's token exchange returns it. */
export interface SlackGrant {
  userId: string;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  tokens: TokenSet;
  /** The token expires and comes with a refresh token (Slack token rotation is on). */
  rotating: boolean;
}

interface AccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  team?: { id?: string; name?: string } | null;
  enterprise?: { id?: string; name?: string } | null;
}

/** Non-rotating Slack user tokens don't expire: stored with a far expiry, never refreshed. */
const NEVER = new Date("2999-01-01T00:00:00Z");

/** Slack's refusals as ELISE errors: a broken grant asks to reconnect; a bad app is server setup. */
export function slackAuthError(code: string): AppError {
  if (
    [
      "invalid_client_id",
      "bad_client_secret",
      "invalid_client",
      "bad_redirect_uri",
      "oauth_authorization_url_mismatch",
      "invalid_scope",
    ].includes(code)
  )
    return new AppError("SERVER_NOT_CONFIGURED", "Slack sign-in is misconfigured on this server", {
      recovery: "configure",
      details: { reason: "client_misconfigured", providerReason: code },
    });
  if (["access_denied", "cancelled"].includes(code))
    return new AppError("PERMISSION_DENIED", "Slack access was not granted", {
      recovery: "retry",
      details: { reason: "cancelled" },
    });
  if (["ratelimited", "rate_limited"].includes(code))
    return new AppError("RATE_LIMITED", "Slack is limiting requests right now. Try again shortly.");
  if (
    [
      "invalid_refresh_token",
      "invalid_grant",
      "token_revoked",
      "token_expired",
      "invalid_auth",
      "account_inactive",
      "invalid_code",
    ].includes(code)
  )
    return new AppError("AUTH_EXPIRED", "This Slack workspace needs to be reconnected", {
      recovery: "reconnect",
      details: { reason: code === "invalid_code" ? "expired" : "revoked", providerReason: code },
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Slack rejected the request", {
    details: { providerReason: code },
  });
}

async function postAccess(
  config: SlackOAuthConfig,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<AccessResponse> {
  let res: Response;
  try {
    res = await fetchImpl(`${SLACK_API}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...body,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Slack did not respond", { cause });
  }
  if (res.status === 429)
    throw new AppError("RATE_LIMITED", "Slack is limiting requests right now. Try again shortly.");
  if (res.status >= 500)
    throw new AppError("PROVIDER_UNAVAILABLE", "Slack is temporarily unavailable", {
      details: { providerStatus: res.status },
    });
  const json = (await res
    .json()
    .catch(() => ({ ok: false, error: "invalid_response" }))) as AccessResponse;
  if (!json.ok) throw slackAuthError(json.error ?? "unknown");
  return json;
}

const scopeList = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function tokenSet(
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number | undefined,
  scopes: string[],
): TokenSet {
  return {
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : NEVER,
    scopes,
  };
}

/** The callback's code → the user's token for that workspace (redirect_uri must match exactly). */
export async function exchangeCode(
  config: SlackOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<SlackGrant> {
  const json = await postAccess(config, { code, redirect_uri: config.redirectUri }, fetchImpl);
  const user = json.authed_user;
  const teamId = json.team?.id ?? json.enterprise?.id;
  if (!user?.id || !user.access_token || !teamId)
    throw new AppError("PERMISSION_DENIED", "Slack did not grant access for your user", {
      recovery: "retry",
    });
  return {
    userId: user.id,
    teamId,
    teamName: json.team?.name ?? json.enterprise?.name ?? null,
    enterpriseId: json.enterprise?.id ?? null,
    enterpriseName: json.enterprise?.name ?? null,
    tokens: tokenSet(user.access_token, user.refresh_token, user.expires_in, scopeList(user.scope)),
    rotating: Boolean(user.refresh_token && user.expires_in),
  };
}

/**
 * Token rotation: a refresh token works once. The response carries the replacement, which must
 * be stored before anything else uses the grant (the caller holds the refresh lease).
 */
export async function refreshAccessToken(
  config: SlackOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  const json = await postAccess(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
  );
  // User-token refreshes answer at the top level; accept the install shape too.
  const t = json.authed_user?.access_token ? json.authed_user : json;
  if (!t.access_token) throw slackAuthError("invalid_refresh_token");
  return tokenSet(t.access_token, t.refresh_token, t.expires_in, scopeList(t.scope));
}

export interface SlackIdentity {
  userName: string;
  handle: string | null;
  teamName: string | null;
  teamDomain: string | null;
  teamIcon: string | null;
}

/**
 * Who connected and which workspace, for the Connections card. Best effort: a missing name never
 * fails a connection that Slack already granted.
 */
export async function fetchIdentity(
  accessToken: string,
  grant: Pick<SlackGrant, "userId" | "teamId" | "teamName">,
  fetchImpl: FetchLike = fetch,
): Promise<SlackIdentity> {
  const call = async <T>(method: string, args: Record<string, string>): Promise<T | null> => {
    try {
      const res = await fetchImpl(`${SLACK_API}/${method}?${new URLSearchParams(args)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { ok?: boolean } & T;
      return json.ok ? json : null;
    } catch {
      return null;
    }
  };
  const [user, team] = await Promise.all([
    call<{
      user?: {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
    }>("users.info", { user: grant.userId }),
    call<{
      team?: {
        name?: string;
        domain?: string;
        icon?: { image_68?: string; image_default?: boolean };
      };
    }>("team.info", { team: grant.teamId }),
  ]);
  const u = user?.user;
  const icon = team?.team?.icon;
  return {
    userName:
      u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || grant.userId,
    handle: u?.name ?? null,
    teamName: team?.team?.name ?? grant.teamName,
    teamDomain: team?.team?.domain ?? null,
    teamIcon:
      icon && !icon.image_default && icon.image_68?.startsWith("https://") ? icon.image_68 : null,
  };
}

/** Revokes the user's token at Slack (best effort): disconnecting ends ELISE's access there too. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${SLACK_API}/auth.revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return Boolean(((await res.json()) as { ok?: boolean }).ok);
  } catch {
    return false;
  }
}
