import "server-only";

import { oauthCallbackUrl } from "@/config/app-url";
import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";

import type { MicrosoftOAuthConfig } from "./oauth";

/**
 * The one place Microsoft's configuration is read and checked (ADR-058). Connections
 * availability, OAuth start, the callback, token refresh and background clients all use it.
 * Canonical names: MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET, MICROSOFT_OAUTH_TENANT
 * (optional; absent or blank → "common").
 */
export const MICROSOFT_CALLBACK_PATH = "/api/connections/microsoft/callback";
const LOGIN = "https://login.microsoftonline.com";

export type TenantMode = "common" | "organizations" | "consumers" | "tenant-id" | "invalid";

/** A tenant is a well-known audience, a directory GUID or a verified domain. */
export function tenantMode(tenant: string): TenantMode {
  const t = tenant.toLowerCase();
  if (t === "common" || t === "organizations" || t === "consumers") return t;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return "tenant-id";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t)) return "tenant-id";
  return "invalid";
}

/**
 * What Microsoft OAuth needs on this server, split by kind so a missing secret never reads as
 * another problem. Names and booleans only — never values.
 */
export interface MicrosoftSetup {
  /** Microsoft's own settings that are missing or malformed. */
  missing: (
    "MICROSOFT_OAUTH_CLIENT_ID" | "MICROSOFT_OAUTH_CLIENT_SECRET" | "MICROSOFT_OAUTH_TENANT"
  )[];
  /**
   * The encrypted credential vault: tokens are encrypted (ELISE_ENCRYPTION_KEY) and written with
   * the server role (SUPABASE_SECRET_KEY). Without it a connection could not be saved.
   */
  vaultMissing: ("ELISE_ENCRYPTION_KEY" | "SUPABASE_SECRET_KEY")[];
  tenant: string;
  tenantMode: TenantMode;
  /** https://login.microsoftonline.com/{tenant}/oauth2/v2.0 */
  authority: string;
  ready: boolean;
}

export function microsoftSetup(): MicrosoftSetup {
  const env = serverEnv();
  const tenant = env.MICROSOFT_OAUTH_TENANT ?? "common";
  const mode = tenantMode(tenant);
  const missing: MicrosoftSetup["missing"] = [];
  if (!env.MICROSOFT_OAUTH_CLIENT_ID) missing.push("MICROSOFT_OAUTH_CLIENT_ID");
  if (!env.MICROSOFT_OAUTH_CLIENT_SECRET) missing.push("MICROSOFT_OAUTH_CLIENT_SECRET");
  if (mode === "invalid") missing.push("MICROSOFT_OAUTH_TENANT");
  const vaultMissing: MicrosoftSetup["vaultMissing"] = [];
  if (!env.ELISE_ENCRYPTION_KEY) vaultMissing.push("ELISE_ENCRYPTION_KEY");
  if (!env.SUPABASE_SECRET_KEY) vaultMissing.push("SUPABASE_SECRET_KEY");
  return {
    missing,
    vaultMissing,
    tenant,
    tenantMode: mode,
    authority: `${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0`,
    ready: missing.length === 0 && vaultMissing.length === 0,
  };
}

/** Whether Microsoft can be connected here (the Hub and health use this same check). */
export function isMicrosoftConfigured(): boolean {
  return microsoftSetup().ready;
}

/** The exact redirect URI registered in Entra: {public URL}/api/connections/microsoft/callback. */
export function microsoftRedirectUri(origin?: string): string {
  return oauthCallbackUrl(MICROSOFT_CALLBACK_PATH, origin);
}

/**
 * Validated client settings, or a SERVER_NOT_CONFIGURED error that says which kind of setup is
 * missing (`details.setup`) and which names (`details.missing`) — never values.
 */
export function getMicrosoftOAuthConfig(origin?: string): MicrosoftOAuthConfig {
  const setup = microsoftSetup();
  if (setup.missing.length)
    throw new AppError(
      "SERVER_NOT_CONFIGURED",
      "Microsoft OAuth is not configured on this server",
      {
        recovery: "configure",
        details: { setup: "microsoft_oauth", missing: setup.missing },
      },
    );
  if (setup.vaultMissing.length)
    throw new AppError("SERVER_NOT_CONFIGURED", "The credential vault is not configured", {
      recovery: "configure",
      details: { setup: "credential_vault", missing: setup.vaultMissing },
    });
  const env = serverEnv();
  return {
    clientId: env.MICROSOFT_OAUTH_CLIENT_ID!,
    clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
    redirectUri: microsoftRedirectUri(origin),
    tenant: setup.tenant,
    authority: setup.authority,
  };
}

/**
 * Safe, value-free diagnostics: presence booleans, the tenant's kind (its value only when it is
 * a well-known audience), the redirect URI ELISE sends and the endpoints it uses.
 */
export function microsoftDiagnostics(origin?: string) {
  const env = serverEnv();
  const setup = microsoftSetup();
  const wellKnown = ["common", "organizations", "consumers"].includes(setup.tenantMode);
  return {
    ready: setup.ready,
    clientIdPresent: Boolean(env.MICROSOFT_OAUTH_CLIENT_ID),
    clientSecretPresent: Boolean(env.MICROSOFT_OAUTH_CLIENT_SECRET),
    tenant: {
      configured: Boolean(env.MICROSOFT_OAUTH_TENANT),
      mode: setup.tenantMode,
      ...(wellKnown ? { value: setup.tenant } : {}),
    },
    missing: setup.missing,
    vault: {
      ready: setup.vaultMissing.length === 0,
      encryptionKeyPresent: Boolean(env.ELISE_ENCRYPTION_KEY),
      serverRoleKeyPresent: Boolean(env.SUPABASE_SECRET_KEY),
    },
    redirectUri: microsoftRedirectUri(origin),
    appUrlSource: env.NEXT_PUBLIC_APP_URL
      ? "NEXT_PUBLIC_APP_URL"
      : env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL
        ? "VERCEL_PROJECT_PRODUCTION_URL"
        : "request_origin",
    authority: wellKnown ? setup.authority : `${LOGIN}/{tenant-id}/oauth2/v2.0`,
    authorizationEndpoint: wellKnown
      ? `${setup.authority}/authorize`
      : `${LOGIN}/{tenant-id}/oauth2/v2.0/authorize`,
  };
}
