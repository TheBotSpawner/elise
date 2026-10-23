import "server-only";

import { serverEnv } from "@/config/server-env";
import type { CapabilityKey } from "@/core/capabilities/types";
import { AppError } from "@/core/errors";
import { connectionHealth, type ConnectionHealth } from "@/core/providers/health";
import type { ConnectionStatus, ProviderKey } from "@/core/providers/types";
import { decrypt, encrypt } from "@/infrastructure/crypto/encryption";
import { logger } from "@/infrastructure/observability/logger";
import { googleOAuthConfig, isGoogleConfigured } from "@/infrastructure/providers/google/config";
import { SupabaseCredentialVault } from "@/infrastructure/providers/google/connection-vault";
import { credentialFromTokens } from "@/infrastructure/providers/google/credentials";
import {
  buildAuthorizationUrl,
  CAPABILITY_SCOPES,
  createPkce,
  createState,
  exchangeCode,
  fetchIdentity,
  GOOGLE_CAPABILITIES,
  grantedCapabilities,
  hashState,
  isGoogleCapability,
  revokeToken,
  scopesFor,
  suggestAlias,
  type GoogleCapability,
} from "@/infrastructure/providers/google/oauth";
import {
  isMicrosoftConfigured,
  microsoftSetup,
  getMicrosoftOAuthConfig,
} from "@/infrastructure/providers/microsoft/config";
import {
  authError as microsoftAuthError,
  buildAuthorizationUrl as buildMicrosoftAuthorizationUrl,
  CAPABILITY_SCOPES as MICROSOFT_CAPABILITY_SCOPES,
  exchangeCode as exchangeMicrosoftCode,
  fetchIdentity as fetchMicrosoftIdentity,
  grantedCapabilities as microsoftGrantedCapabilities,
  MICROSOFT_CAPABILITIES,
  microsoftAuthReason,
  scopesFor as microsoftScopesFor,
  suggestAlias as suggestMicrosoftAlias,
  type MicrosoftCapability,
} from "@/infrastructure/providers/microsoft/oauth";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  isNotionConfigured,
  notionOAuthConfig,
} from "@/infrastructure/providers/notion/oauth";
import {
  getSlackOAuthConfig,
  isSlackConfigured,
  slackSetup,
} from "@/infrastructure/providers/slack/config";
import {
  buildAuthorizationUrl as buildSlackAuthorizationUrl,
  exchangeCode as exchangeSlackCode,
  fetchIdentity as fetchSlackIdentity,
  grantedPermissions as slackGrantedPermissions,
  isSlackPermission,
  revokeToken as revokeSlackToken,
  scopesFor as slackScopesFor,
  SLACK_PERMISSION_KEYS,
  slackAuthError,
  type SlackPermission,
} from "@/infrastructure/providers/slack/oauth";
import { SpotifyTokenProvider } from "@/infrastructure/providers/spotify/music";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  fetchSpotifyProfile,
  isSpotifyConfigured,
  spotifyOAuthConfig,
} from "@/infrastructure/providers/spotify/oauth";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";
import { purgeConnectionFinance } from "./finance-sources";
import { purgeConnectionKnowledge } from "./knowledge-service";
import { disconnectTuya, tuyaAvailability } from "./tuya-connection-service";

// ── Pure rules (tested in isolation) ─────────────────────────────────────────

export interface PendingAuthorization {
  user_id: string;
  workspace_id: string;
  provider_key: string;
  expires_at: string;
}

/** A callback may only complete an authorization the same user started, in the same workspace, recently. */
export function validatePendingAuthorization(
  row: PendingAuthorization | null,
  expected: { userId: string; workspaceId: string; providerKey: ProviderKey; now: Date },
): void {
  if (!row) {
    throw new AppError(
      "CONFLICT",
      "This connection link expired or was already used. Start again.",
      { recovery: "retry" },
    );
  }
  if (
    row.user_id !== expected.userId ||
    row.workspace_id !== expected.workspaceId ||
    row.provider_key !== expected.providerKey
  ) {
    throw new AppError("PERMISSION_DENIED", "This connection link belongs to another session");
  }
  if (new Date(row.expires_at) <= expected.now) {
    throw new AppError("CONFLICT", "This connection link expired. Start again.", {
      recovery: "retry",
    });
  }
}

export function parseRequestedCapabilities(values: readonly string[]): GoogleCapability[] {
  const caps = [...new Set(values)].filter(isGoogleCapability);
  if (caps.length === 0)
    throw new AppError(
      "VALIDATION_ERROR",
      "Choose at least one of Calendar, Tasks, Email, Drive or Sheets",
    );
  return caps;
}

/**
 * Incremental authorization: capabilities touched by this grant and their new state. Asking
 * for Gmail on an account that already has Calendar + Tasks keeps them (Google returns every
 * scope granted so far with include_granted_scopes); a capability is enabled only if all of
 * its scopes were granted. Capabilities neither requested nor enabled before are left alone.
 */
export function planCapabilityGrants(params: {
  requested: readonly GoogleCapability[];
  granted: readonly GoogleCapability[];
  wasEnabled: ReadonlySet<string>;
}): { capability: GoogleCapability; enabled: boolean; scopes: string[] }[] {
  return GOOGLE_CAPABILITIES.filter(
    (c) => params.requested.includes(c) || params.wasEnabled.has(c),
  ).map((capability) => {
    const granted = params.granted.includes(capability);
    return {
      capability,
      enabled: granted,
      scopes: granted ? [...CAPABILITY_SCOPES[capability]] : [],
    };
  });
}

// ── Start ────────────────────────────────────────────────────────────────────

/** Where an OAuth flow may land afterwards: only these pages (no open redirects). */
const RETURN_PATHS = ["/connections", "/onboarding"] as const;
export type ReturnPath = (typeof RETURN_PATHS)[number];

export function safeReturnPath(value: unknown): ReturnPath {
  return (RETURN_PATHS as readonly unknown[]).includes(value)
    ? (value as ReturnPath)
    : "/connections";
}

/**
 * Starts Google authorization for the chosen capabilities only (progressive scopes). With
 * `connectionId` it reconnects or extends that exact account (incremental authorization).
 */
export async function startGoogleConnection(
  auth: AuthContext,
  params: {
    capabilities: readonly string[];
    connectionId?: string | null;
    origin: string;
    returnPath?: string | null;
  },
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  const capabilities = parseRequestedCapabilities(params.capabilities);
  const config = googleOAuthConfig(params.origin);

  let loginHint: string | null = null;
  if (params.connectionId) {
    const { data } = await auth.db
      .from("provider_connections")
      .select("id, account_label")
      .eq("id", params.connectionId)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "google")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Connection not found");
    loginHint = data.account_label;
  }

  const pkce = createPkce();
  const { state, hash } = createState();
  await auth.db
    .from("oauth_states")
    .delete()
    .eq("user_id", auth.userId)
    .lt("expires_at", new Date().toISOString());
  const { error } = await auth.db.from("oauth_states").insert({
    state_hash: hash,
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    provider_key: "google",
    capabilities,
    connection_id: params.connectionId ?? null,
    return_path: safeReturnPath(params.returnPath),
    code_verifier_ciphertext: encrypt(pkce.verifier, `oauth_state:${hash}`),
  });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });

  return buildAuthorizationUrl(config, {
    scopes: scopesFor(capabilities),
    state,
    codeChallenge: pkce.challenge,
    loginHint,
  });
}

// ── Complete (OAuth callback) ────────────────────────────────────────────────

export interface ConnectionResult {
  connectionId: string;
  enabled: CapabilityKey[];
  /** Requested but not granted on the provider's consent screen. */
  missing: CapabilityKey[];
}

export async function completeGoogleConnection(
  auth: AuthContext,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    origin: string;
    /** Told where this flow should land as soon as the state is verified (also on failure). */
    onReturnPath?: (path: ReturnPath) => void;
  },
): Promise<ConnectionResult> {
  if (!params.state) throw new AppError("VALIDATION_ERROR", "Missing authorization state");
  const stateHash = hashState(params.state);

  // Consume the pending authorization exactly once (delete … returning), scoped to this user.
  const { data: pending, error: consumeError } = await auth.db
    .from("oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .select("*")
    .maybeSingle();
  if (consumeError)
    throw new AppError("INTERNAL_ERROR", "Could not verify the connection", {
      cause: consumeError,
    });
  validatePendingAuthorization(pending, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    providerKey: "google",
    now: new Date(),
  });
  params.onReturnPath?.(safeReturnPath(pending!.return_path));
  const row = pending!;

  if (params.error || !params.code) {
    throw new AppError("PERMISSION_DENIED", "Google access was not granted", { recovery: "retry" });
  }

  const config = googleOAuthConfig(params.origin);
  const verifier = decrypt(row.code_verifier_ciphertext, `oauth_state:${stateHash}`);
  const tokens = await exchangeCode(config, { code: params.code, codeVerifier: verifier });
  const identity = await fetchIdentity(tokens.accessToken);
  const requested = row.capabilities.filter(isGoogleCapability);
  const granted = grantedCapabilities(tokens.scopes);

  const admin = createAdminClient();

  // Which connection does this authorization belong to?
  let connectionId: string | null = null;
  if (row.connection_id) {
    const { data: existing } = await auth.db
      .from("provider_connections")
      .select("id, external_account_id")
      .eq("id", row.connection_id)
      .eq("workspace_id", auth.workspaceId)
      .maybeSingle();
    if (!existing) throw new AppError("NOT_FOUND", "Connection not found");
    if (existing.external_account_id !== identity.sub) {
      await revokeToken(tokens.refreshToken ?? tokens.accessToken);
      throw new AppError(
        "CONFLICT",
        "You chose a different Google account than this connection. Add it as a new connection instead.",
        {
          recovery: "review",
        },
      );
    }
    connectionId = existing.id;
  } else {
    const { data: sameAccount } = await auth.db
      .from("provider_connections")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "google")
      .eq("external_account_id", identity.sub)
      .maybeSingle();
    connectionId = sameAccount?.id ?? null;
  }

  const now = new Date().toISOString();
  if (connectionId) {
    const { error } = await admin
      .from("provider_connections")
      .update({
        status: "connected",
        account_label: identity.email,
        last_connected_at: now,
        last_error_code: null,
        last_error_at: null,
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not update the connection", { cause: error });
  } else {
    const { data: created, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "google",
        created_by_user_id: auth.userId,
        external_account_id: identity.sub,
        display_name: await uniqueAlias(auth, suggestAlias(identity.email), identity.email),
        account_label: identity.email,
        status: "connected",
        auth_metadata: { name: identity.name },
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = created.id;
  }

  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(admin, "google");
  await vault.write(ref, credentialFromTokens(tokens, await vault.read(ref)));

  // Capability grants are stored per capability, separately from the account.
  const { data: currentCaps } = await auth.db
    .from("connection_capabilities")
    .select("capability_key, enabled")
    .eq("connection_id", connectionId);
  const wasEnabled = new Set(
    (currentCaps ?? []).filter((c) => c.enabled).map((c) => c.capability_key),
  );
  const plan = planCapabilityGrants({ requested, granted, wasEnabled });
  const enabled = plan.filter((p) => p.enabled).map((p) => p.capability);

  for (const p of plan) {
    await auth.db.from("connection_capabilities").upsert(
      {
        workspace_id: auth.workspaceId,
        connection_id: connectionId,
        capability_key: p.capability,
        enabled: p.enabled,
        // Sheets are read-only in ELISE: Finance never writes back to a spreadsheet.
        permission_level: p.capability === "finance" ? "read" : "write",
        authorized_scopes: p.scopes,
      },
      { onConflict: "connection_id,capability_key" },
    );
    if (p.enabled) await ensureBinding(auth, connectionId, p.capability);
  }

  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: row.connection_id ? "connection.reauthorized" : "connection.created",
    resource_type: "provider_connection",
    resource_id: connectionId,
    provider_key: "google",
    connection_id: connectionId,
    origin: "user_ui",
    result: "success",
    metadata: { capabilities: enabled },
  });
  logger.info("connection.google_connected", {
    connection_id: connectionId,
    capabilities: enabled,
  });

  return { connectionId, enabled, missing: requested.filter((c) => !granted.includes(c)) };
}

// ── Microsoft (ADR-058) ──────────────────────────────────────────────────────

/**
 * Starts Microsoft consent (Outlook Mail). With `connectionId` it reconnects that exact
 * account. Same pending-authorization row and PKCE as Google.
 */
export async function startMicrosoftConnection(
  auth: AuthContext,
  params: { connectionId?: string | null; origin: string; returnPath?: string | null },
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  // Names and booleans only (never values), so a production failure is diagnosable from logs.
  const setup = microsoftSetup();
  logger.info("microsoft.oauth.start", {
    configured: setup.ready,
    ...(setup.ready
      ? { tenantMode: setup.tenantMode }
      : { missing: setup.missing, vaultMissing: setup.vaultMissing }),
    environment: serverEnv().VERCEL_ENV ?? serverEnv().ELISE_ENV,
  });
  const config = getMicrosoftOAuthConfig(params.origin);
  let loginHint: string | null = null;
  if (params.connectionId) {
    const { data } = await auth.db
      .from("provider_connections")
      .select("id, account_label")
      .eq("id", params.connectionId)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "microsoft")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Connection not found");
    loginHint = data.account_label;
  }
  const capabilities = [...MICROSOFT_CAPABILITIES];
  const pkce = createPkce();
  const { state, hash } = createState();
  await auth.db
    .from("oauth_states")
    .delete()
    .eq("user_id", auth.userId)
    .lt("expires_at", new Date().toISOString());
  const { error } = await auth.db.from("oauth_states").insert({
    state_hash: hash,
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    provider_key: "microsoft",
    capabilities,
    connection_id: params.connectionId ?? null,
    return_path: safeReturnPath(params.returnPath),
    code_verifier_ciphertext: encrypt(pkce.verifier, `oauth_state:${hash}`),
  });
  // 23503: the "microsoft" provider row (migration 045) isn't in this database yet.
  if (error?.code === "23503")
    throw new AppError("SERVER_NOT_CONFIGURED", "This needs the latest ELISE database update", {
      recovery: "configure",
      cause: error,
      details: { setup: "database_update", missing: ["migration 20261026000045"] },
    });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });
  return buildMicrosoftAuthorizationUrl(config, {
    scopes: microsoftScopesFor(capabilities),
    state,
    codeChallenge: pkce.challenge,
    loginHint,
  });
}

/**
 * Microsoft's callback. The account key is the Graph user id (stable), never the address;
 * reconnecting must pick the same account. Several Microsoft accounts can live side by side.
 */
export async function completeMicrosoftConnection(
  auth: AuthContext,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    errorDescription?: string | null;
    origin: string;
    onReturnPath?: (path: ReturnPath) => void;
  },
): Promise<ConnectionResult> {
  if (!params.state) throw new AppError("VALIDATION_ERROR", "Missing authorization state");
  const stateHash = hashState(params.state);
  const { data: pending, error: consumeError } = await auth.db
    .from("oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .select("*")
    .maybeSingle();
  if (consumeError)
    throw new AppError("INTERNAL_ERROR", "Could not verify the connection", {
      cause: consumeError,
    });
  validatePendingAuthorization(pending, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    providerKey: "microsoft",
    now: new Date(),
  });
  params.onReturnPath?.(safeReturnPath(pending!.return_path));
  const row = pending!;

  if (params.error || !params.code) {
    // Cancelled, admin approval required, consent declined…: a precise reason, never raw text.
    const reason = microsoftAuthReason({
      error: params.error ?? "access_denied",
      description: params.errorDescription,
    });
    throw microsoftAuthError(reason === "unknown" ? "cancelled" : reason);
  }

  const config = getMicrosoftOAuthConfig(params.origin);
  const verifier = decrypt(row.code_verifier_ciphertext, `oauth_state:${stateHash}`);
  const requested = row.capabilities.filter((c): c is MicrosoftCapability =>
    (MICROSOFT_CAPABILITIES as string[]).includes(c),
  );
  const tokens = await exchangeMicrosoftCode(config, {
    code: params.code,
    codeVerifier: verifier,
    scopes: microsoftScopesFor(requested),
  });
  if (!tokens.refreshToken)
    throw new AppError("PERMISSION_DENIED", "Microsoft did not grant lasting access", {
      recovery: "retry",
    });
  const identity = await fetchMicrosoftIdentity(tokens.accessToken);
  const granted = microsoftGrantedCapabilities(tokens.scopes);

  let connectionId: string | null = null;
  if (row.connection_id) {
    const { data: existing } = await auth.db
      .from("provider_connections")
      .select("id, external_account_id")
      .eq("id", row.connection_id)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "microsoft")
      .maybeSingle();
    if (!existing) throw new AppError("NOT_FOUND", "Connection not found");
    if (existing.external_account_id !== identity.id)
      throw new AppError(
        "CONFLICT",
        "You chose a different Microsoft account than this connection. Add it as a new connection instead.",
        { recovery: "review" },
      );
    connectionId = existing.id;
  } else {
    const { data: sameAccount } = await auth.db
      .from("provider_connections")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "microsoft")
      .eq("external_account_id", identity.id)
      .maybeSingle();
    connectionId = sameAccount?.id ?? null;
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();
  if (connectionId) {
    const { error } = await admin
      .from("provider_connections")
      .update({
        status: "connected",
        account_label: identity.email,
        last_connected_at: now,
        last_error_code: null,
        last_error_at: null,
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not update the connection", { cause: error });
  } else {
    const { data: created, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "microsoft",
        created_by_user_id: auth.userId,
        external_account_id: identity.id,
        display_name: await uniqueAlias(
          auth,
          suggestMicrosoftAlias(identity.email),
          identity.email,
        ),
        account_label: identity.email,
        status: "connected",
        auth_metadata: { name: identity.name },
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = created.id;
  }

  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(admin, "microsoft");
  await vault.write(ref, credentialFromTokens(tokens, await vault.read(ref)));

  const enabled: MicrosoftCapability[] = [];
  for (const capability of requested) {
    const ok = granted.includes(capability);
    await auth.db.from("connection_capabilities").upsert(
      {
        workspace_id: auth.workspaceId,
        connection_id: connectionId,
        capability_key: capability,
        enabled: ok,
        permission_level: "write",
        authorized_scopes: ok ? [...MICROSOFT_CAPABILITY_SCOPES[capability]] : [],
      },
      { onConflict: "connection_id,capability_key" },
    );
    if (ok) {
      enabled.push(capability);
      await ensureBinding(auth, connectionId, capability);
    }
  }

  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: row.connection_id ? "connection.reauthorized" : "connection.created",
    resource_type: "provider_connection",
    resource_id: connectionId,
    provider_key: "microsoft",
    connection_id: connectionId,
    origin: "user_ui",
    result: "success",
    metadata: { capabilities: enabled },
  });
  logger.info("connection.microsoft_connected", {
    connection_id: connectionId,
    capabilities: enabled,
  });
  return { connectionId, enabled, missing: requested.filter((c) => !granted.includes(c)) };
}

// ── Slack (ADR-062) ──────────────────────────────────────────────────────────

/** What the Connections card shows of a Slack connection (no tokens; names and booleans). */
export interface SlackConnectionDetails {
  team: string | null;
  icon: string | null;
  user: string | null;
  permissions: { key: SlackPermission; granted: boolean }[];
}

/**
 * Starts Slack consent for the chosen permissions (public channels always). With `connectionId`
 * it extends or reconnects that exact workspace connection (progressive authorization): Slack
 * adds the new scopes to the same grant, so it never becomes a second connection.
 */
export async function startSlackConnection(
  auth: AuthContext,
  params: {
    permissions: readonly string[];
    connectionId?: string | null;
    origin: string;
    returnPath?: string | null;
  },
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  const setup = slackSetup();
  logger.info("slack.oauth.start", {
    configured: setup.ready,
    ...(setup.ready
      ? { unlisted: setup.unlisted }
      : { missing: setup.missing, vaultMissing: setup.vaultMissing }),
  });
  const config = getSlackOAuthConfig(params.origin);
  const wanted = new Set(params.permissions.filter(isSlackPermission));
  let team: string | null = null;
  if (params.connectionId) {
    const { data } = await auth.db
      .from("provider_connections")
      .select("id, auth_metadata")
      .eq("id", params.connectionId)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "slack")
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Connection not found");
    team = slackMeta(data.auth_metadata).teamId;
    // Reconnecting asks again for everything this connection already had.
    const { data: cap } = await auth.db
      .from("connection_capabilities")
      .select("authorized_scopes")
      .eq("connection_id", data.id)
      .eq("capability_key", "team_messaging")
      .maybeSingle();
    for (const k of slackGrantedPermissions(cap?.authorized_scopes ?? [])) wanted.add(k);
  }
  const permissions = SLACK_PERMISSION_KEYS.filter((k) => k === "public" || wanted.has(k));
  const { state, hash } = createState();
  await auth.db
    .from("oauth_states")
    .delete()
    .eq("user_id", auth.userId)
    .lt("expires_at", new Date().toISOString());
  const { error } = await auth.db.from("oauth_states").insert({
    state_hash: hash,
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    provider_key: "slack",
    capabilities: permissions,
    connection_id: params.connectionId ?? null,
    return_path: safeReturnPath(params.returnPath),
    // Slack's flow uses the client secret server-side, no PKCE: an encrypted placeholder.
    code_verifier_ciphertext: encrypt("none", `oauth_state:${hash}`),
  });
  // 23503: the "slack" provider row (migration 046) isn't in this database yet.
  if (error?.code === "23503")
    throw new AppError("SERVER_NOT_CONFIGURED", "This needs the latest ELISE database update", {
      recovery: "configure",
      cause: error,
      details: { setup: "database_update", missing: ["migration 20261027000046"] },
    });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });
  return buildSlackAuthorizationUrl(config, {
    userScopes: slackScopesFor(permissions, setup.unlisted),
    state,
    team,
  });
}

interface SlackMeta {
  teamId: string | null;
  teamName: string | null;
  teamIcon: string | null;
  userName: string | null;
}

function slackMeta(raw: unknown): SlackMeta {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  return {
    teamId: str("teamId"),
    teamName: str("teamName"),
    teamIcon: str("teamIcon"),
    userName: str("userName"),
  };
}

/**
 * Slack's callback. A connection is one user in one workspace (team id + user id): the same pair
 * reconnecting updates it; another workspace — or another user of the same workspace — is a new
 * connection. Tokens go straight into the encrypted vault; the browser never sees them.
 */
export async function completeSlackConnection(
  auth: AuthContext,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    origin: string;
    onReturnPath?: (path: ReturnPath) => void;
  },
  deps: {
    exchange?: typeof exchangeSlackCode;
    identity?: typeof fetchSlackIdentity;
    revoke?: typeof revokeSlackToken;
  } = {},
): Promise<ConnectionResult> {
  if (!params.state) throw new AppError("VALIDATION_ERROR", "Missing authorization state");
  const stateHash = hashState(params.state);
  const { data: pending, error: consumeError } = await auth.db
    .from("oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .select("*")
    .maybeSingle();
  if (consumeError)
    throw new AppError("INTERNAL_ERROR", "Could not verify the connection", {
      cause: consumeError,
    });
  validatePendingAuthorization(pending, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    providerKey: "slack",
    now: new Date(),
  });
  params.onReturnPath?.(safeReturnPath(pending!.return_path));
  const row = pending!;
  if (params.error || !params.code) throw slackAuthError(params.error ?? "access_denied");

  const config = getSlackOAuthConfig(params.origin);
  const grant = await (deps.exchange ?? exchangeSlackCode)(config, params.code);
  const external = `${grant.teamId}:${grant.userId}`;

  let connectionId: string | null = null;
  if (row.connection_id) {
    const { data: existing } = await auth.db
      .from("provider_connections")
      .select("id, external_account_id")
      .eq("id", row.connection_id)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "slack")
      .maybeSingle();
    if (!existing) throw new AppError("NOT_FOUND", "Connection not found");
    if (existing.external_account_id !== external) {
      // Never let another workspace or user replace this connection's grant.
      await (deps.revoke ?? revokeSlackToken)(grant.tokens.accessToken);
      throw new AppError(
        "CONFLICT",
        "You chose a different Slack workspace or user than this connection. Add it as a new connection instead.",
        { recovery: "review" },
      );
    }
    connectionId = existing.id;
  } else {
    const { data: same } = await auth.db
      .from("provider_connections")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "slack")
      .eq("external_account_id", external)
      .maybeSingle();
    connectionId = same?.id ?? null;
  }

  const identity = await (deps.identity ?? fetchSlackIdentity)(grant.tokens.accessToken, grant);
  const teamName = identity.teamName ?? grant.teamName ?? "Slack";
  const metadata = {
    teamId: grant.teamId,
    teamName,
    teamDomain: identity.teamDomain,
    teamIcon: identity.teamIcon,
    enterpriseId: grant.enterpriseId,
    enterpriseName: grant.enterpriseName,
    userId: grant.userId,
    userName: identity.userName,
    handle: identity.handle,
    tokenRotation: grant.rotating,
  };
  const accountLabel = `${identity.userName} · ${teamName}`;
  const admin = createAdminClient();
  if (connectionId) {
    const { error } = await admin
      .from("provider_connections")
      .update({
        status: "connected",
        account_label: accountLabel,
        auth_metadata: metadata,
        last_connected_at: new Date().toISOString(),
        last_error_code: null,
        last_error_at: null,
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not update the connection", { cause: error });
  } else {
    const { data: created, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "slack",
        created_by_user_id: auth.userId,
        external_account_id: external,
        display_name: await uniqueAlias(auth, teamName, `${teamName} (${identity.userName})`),
        account_label: accountLabel,
        status: "connected",
        auth_metadata: metadata,
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = created.id;
  }

  // Slack accumulates scopes across consents: keep every scope this grant has.
  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(admin, "slack");
  const previous = await vault.read(ref);
  const scopes = [...new Set([...(previous?.scopes ?? []), ...grant.tokens.scopes])];
  await vault.write(ref, { ...credentialFromTokens(grant.tokens, previous), scopes });

  const granted = slackGrantedPermissions(scopes);
  const usable = granted.includes("public");
  await auth.db.from("connection_capabilities").upsert(
    {
      workspace_id: auth.workspaceId,
      connection_id: connectionId,
      capability_key: "team_messaging",
      enabled: usable,
      permission_level: "write",
      authorized_scopes: usable ? scopes : [],
    },
    { onConflict: "connection_id,capability_key" },
  );
  if (usable) await ensureBinding(auth, connectionId, "team_messaging");

  const requested = row.capabilities.filter(isSlackPermission);
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: row.connection_id || previous ? "connection.reauthorized" : "connection.created",
    resource_type: "provider_connection",
    resource_id: connectionId,
    provider_key: "slack",
    connection_id: connectionId,
    origin: "user_ui",
    result: "success",
    metadata: { permissions: granted, tokenRotation: grant.rotating },
  });
  logger.info("connection.slack_connected", {
    connection_id: connectionId,
    permissions: granted,
    token_rotation: grant.rotating,
  });
  return {
    connectionId,
    enabled: usable ? ["team_messaging"] : [],
    missing: usable && requested.every((r) => granted.includes(r)) ? [] : ["team_messaging"],
  };
}

/** First account for a capability becomes its default; ELISE Tasks stays default for tasks. */
async function ensureBinding(auth: AuthContext, connectionId: string, capability: CapabilityKey) {
  const { data: bindings } = await auth.db
    .from("capability_bindings")
    .select("id, connection_id, is_default, context_type")
    .eq("workspace_id", auth.workspaceId)
    .eq("capability_key", capability);
  const own = (bindings ?? []).find(
    (b) => b.connection_id === connectionId && b.context_type === null,
  );
  if (own) {
    await auth.db.from("capability_bindings").update({ enabled: true }).eq("id", own.id);
    return;
  }
  const hasDefault = (bindings ?? []).some((b) => b.is_default && b.context_type === null);
  await auth.db.from("capability_bindings").insert({
    workspace_id: auth.workspaceId,
    capability_key: capability,
    connection_id: connectionId,
    is_default: !hasDefault,
  });
}

async function uniqueAlias(auth: AuthContext, alias: string, email: string): Promise<string> {
  const { data } = await auth.db
    .from("provider_connections")
    .select("display_name")
    .eq("workspace_id", auth.workspaceId)
    .neq("status", "disconnected");
  const taken = new Set((data ?? []).map((c) => c.display_name.toLowerCase()));
  return taken.has(alias.toLowerCase()) ? email : alias;
}

// ── Management ───────────────────────────────────────────────────────────────

export interface ConnectionView {
  id: string;
  providerKey: ProviderKey;
  displayName: string;
  accountLabel: string | null;
  contextLabel: string | null;
  status: ConnectionStatus;
  /** Product-level health with one obvious remedy (core/providers/health.ts). */
  health: ConnectionHealth;
  capabilities: { key: CapabilityKey; enabled: boolean; granted: boolean; isDefault: boolean }[];
  /** Slack only: the workspace, who connected and which permissions the grant has. */
  slack?: SlackConnectionDetails;
}

export async function listConnections(auth: AuthContext): Promise<{
  connections: ConnectionView[];
  googleAvailable: boolean;
  microsoftAvailable: boolean;
  notionAvailable: boolean;
  spotifyAvailable: boolean;
  youtubeAvailable: boolean;
  slackAvailable: boolean;
}> {
  const [conns, caps, bindings] = await Promise.all([
    auth.db
      .from("provider_connections")
      .select(
        "id, provider_key, display_name, account_label, context_label, status, last_error_code, auth_metadata",
      )
      .eq("workspace_id", auth.workspaceId)
      .neq("status", "disconnected")
      .order("created_at"),
    auth.db
      .from("connection_capabilities")
      .select("connection_id, capability_key, enabled, authorized_scopes")
      .eq("workspace_id", auth.workspaceId),
    auth.db
      .from("capability_bindings")
      .select("connection_id, capability_key, is_default, context_type")
      .eq("workspace_id", auth.workspaceId),
  ]);
  const available: Partial<Record<string, boolean>> = {
    google: isGoogleConfigured(),
    microsoft: isMicrosoftConfigured(),
    notion: isNotionConfigured(),
    spotify: isSpotifyConfigured(),
    youtube: isYouTubeConfigured(),
    slack: isSlackConfigured(),
  };
  const connections = (conns.data ?? []).map((c): ConnectionView => {
    const capabilities = (caps.data ?? [])
      .filter((cap) => cap.connection_id === c.id)
      .map((cap) => ({
        key: cap.capability_key as CapabilityKey,
        enabled: cap.enabled,
        granted: c.provider_key === "elise_native" || cap.authorized_scopes.length > 0,
        isDefault: (bindings.data ?? []).some(
          (b) =>
            b.connection_id === c.id &&
            b.capability_key === cap.capability_key &&
            b.is_default &&
            b.context_type === null,
        ),
      }));
    return {
      id: c.id,
      providerKey: c.provider_key as ProviderKey,
      displayName: c.display_name,
      accountLabel: c.account_label,
      contextLabel: c.context_label,
      status: c.status,
      health: connectionHealth({
        status: c.status,
        providerAvailable: available[c.provider_key] ?? true,
        lastErrorCode: c.last_error_code,
        capabilities,
      }),
      capabilities,
      ...(c.provider_key === "slack"
        ? { slack: slackDetails(c.auth_metadata, caps.data ?? [], c.id) }
        : {}),
    };
  });
  return {
    connections,
    googleAvailable: available.google ?? false,
    microsoftAvailable: available.microsoft ?? false,
    notionAvailable: available.notion ?? false,
    spotifyAvailable: available.spotify ?? false,
    youtubeAvailable: available.youtube ?? false,
    slackAvailable: available.slack ?? false,
  };
}

function slackDetails(
  metadata: unknown,
  caps: { connection_id: string; capability_key: string; authorized_scopes: string[] }[],
  connectionId: string,
): SlackConnectionDetails {
  const m = slackMeta(metadata);
  const scopes =
    caps.find((x) => x.connection_id === connectionId && x.capability_key === "team_messaging")
      ?.authorized_scopes ?? [];
  const granted = new Set(slackGrantedPermissions(scopes));
  return {
    team: m.teamName,
    icon: m.teamIcon?.startsWith("https://") ? m.teamIcon : null,
    user: m.userName,
    permissions: SLACK_PERMISSION_KEYS.map((key) => ({ key, granted: granted.has(key) })),
  };
}

async function ownConnection(auth: AuthContext, connectionId: string) {
  const { data } = await auth.db
    .from("provider_connections")
    .select("id, provider_key, display_name, status")
    .eq("id", connectionId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Connection not found");
  return data;
}

export async function renameConnection(
  auth: AuthContext,
  connectionId: string,
  values: { displayName: string; contextLabel: string | null },
): Promise<void> {
  await ownConnection(auth, connectionId);
  const { error } = await auth.db
    .from("provider_connections")
    .update({ display_name: values.displayName, context_label: values.contextLabel })
    .eq("id", connectionId)
    .eq("workspace_id", auth.workspaceId);
  if (error)
    throw new AppError("VALIDATION_ERROR", "Could not rename the connection", { cause: error });
}

/** Enabling a capability ELISE has no grant for yet is done through startGoogleConnection. */
export async function setCapabilityEnabled(
  auth: AuthContext,
  connectionId: string,
  capability: CapabilityKey,
  enabled: boolean,
): Promise<void> {
  await ownConnection(auth, connectionId);
  const { data } = await auth.db
    .from("connection_capabilities")
    .update({ enabled })
    .eq("connection_id", connectionId)
    .eq("capability_key", capability)
    .select("authorized_scopes")
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "That capability is not set up for this connection");
  await auth.db
    .from("capability_bindings")
    .update({ enabled })
    .eq("connection_id", connectionId)
    .eq("capability_key", capability);
  await audit(auth, connectionId, "permission.changed", { capability, enabled });
}

export async function setDefaultConnection(
  auth: AuthContext,
  connectionId: string,
  capability: CapabilityKey,
): Promise<void> {
  const connection = await ownConnection(auth, connectionId);
  if (capability === "finance" && connection.provider_key !== "elise_native") {
    // Connected sheets are read-only: new records always go to ELISE Finance.
    throw new AppError("VALIDATION_ERROR", "Google Sheets can't be the default for new records", {
      recovery: "review",
    });
  }
  // One default per capability (enforced by a unique index): clear, then set.
  await auth.db
    .from("capability_bindings")
    .update({ is_default: false })
    .eq("workspace_id", auth.workspaceId)
    .eq("capability_key", capability)
    .is("context_type", null);
  const { data } = await auth.db
    .from("capability_bindings")
    .update({ is_default: true })
    .eq("connection_id", connectionId)
    .eq("capability_key", capability)
    .is("context_type", null)
    .select("id")
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "That capability is not set up for this connection");
  await audit(auth, connectionId, "binding.default_changed", { capability });
}

/**
 * Disconnect: revoke at Google (best effort), delete local credentials, disable every binding
 * and cancel approvals that would write through it. It never switches writes to another account.
 */
export async function disconnectConnection(auth: AuthContext, connectionId: string): Promise<void> {
  const connection = await ownConnection(auth, connectionId);
  if (connection.provider_key === "elise_native")
    throw new AppError("VALIDATION_ERROR", "ELISE is built in and cannot be disconnected");
  // ADR-119: a Smart Life account also takes its devices out of the home.
  if (connection.provider_key === "tuya") return disconnectTuya(auth, connectionId);

  const ref = { connectionId, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(createAdminClient(), connection.provider_key);
  const credential = await vault.read(ref).catch(() => null);
  // Microsoft, Notion and Spotify have no token revocation endpoint: deleting the credential ends ELISE's
  // access here, and the user can remove the app in the provider's settings.
  const revoked = !credential
    ? false
    : connection.provider_key === "google"
      ? await revokeToken(credential.refreshToken ?? credential.accessToken)
      : connection.provider_key === "slack"
        ? await revokeSlackToken(credential.accessToken)
        : false;
  await vault.remove(ref);
  // Sync stops now, and what ELISE indexed through this account is deleted.
  await purgeConnectionKnowledge(auth.workspaceId, connectionId);
  await purgeConnectionFinance(auth.workspaceId, connectionId);
  // Mapped databases stay mapped (reconnecting resumes them) but stop working now.
  await createAdminClient()
    .from("structured_sources")
    .update({ status: "paused" })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", connectionId)
    .is("archived_at", null);

  const now = new Date().toISOString();
  await Promise.all([
    auth.db
      .from("provider_connections")
      .update({ status: "disconnected", disconnected_at: now })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId),
    auth.db
      .from("capability_bindings")
      .update({ enabled: false, is_default: false })
      .eq("connection_id", connectionId),
    auth.db
      .from("connection_capabilities")
      .update({ enabled: false })
      .eq("connection_id", connectionId),
    auth.db
      .from("approvals")
      .update({ status: "cancelled", resolved_at: now })
      .eq("connection_id", connectionId)
      .eq("status", "pending"),
  ]);
  await audit(auth, connectionId, "connection.disconnected", { revokedAtProvider: revoked });
}

async function audit(
  auth: AuthContext,
  connectionId: string,
  eventType: string,
  metadata: Record<string, unknown>,
) {
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: eventType,
    resource_type: "provider_connection",
    resource_id: connectionId,
    connection_id: connectionId,
    origin: "user_ui",
    result: "success",
    metadata: JSON.parse(JSON.stringify(metadata)),
  });
}

// ── Notion ───────────────────────────────────────────────────────────────────

/** Starts Notion's consent. The user picks which pages ELISE may read, in Notion. */
export async function startNotionConnection(
  auth: AuthContext,
  origin: string,
  returnPath?: string | null,
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  const config = notionOAuthConfig(origin);
  const { state, hash } = createState();
  const { error } = await auth.db.from("oauth_states").insert({
    state_hash: hash,
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    provider_key: "notion",
    capabilities: ["knowledge"],
    return_path: safeReturnPath(returnPath),
    // Notion's flow has no PKCE; the column stores an encrypted placeholder.
    code_verifier_ciphertext: encrypt("none", `oauth_state:${hash}`),
  });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });
  return buildNotionAuthorizationUrl(config, state);
}

export async function completeNotionConnection(
  auth: AuthContext,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    origin: string;
    /** Told where this flow should land as soon as the state is verified (also on failure). */
    onReturnPath?: (path: ReturnPath) => void;
  },
): Promise<string> {
  if (!params.state) throw new AppError("VALIDATION_ERROR", "Missing authorization state");
  const stateHash = hashState(params.state);
  const { data: pending } = await auth.db
    .from("oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .select("*")
    .maybeSingle();
  validatePendingAuthorization(pending, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    providerKey: "notion",
    now: new Date(),
  });
  params.onReturnPath?.(safeReturnPath(pending!.return_path));
  if (params.error || !params.code) {
    throw new AppError("PERMISSION_DENIED", "Notion access was not granted", { recovery: "retry" });
  }
  const grant = await exchangeNotionCode(notionOAuthConfig(params.origin), params.code);
  const admin = createAdminClient();

  const { data: existing } = await auth.db
    .from("provider_connections")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "notion")
    .eq("external_account_id", grant.workspaceId)
    .maybeSingle();
  let connectionId = existing?.id ?? null;
  const label = grant.workspaceName ?? "Notion";
  if (connectionId) {
    await admin
      .from("provider_connections")
      .update({
        status: "connected",
        last_connected_at: new Date().toISOString(),
        last_error_code: null,
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
  } else {
    const { data, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "notion",
        created_by_user_id: auth.userId,
        external_account_id: grant.workspaceId,
        display_name: await uniqueAlias(auth, label, `${label} (Notion)`),
        account_label: grant.ownerEmail ?? label,
        status: "connected",
        auth_metadata: { botId: grant.botId, workspaceName: grant.workspaceName },
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = data.id;
  }

  await new SupabaseCredentialVault(admin, "notion").write(
    { connectionId, workspaceId: auth.workspaceId },
    {
      accessToken: grant.accessToken,
      // Notion access tokens do not expire.
      accessTokenExpiresAt: new Date("2999-01-01").toISOString(),
      refreshToken: grant.refreshToken,
      scopes: ["notion:read_content"],
    },
  );
  await auth.db.from("connection_capabilities").upsert(
    [
      {
        workspace_id: auth.workspaceId,
        connection_id: connectionId,
        capability_key: "knowledge",
        enabled: true,
        permission_level: "read",
        authorized_scopes: ["notion:read_content"],
      },
      // Structured Data: databases the user maps. Whether ELISE may insert/update is set by
      // the integration's capabilities in Notion and per database in ELISE.
      {
        workspace_id: auth.workspaceId,
        connection_id: connectionId,
        capability_key: "structured",
        enabled: true,
        permission_level: "write",
        authorized_scopes: [
          "notion:read_content",
          "notion:update_content",
          "notion:insert_content",
        ],
      },
    ],
    { onConflict: "connection_id,capability_key" },
  );
  await ensureBinding(auth, connectionId, "structured");
  // Reconnecting resumes the databases that were mapped through this connection.
  await auth.db
    .from("structured_sources")
    .update({ status: "active", schema_checked_at: null })
    .eq("workspace_id", auth.workspaceId)
    .eq("connection_id", connectionId)
    .eq("status", "paused");
  await audit(auth, connectionId, existing ? "connection.reauthorized" : "connection.created", {
    provider: "notion",
  });
  return connectionId;
}

// ── Music (ADR-042) ──────────────────────────────────────────────────────────

/** Starts Spotify's consent (authorization code + PKCE; the secret stays on the server). */
export async function startSpotifyConnection(
  auth: AuthContext,
  origin: string,
  returnPath?: string | null,
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  const config = spotifyOAuthConfig(origin);
  const { state, hash } = createState();
  const pkce = createPkce();
  const { error } = await auth.db.from("oauth_states").insert({
    state_hash: hash,
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    provider_key: "spotify",
    capabilities: ["music"],
    return_path: safeReturnPath(returnPath),
    code_verifier_ciphertext: encrypt(pkce.verifier, `oauth_state:${hash}`),
  });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });
  return buildSpotifyAuthorizationUrl(config, { state, codeChallenge: pkce.challenge });
}

/** Spotify's callback: one Spotify account per workspace; reconnecting the same one resumes it. */
export async function completeSpotifyConnection(
  auth: AuthContext,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    origin: string;
    onReturnPath?: (path: ReturnPath) => void;
  },
): Promise<string> {
  if (!params.state) throw new AppError("VALIDATION_ERROR", "Missing authorization state");
  const stateHash = hashState(params.state);
  const { data: pending } = await auth.db
    .from("oauth_states")
    .delete()
    .eq("state_hash", stateHash)
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .select("*")
    .maybeSingle();
  validatePendingAuthorization(pending, {
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    providerKey: "spotify",
    now: new Date(),
  });
  params.onReturnPath?.(safeReturnPath(pending!.return_path));
  if (params.error || !params.code)
    throw new AppError("PERMISSION_DENIED", "Spotify access was not granted", {
      recovery: "retry",
    });

  const verifier = decrypt(pending!.code_verifier_ciphertext, `oauth_state:${stateHash}`);
  const tokens = await exchangeSpotifyCode(
    spotifyOAuthConfig(params.origin),
    params.code,
    verifier,
  );
  if (!tokens.refreshToken)
    throw new AppError("PERMISSION_DENIED", "Spotify did not grant lasting access", {
      recovery: "retry",
    });
  const profile = await fetchSpotifyProfile(tokens.accessToken);
  const admin = createAdminClient();

  const { data: current } = await auth.db
    .from("provider_connections")
    .select("id, external_account_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "spotify")
    .neq("status", "disconnected")
    .maybeSingle();
  if (current && current.external_account_id !== profile.id)
    throw new AppError(
      "CONFLICT",
      "Another Spotify account is already connected. Disconnect it first to use this one.",
      { recovery: "review" },
    );
  const { data: same } = current
    ? { data: current }
    : await auth.db
        .from("provider_connections")
        .select("id, external_account_id")
        .eq("workspace_id", auth.workspaceId)
        .eq("provider_key", "spotify")
        .eq("external_account_id", profile.id)
        .maybeSingle();
  const label = profile.name ?? "Spotify";
  let connectionId = same?.id ?? null;
  if (connectionId) {
    await admin
      .from("provider_connections")
      .update({
        status: "connected",
        last_connected_at: new Date().toISOString(),
        last_error_code: null,
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
  } else {
    const { data, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "spotify",
        created_by_user_id: auth.userId,
        external_account_id: profile.id,
        display_name: await uniqueAlias(auth, "Spotify", `Spotify (${label})`),
        account_label: label,
        status: "connected",
        auth_metadata: {},
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = data.id;
  }
  await new SupabaseCredentialVault(admin, "spotify").write(
    { connectionId, workspaceId: auth.workspaceId },
    {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt.toISOString(),
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    },
  );
  await auth.db.from("connection_capabilities").upsert(
    {
      workspace_id: auth.workspaceId,
      connection_id: connectionId,
      capability_key: "music",
      enabled: true,
      permission_level: "write",
      authorized_scopes: tokens.scopes,
    },
    { onConflict: "connection_id,capability_key" },
  );
  await ensureBinding(auth, connectionId, "music");
  await audit(auth, connectionId, same ? "connection.reauthorized" : "connection.created", {
    provider: "spotify",
  });
  return connectionId;
}

export function isYouTubeConfigured(): boolean {
  return Boolean(serverEnv().YOUTUBE_API_KEY);
}

/**
 * YouTube needs no account: search uses ELISE's server key and playback the official embedded
 * player. Turning it on records a connection so Music can resolve to it (and be disconnected).
 */
export async function enableYouTubeMusic(auth: AuthContext): Promise<string> {
  if (!isYouTubeConfigured())
    throw new AppError("SERVER_NOT_CONFIGURED", "YouTube is not configured on this server", {
      recovery: "configure",
    });
  const admin = createAdminClient();
  const external = `youtube:${auth.workspaceId}`;
  const { data: previous } = await auth.db
    .from("provider_connections")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "youtube")
    .eq("external_account_id", external)
    .maybeSingle();
  let connectionId = previous?.id ?? null;
  if (connectionId)
    await admin
      .from("provider_connections")
      .update({ status: "connected", disconnected_at: null, last_error_code: null })
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId);
  else {
    const { data, error } = await admin
      .from("provider_connections")
      .insert({
        workspace_id: auth.workspaceId,
        provider_key: "youtube",
        created_by_user_id: auth.userId,
        external_account_id: external,
        display_name: await uniqueAlias(auth, "YouTube", "YouTube (ELISE)"),
        account_label: null,
        status: "connected",
        auth_metadata: {},
      })
      .select("id")
      .single();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    connectionId = data.id;
  }
  await auth.db.from("connection_capabilities").upsert(
    {
      workspace_id: auth.workspaceId,
      connection_id: connectionId,
      capability_key: "music",
      enabled: true,
      permission_level: "write",
      authorized_scopes: ["youtube:search", "youtube:embedded_player"],
    },
    { onConflict: "connection_id,capability_key" },
  );
  await ensureBinding(auth, connectionId, "music");
  await audit(auth, connectionId, previous ? "connection.reauthorized" : "connection.created", {
    provider: "youtube",
  });
  return connectionId;
}

/**
 * A short-lived Spotify access token for ELISE's own player in this page (the Web Playback SDK
 * needs one in the browser). Never the refresh token; only the signed-in user's own connection.
 */
export async function spotifyPlayerToken(
  auth: AuthContext,
): Promise<{ token: string; expiresAt: string } | null> {
  if (!isSpotifyConfigured()) return null;
  const { data } = await auth.db
    .from("provider_connections")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "spotify")
    .eq("status", "connected")
    .maybeSingle();
  if (!data) return null;
  const ref = { connectionId: data.id, workspaceId: auth.workspaceId };
  const vault = new SupabaseCredentialVault(createAdminClient(), "spotify");
  const token = await new SpotifyTokenProvider(ref, {
    vault,
    config: () => spotifyOAuthConfig(),
    onReauthorizationRequired: async () => undefined,
  }).accessToken();
  const stored = await vault.read(ref);
  return { token, expiresAt: stored?.accessTokenExpiresAt ?? new Date().toISOString() };
}

/** Which providers this server can connect (the Hub shows the rest as not set up yet). */
export function configuredProviders(list: {
  googleAvailable: boolean;
  microsoftAvailable: boolean;
  notionAvailable: boolean;
  spotifyAvailable: boolean;
  youtubeAvailable: boolean;
  slackAvailable: boolean;
}): Record<string, boolean> {
  return {
    slack: list.slackAvailable,
    google: list.googleAvailable,
    microsoft: list.microsoftAvailable,
    notion: list.notionAvailable,
    spotify: list.spotifyAvailable,
    youtube: list.youtubeAvailable,
    // ADR-119: connected from Hogar (the person's own account, Tuya's official page).
    tuya: tuyaAvailability().state === "available",
    elise_native: true,
  };
}
