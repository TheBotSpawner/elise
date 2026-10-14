import { AppError } from "@/core/errors";

import type { FetchLike, TokenSet } from "../google/oauth";

/**
 * Microsoft identity platform v2 (ADR-058): authorization code + PKCE for a confidential web
 * client, delegated permissions only. The `common` authority accepts work/school and personal
 * Microsoft accounts. PKCE, state and hashing are shared with Google (../google/oauth).
 */
export const GRAPH_URL = "https://graph.microsoft.com/v1.0";
const LOGIN_URL = "https://login.microsoftonline.com";

/** Identity + a refresh token. User.Read is what /me needs. */
export const IDENTITY_SCOPES = ["openid", "profile", "offline_access", "User.Read"] as const;

/**
 * Email asks for reading/organizing and sending together, like Gmail's single gmail.modify
 * scope: one consent, and sending is still gated by ELISE's approval policy, not by the scope.
 * Never application permissions; never Mail.*.Shared (shared mailboxes are out of scope).
 */
export const CAPABILITY_SCOPES = {
  email: ["Mail.ReadWrite", "Mail.Send"],
} as const;

export type MicrosoftCapability = keyof typeof CAPABILITY_SCOPES;
export const MICROSOFT_CAPABILITIES = Object.keys(CAPABILITY_SCOPES) as MicrosoftCapability[];

export function scopesFor(capabilities: readonly MicrosoftCapability[]): string[] {
  return [...new Set([...IDENTITY_SCOPES, ...capabilities.flatMap((c) => CAPABILITY_SCOPES[c])])];
}

/** Graph echoes scopes as "Mail.Send" or "https://graph.microsoft.com/Mail.Send", any case. */
function normalizeScope(scope: string): string {
  return scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
}

/** Capabilities whose every scope was granted (an admin or the user may grant fewer). */
export function grantedCapabilities(grantedScopes: readonly string[]): MicrosoftCapability[] {
  const granted = new Set(grantedScopes.map(normalizeScope));
  return MICROSOFT_CAPABILITIES.filter((c) =>
    CAPABILITY_SCOPES[c].every((s) => granted.has(normalizeScope(s))),
  );
}

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** "common" (default), "organizations", "consumers" or a tenant id. */
  tenant: string;
}

export function buildAuthorizationUrl(
  config: MicrosoftOAuthConfig,
  params: { scopes: string[]; state: string; codeChallenge: string; loginHint?: string | null },
): string {
  const url = new URL(`${LOGIN_URL}/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: params.scopes.join(" "),
    // Let the user pick which Microsoft account (several can be connected side by side).
    prompt: "select_account",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_codes?: number[];
  suberror?: string;
}

/**
 * Why Microsoft refused, as a stable reason (never the raw description, which can echo
 * identifiers). AADSTS codes: learn.microsoft.com/entra/identity-platform/reference-error-codes.
 */
export type MicrosoftAuthReason =
  | "cancelled"
  | "admin_consent_required"
  | "consent_revoked"
  | "conditional_access"
  | "expired"
  | "revoked"
  | "client_misconfigured"
  | "unknown";

export function microsoftAuthReason(error: {
  error?: string | null;
  codes?: readonly number[];
  description?: string | null;
  suberror?: string | null;
}): MicrosoftAuthReason {
  const codes = new Set(error.codes ?? []);
  // Codes also arrive only inside the description ("AADSTS90094: …") on the authorize redirect.
  for (const m of (error.description ?? "").matchAll(/AADSTS(\d+)/g)) codes.add(Number(m[1]));
  const has = (...c: number[]) => c.some((x) => codes.has(x));
  if (has(90094, 90095, 90099, 900941, 650052) || error.error === "admin_consent_required")
    return "admin_consent_required";
  if (has(65004) || error.error === "access_denied") return "cancelled";
  if (has(65001) || error.suberror === "consent_required" || error.error === "consent_required")
    return "consent_revoked";
  if (
    has(53000, 53001, 53002, 53003, 50076, 50079, 50158) ||
    error.error === "interaction_required"
  )
    return "conditional_access";
  if (has(7000215, 7000222, 700016, 50011, 700054) || error.error === "invalid_client")
    return "client_misconfigured";
  if (has(50173, 70043, 700084, 700082, 70008, 50133) || error.suberror === "token_expired")
    return "expired";
  if (error.error === "invalid_grant") return "revoked";
  return "unknown";
}

/** The ELISE error for a reason (the reason travels in details for health and the UI). */
export function authError(reason: MicrosoftAuthReason): AppError {
  const details = { reason };
  switch (reason) {
    case "cancelled":
      return new AppError("PERMISSION_DENIED", "Microsoft access was not granted", {
        recovery: "retry",
        details,
      });
    case "admin_consent_required":
      return new AppError(
        "PERMISSION_DENIED",
        "Your organization's administrator has to approve ELISE in Microsoft first",
        { recovery: "review", details },
      );
    case "client_misconfigured":
      return new AppError("SERVER_NOT_CONFIGURED", "Microsoft sign-in is misconfigured here", {
        recovery: "configure",
        details,
      });
    case "unknown":
      return new AppError("PROVIDER_UNAVAILABLE", "Microsoft rejected the request", { details });
    default:
      // Expired, revoked, consent withdrawn or a conditional-access policy: sign in again.
      return new AppError("AUTH_EXPIRED", "This Microsoft account needs to be reconnected", {
        recovery: "reconnect",
        details,
      });
  }
}

async function postToken(
  config: MicrosoftOAuthConfig,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(`${LOGIN_URL}/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`, {
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
    throw new AppError("PROVIDER_UNAVAILABLE", "Microsoft did not respond", { cause });
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    if (res.status >= 500 || json.error === "temporarily_unavailable")
      throw new AppError("PROVIDER_UNAVAILABLE", "Microsoft is temporarily unavailable", {
        details: { providerStatus: res.status },
      });
    throw authError(
      microsoftAuthReason({ error: json.error, codes: json.error_codes, suberror: json.suberror }),
    );
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    scopes: (json.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeCode(
  config: MicrosoftOAuthConfig,
  params: { code: string; codeVerifier: string; scopes: string[] },
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postToken(
    config,
    {
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: config.redirectUri,
      scope: params.scopes.join(" "),
    },
    fetchImpl,
  );
}

/** Microsoft rotates refresh tokens: the new one (when returned) replaces the stored one. */
export function refreshAccessToken(
  config: MicrosoftOAuthConfig,
  refreshToken: string,
  scopes: string[],
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postToken(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") },
    fetchImpl,
  );
}

export interface MicrosoftIdentity {
  /** Graph user id: stable, the account key (an email can change). */
  id: string;
  /** `mail`, or the userPrincipalName when the account has no mailbox address set. */
  email: string;
  name: string | null;
}

export async function fetchIdentity(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<MicrosoftIdentity> {
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH_URL}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Microsoft did not respond", { cause });
  }
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    displayName?: string | null;
    mail?: string | null;
    userPrincipalName?: string | null;
  };
  const email = json.mail || json.userPrincipalName;
  if (!res.ok || !json.id || !email)
    throw new AppError("PROVIDER_UNAVAILABLE", "Could not read the Microsoft account identity");
  return { id: json.id, email, name: json.displayName ?? null };
}

/** A friendly default alias: outlook.com/hotmail → "Personal", firbot.com → "Firbot". */
export function suggestAlias(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || /^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return "Personal";
  const name = domain.split(".")[0] ?? domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
