import "server-only";

import { serverEnv } from "./server-env";

/**
 * ELISE's public base URL, for OAuth redirect URIs (they must match the provider's registration
 * exactly). In order:
 * 1. NEXT_PUBLIC_APP_URL;
 * 2. on Vercel Production, the project's production domain (never a per-deployment hostname);
 * 3. the request's own origin (local development).
 */
export function publicAppUrl(origin?: string): string {
  const env = serverEnv();
  const base =
    env.NEXT_PUBLIC_APP_URL ??
    (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : origin) ??
    "";
  return base.replace(/\/+$/, "");
}

/** `{public URL}{path}`: the one place OAuth callbacks are built. */
export function oauthCallbackUrl(path: string, origin?: string): string {
  return `${publicAppUrl(origin)}${path}`;
}
