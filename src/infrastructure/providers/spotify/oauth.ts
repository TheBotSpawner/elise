import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

/**
 * Spotify OAuth (ADR-042): authorization code with PKCE, exchanged server-side with the client
 * secret. Tokens never reach the browser except a short-lived access token for the Web Playback
 * SDK (which requires one in the page), never the refresh token.
 *
 * Current Spotify rules this follows (verified 2026-10): redirect URIs must be HTTPS or an
 * explicit loopback IP (http://127.0.0.1:PORT — "localhost" is rejected); refresh tokens expire
 * six months after consent (invalid_grant → reconnect); refreshing may rotate the token.
 */

export const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";
export const SPOTIFY_CALLBACK_PATH = "/api/connections/spotify/callback";

/** Exactly what ELISE uses: reading and controlling playback, the user's playlists, and the
 * Web Playback SDK (streaming + the profile scopes it requires). */
export const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "streaming",
  "user-read-email",
  "user-read-private",
] as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SpotifyOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function isSpotifyConfigured(): boolean {
  const env = serverEnv();
  return Boolean(
    env.SPOTIFY_CLIENT_ID &&
    env.SPOTIFY_CLIENT_SECRET &&
    env.ELISE_ENCRYPTION_KEY &&
    env.SUPABASE_SECRET_KEY,
  );
}

export function spotifyOAuthConfig(origin?: string): SpotifyOAuthConfig {
  const env = serverEnv();
  if (!isSpotifyConfigured() || !env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET)
    throw new AppError("SERVER_NOT_CONFIGURED", "Spotify is not configured on this server", {
      recovery: "configure",
    });
  const base = (env.NEXT_PUBLIC_APP_URL ?? origin ?? "").replace(/\/$/, "");
  return {
    clientId: env.SPOTIFY_CLIENT_ID,
    clientSecret: env.SPOTIFY_CLIENT_SECRET,
    redirectUri: env.SPOTIFY_REDIRECT_URI ?? `${base}${SPOTIFY_CALLBACK_PATH}`,
  };
}

export function buildSpotifyAuthorizationUrl(
  config: SpotifyOAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    state: params.state,
    code_challenge_method: "S256",
    code_challenge: params.codeChallenge,
  }).toString();
  return url.toString();
}

export interface SpotifyTokens {
  accessToken: string;
  /** Null when a refresh didn't rotate it (keep the previous one). */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

async function tokenRequest(
  config: SpotifyOAuthConfig,
  body: Record<string, string>,
  fetchImpl: FetchLike,
  now = Date.now(),
): Promise<SpotifyTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError("PROVIDER_UNAVAILABLE", "Spotify did not respond", { cause });
  }
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    // invalid_grant: revoked, or the 6-month refresh-token lifetime ended. Reconnect.
    if (json.error === "invalid_grant")
      throw new AppError("AUTH_EXPIRED", "This Spotify account needs to be reconnected", {
        recovery: "reconnect",
      });
    throw new AppError("PROVIDER_UNAVAILABLE", "Spotify refused the token request", {
      details: { providerCode: json.error ?? String(res.status) },
    });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(now + (json.expires_in ?? 3600) * 1000),
    scopes: (json.scope ?? "").split(" ").filter(Boolean),
  };
}

export function exchangeSpotifyCode(
  config: SpotifyOAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<SpotifyTokens> {
  return tokenRequest(
    config,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    },
    fetchImpl,
  );
}

export function refreshSpotifyToken(
  config: SpotifyOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  now?: number,
): Promise<SpotifyTokens> {
  return tokenRequest(
    config,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl,
    now,
  );
}

/** The account's id and name (Spotify no longer returns email or product to dev-mode apps). */
export async function fetchSpotifyProfile(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string; name: string | null }> {
  const res = await fetchImpl("https://api.spotify.com/v1/me", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: string; display_name?: string };
  if (!res.ok || !json.id)
    throw new AppError("PERMISSION_DENIED", "Spotify access was not granted", {
      recovery: "retry",
    });
  return { id: json.id, name: json.display_name ?? null };
}
