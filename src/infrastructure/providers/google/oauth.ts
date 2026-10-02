import { createHash, randomBytes } from "node:crypto";

import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";

/**
 * Google OAuth 2.0 for web server apps (authorization code + PKCE, offline access,
 * incremental authorization). Endpoints per Google's current OAuth documentation.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

/** Only what the account identity needs; capability scopes are requested progressively. */
export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

/**
 * Least privilege per capability, requested incrementally on the same connection
 * (include_granted_scopes): adding one never drops the others. Email uses gmail.modify, the
 * narrowest single scope that covers reading, drafts, sending, archiving and read state; it
 * cannot permanently delete mail (docs/decisions/ADR-005).
 */
export const CAPABILITY_SCOPES = {
  calendar: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  email: ["https://www.googleapis.com/auth/gmail.modify"],
  // Knowledge from Drive: read-only, and only what the user selects gets indexed.
  knowledge: ["https://www.googleapis.com/auth/drive.readonly"],
  // Finance from Google Sheets: read-only values of the spreadsheets the user links.
  finance: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
} as const satisfies Partial<Record<CapabilityKey, readonly string[]>>;

export type GoogleCapability = keyof typeof CAPABILITY_SCOPES;
export const GOOGLE_CAPABILITIES = Object.keys(CAPABILITY_SCOPES) as GoogleCapability[];

export function isGoogleCapability(value: string): value is GoogleCapability {
  return (GOOGLE_CAPABILITIES as string[]).includes(value);
}

export function scopesFor(capabilities: readonly GoogleCapability[]): string[] {
  return [...new Set([...IDENTITY_SCOPES, ...capabilities.flatMap((c) => CAPABILITY_SCOPES[c])])];
}

/** Capabilities whose every scope was actually granted (users can untick scopes on consent). */
export function grantedCapabilities(grantedScopes: readonly string[]): GoogleCapability[] {
  const granted = new Set(grantedScopes);
  return GOOGLE_CAPABILITIES.filter((c) => CAPABILITY_SCOPES[c].every((s) => granted.has(s)));
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Opaque, single-use state. Only its hash is stored. */
export function createState(): { state: string; hash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, hash: hashState(state) };
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function buildAuthorizationUrl(
  config: GoogleOAuthConfig,
  params: { scopes: string[]; state: string; codeChallenge: string; loginHint?: string | null },
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: params.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    // Always show consent so a refresh token is issued, and the user can choose the account.
    prompt: "consent select_account",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
  }).toString();
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function postToken(body: Record<string, string>, fetchImpl: FetchLike): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Google did not respond", { cause });
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // invalid_grant: refresh token revoked/expired or code already used — the user must reconnect.
    if (json.error === "invalid_grant") {
      throw new AppError("AUTH_EXPIRED", "Google access was revoked or expired", {
        recovery: "reconnect",
        details: { providerCode: "invalid_grant" },
      });
    }
    throw new AppError("PROVIDER_UNAVAILABLE", "Google rejected the token request", {
      details: { providerCode: json.error ?? String(res.status) },
    });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    scopes: (json.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeCode(
  config: GoogleOAuthConfig,
  params: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postToken(
    {
      code: params.code,
      code_verifier: params.codeVerifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    },
    fetchImpl,
  );
}

export function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSet> {
  return postToken(
    {
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    },
    fetchImpl,
  );
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

export async function fetchIdentity(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<GoogleIdentity> {
  const res = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    sub?: string;
    email?: string;
    name?: string;
  };
  if (!res.ok || !json.sub || !json.email) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Could not read the Google account identity");
  }
  return { sub: json.sub, email: json.email, name: json.name ?? null };
}

/** Best effort: revoking the refresh token invalidates every token of this grant at Google. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** A friendly default alias from the account: gmail.com → "Personal", acme.com → "Acme". */
export function suggestAlias(email: string): string {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain || ["gmail.com", "googlemail.com"].includes(domain)) return "Personal";
  const name = domain.split(".")[0] ?? domain;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
