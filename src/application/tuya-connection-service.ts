import "server-only";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import { isTuyaRegion, TUYA_KEY_PREFIX, TUYA_REGIONS, type TuyaRegion } from "@/core/home/tuya";
import { decrypt, encrypt } from "@/infrastructure/crypto/encryption";
import {
  exchangeTuyaCode,
  forgetTuyaAccount,
  refreshTuyaToken,
  tuyaConfig,
  tuyaEnabled,
  TuyaError,
  type TuyaAuth,
  type TuyaTokens,
} from "@/infrastructure/home/tuya";
import { logger } from "@/infrastructure/observability/logger";
import { SupabaseCredentialVault } from "@/infrastructure/providers/google/connection-vault";
import { createState, hashState } from "@/infrastructure/providers/google/oauth";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";

/**
 * Smart Life / Tuya as each person's own account (ADR-119). The person authorizes on Tuya's
 * official H5 page (their login or the app's QR) — ELISE never sees their password — and the
 * code is exchanged for THEIR token in THEIR data center (`grant_type=2`). Tokens are kept
 * encrypted per connection (connection_secrets), refreshed by one instance at a time (Tuya's
 * refresh token works once), and never reach a browser, Desktop's renderer or a log.
 *
 * The flow is bound three ways: a single-use state row (user, workspace, data center, 10 min),
 * an HttpOnly cookie set by ELISE's own `/go` hop in the browser that will see Tuya's page, and
 * the data center in the callback's path. Tuya's documentation doesn't say whether the H5 page
 * returns `state`: if it does it must match the cookie; if not, the cookie alone identifies the
 * flow.
 */

const PROVIDER = "tuya" as const;
export const TUYA_FLOW_COOKIE = "elise_tuya_oauth";
const HOME_PATH = "/my-elise/home";

const URL_ENV: Record<TuyaRegion, keyof ReturnType<typeof serverEnv>> = {
  us: "TUYA_OAUTH_URL_US",
  "us-e": "TUYA_OAUTH_URL_US_E",
  eu: "TUYA_OAUTH_URL_EU",
  "eu-w": "TUYA_OAUTH_URL_EU_W",
  in: "TUYA_OAUTH_URL_IN",
  sg: "TUYA_OAUTH_URL_SG",
  cn: "TUYA_OAUTH_URL_CN",
};

function oauthUrl(region: TuyaRegion): string | null {
  const v = serverEnv()[URL_ENV[region]];
  return typeof v === "string" ? v : null;
}

export type TuyaAvailability =
  | { state: "off" }
  /** Enabled, but Tuya's authorization for third parties isn't set up yet: honest "not yet". */
  | { state: "unavailable" }
  | { state: "available"; regions: TuyaRegion[] };

export function tuyaAvailability(): TuyaAvailability {
  if (!tuyaEnabled()) return { state: "off" };
  if (!tuyaConfig()) return { state: "unavailable" };
  const regions = TUYA_REGIONS.filter((r) => oauthUrl(r));
  return regions.length ? { state: "available", regions } : { state: "unavailable" };
}

/** ELISE's own hop: the browser that will see Tuya's page carries the flow's cookie. */
export function tuyaGoUrl(origin: string, state: string) {
  const u = new URL("/api/connections/tuya/go", origin);
  u.searchParams.set("s", state);
  return u.toString();
}

/** Starts one person's authorization in one data center (reconnect: that connection). */
export async function startTuyaConnection(
  auth: AuthContext,
  params: { region: unknown; connectionId?: unknown; origin: string },
): Promise<string> {
  rateLimit(`oauth.start:${auth.userId}`, 10, 60_000);
  const availability = tuyaAvailability();
  const region = isTuyaRegion(params.region) ? params.region : null;
  if (availability.state !== "available" || !region || !availability.regions.includes(region))
    throw new AppError("CAPABILITY_UNAVAILABLE", "Smart Life isn't available in that region", {
      recovery: "review",
    });
  const connectionId = params.connectionId ? z.uuid().parse(params.connectionId) : null;
  if (connectionId) {
    const { data } = await auth.db
      .from("provider_connections")
      .select("id")
      .eq("id", connectionId)
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", PROVIDER)
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Connection not found");
  }
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
    provider_key: PROVIDER,
    capabilities: ["home"],
    connection_id: connectionId,
    return_path: HOME_PATH,
    // No PKCE (Tuya documents none): the encrypted slot carries the data center instead.
    code_verifier_ciphertext: encrypt(region, `oauth_state:${hash}`),
  });
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the connection", { cause: error });
  logger.info("tuya_oauth_started", { region });
  return tuyaGoUrl(params.origin, state);
}

/** The `/go` hop: Tuya's official page for that flow's data center, with ELISE's state. */
export async function tuyaAuthorizationUrl(state: string): Promise<string> {
  const row = await pendingFlow(state);
  const region = regionOf(row);
  const base = oauthUrl(region);
  if (!base)
    throw new AppError("CAPABILITY_UNAVAILABLE", "Smart Life isn't available in that region");
  const u = new URL(base);
  u.searchParams.set("state", state);
  return u.toString();
}

const stateSchema = z.string().min(20).max(200);

async function pendingFlow(state: string) {
  const { data } = await createAdminClient()
    .from("oauth_states")
    .select("*")
    .eq("state_hash", hashState(stateSchema.parse(state)))
    .eq("provider_key", PROVIDER)
    .maybeSingle();
  if (!data || new Date(data.expires_at) <= new Date())
    throw new AppError(
      "CONFLICT",
      "This connection link expired or was already used. Start again.",
      {
        recovery: "retry",
      },
    );
  return data;
}

function regionOf(row: { code_verifier_ciphertext: string; state_hash: string }) {
  const region = decrypt(row.code_verifier_ciphertext, `oauth_state:${row.state_hash}`);
  if (!isTuyaRegion(region)) throw new AppError("VALIDATION_ERROR", "Unknown data center");
  return region;
}

export interface TuyaCallbackResult {
  connectionId: string;
  returnPath: string;
}

/**
 * Tuya's callback. The flow is consumed first (a retried or concurrent callback finds nothing:
 * no double exchange), then the code is exchanged in that data center only.
 */
export async function completeTuyaConnection(params: {
  pathRegion: string;
  code: string | null;
  state: string | null;
  cookieState: string | null;
  /** When the browser also has an ELISE session, it must be the same person. */
  sessionUserId: string | null;
}): Promise<TuyaCallbackResult> {
  if (!params.cookieState)
    throw new AppError("PERMISSION_DENIED", "This connection didn't start in this browser", {
      recovery: "retry",
    });
  if (params.state && params.state !== params.cookieState)
    throw new AppError("PERMISSION_DENIED", "This connection link belongs to another session");
  const state = stateSchema.parse(params.cookieState);
  const hash = hashState(state);
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("oauth_states")
    .delete()
    .eq("state_hash", hash)
    .eq("provider_key", PROVIDER)
    .select("*")
    .maybeSingle();
  if (!row || new Date(row.expires_at) <= new Date())
    throw new AppError(
      "CONFLICT",
      "This connection link expired or was already used. Start again.",
      {
        recovery: "retry",
      },
    );
  if (params.sessionUserId && params.sessionUserId !== row.user_id)
    throw new AppError("PERMISSION_DENIED", "This connection link belongs to another session");
  const region = regionOf(row);
  if (params.pathRegion !== region)
    throw new AppError(
      "VALIDATION_ERROR",
      "That authorization came back from another data center",
      {
        recovery: "retry",
        details: { tuyaProblem: "wrong_region" },
      },
    );
  const code = z
    .string()
    .trim()
    .min(4)
    .max(400)
    .safeParse(params.code ?? "");
  if (!code.success)
    throw new AppError("PERMISSION_DENIED", "Smart Life access was not granted", {
      recovery: "retry",
    });
  const tokens = await exchangeTuyaCode(region, code.data);
  const connectionId = await saveConnection(admin, {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    region,
    tokens,
    reconnecting: row.connection_id,
  });
  logger.info("tuya_oauth_connected", { region });
  return { connectionId, returnPath: row.return_path };
}

type Admin = ReturnType<typeof createAdminClient>;

async function saveConnection(
  admin: Admin,
  p: {
    workspaceId: string;
    userId: string;
    region: TuyaRegion;
    tokens: TuyaTokens;
    reconnecting: string | null;
  },
): Promise<string> {
  const external = `${p.region}:${p.tokens.uid}`;
  const { data: existing } = await admin
    .from("provider_connections")
    .select("id, external_account_id")
    .eq("workspace_id", p.workspaceId)
    .eq("provider_key", PROVIDER)
    .eq("external_account_id", external)
    .maybeSingle();
  // Reconnecting must be the same account: another one is a new connection, never a swap.
  if (p.reconnecting && existing && existing.id !== p.reconnecting)
    throw new AppError("CONFLICT", "That's another Smart Life account than the one to reconnect", {
      recovery: "review",
    });
  const now = new Date().toISOString();
  const fields = {
    status: "connected" as const,
    last_connected_at: now,
    last_error_code: null,
    last_error_at: null,
    disconnected_at: null,
    auth_metadata: { region: p.region, uid: p.tokens.uid },
  };
  let id = existing?.id ?? null;
  if (id) {
    const { error } = await admin
      .from("provider_connections")
      .update(fields)
      .eq("id", id)
      .eq("workspace_id", p.workspaceId);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
  } else {
    const { data, error } = await admin
      .from("provider_connections")
      .insert({
        ...fields,
        workspace_id: p.workspaceId,
        provider_key: PROVIDER,
        created_by_user_id: p.userId,
        external_account_id: external,
        display_name: "Smart Life",
        account_label: `Smart Life · ${p.region.toUpperCase()}`,
      })
      .select("id")
      .single();
    if (error || !data)
      throw new AppError("INTERNAL_ERROR", "Could not save the connection", { cause: error });
    id = data.id;
  }
  await vault(admin).write(
    { connectionId: id, workspaceId: p.workspaceId },
    {
      accessToken: p.tokens.accessToken,
      accessTokenExpiresAt: p.tokens.expiresAt.toISOString(),
      refreshToken: p.tokens.refreshToken,
      scopes: [],
    },
  );
  forgetTuyaAccount(id);
  return id;
}

const vault = (admin: Admin) => new SupabaseCredentialVault(admin, PROVIDER);

export interface TuyaConnection {
  id: string;
  region: TuyaRegion;
  uid: string;
  label: string;
  status: "connected" | "needs_reauthorization" | "error" | "disabled" | "connecting";
  problem: string | null;
}

const metadata = z.object({ region: z.string(), uid: z.string() });

/** This workspace's Smart Life accounts (never another workspace's: scoped and under RLS). */
export async function tuyaConnections(auth: AuthContext): Promise<TuyaConnection[]> {
  const { data, error } = await auth.db
    .from("provider_connections")
    .select("id, status, auth_metadata, account_label, last_error_code")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", PROVIDER)
    .neq("status", "disconnected")
    .order("created_at");
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load connections", { cause: error });
  return (data ?? []).flatMap((r) => {
    const m = metadata.safeParse(r.auth_metadata);
    if (!m.success || !isTuyaRegion(m.data.region)) return [];
    return [
      {
        id: r.id,
        region: m.data.region,
        uid: m.data.uid,
        label: r.account_label ?? "Smart Life",
        status: r.status as TuyaConnection["status"],
        problem: r.last_error_code,
      },
    ];
  });
}

/** One connection of THIS workspace, or not found (ids from a client are never trusted). */
export async function tuyaConnection(auth: AuthContext, id: unknown): Promise<TuyaConnection> {
  const connectionId = z.uuid().parse(id);
  const found = (await tuyaConnections(auth)).find((c) => c.id === connectionId);
  if (!found) throw new AppError("NOT_FOUND", "Connection not found");
  return found;
}

/** Records what Tuya said about this account (shown as its state; cleared on success). */
async function markProblem(c: Pick<TuyaConnection, "id">, workspaceId: string, e: unknown) {
  const problem = e instanceof TuyaError ? e.problem : null;
  if (!problem || problem === "unavailable" || problem === "rate_limited") return;
  await createAdminClient()
    .from("provider_connections")
    .update({
      last_error_code: problem,
      last_error_at: new Date().toISOString(),
      ...(problem === "token" ? { status: "needs_reauthorization" as const } : {}),
    })
    .eq("id", c.id)
    .eq("workspace_id", workspaceId);
}

/**
 * The person's token for one connection: stored one while valid, else refreshed by one caller
 * at a time (others wait for the result). A refused refresh means "Reconectar".
 */
export function tuyaAuthFor(
  workspaceId: string,
  c: Pick<TuyaConnection, "id" | "region">,
): TuyaAuth & { reportProblem(e: unknown): Promise<void> } {
  const admin = createAdminClient();
  const ref = { connectionId: c.id, workspaceId };
  let rejected = false;
  return {
    region: c.region,
    key: c.id,
    tokenRejected: () => void (rejected = true),
    reportProblem: (e) => markProblem(c, workspaceId, e),
    async accessToken() {
      for (let wait = 0; wait < 10; wait++) {
        const cred = await vault(admin).read(ref);
        if (!cred?.refreshToken) throw new TuyaError("token", null, 0, "vault");
        if (!rejected && new Date(cred.accessTokenExpiresAt).getTime() > Date.now())
          return cred.accessToken;
        if (await vault(admin).acquireRefreshLease(ref)) {
          try {
            const t = await refreshTuyaToken(c.region, cred.refreshToken).catch(async (e) => {
              await markProblem(c, workspaceId, e);
              throw e;
            });
            await vault(admin).write(ref, {
              accessToken: t.accessToken,
              accessTokenExpiresAt: t.expiresAt.toISOString(),
              refreshToken: t.refreshToken,
              scopes: [],
            });
            rejected = false;
            return t.accessToken;
          } finally {
            await vault(admin).releaseRefreshLease(ref);
          }
        }
        // Another instance is refreshing: its new token is read on the next pass.
        rejected = false;
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new TuyaError("unavailable", null, 0, "token_refresh_wait");
    },
  };
}

/**
 * "Desconectar": ELISE forgets the account — its token, its cache, and every device that came
 * from it (kept as removed for history, never controllable again). Tuya documents no revocation
 * endpoint for an OAuth user token: the person can also remove ELISE in Smart Life.
 */
export async function disconnectTuya(auth: AuthContext, id: unknown) {
  const c = await tuyaConnection(auth, id);
  const admin = createAdminClient();
  const now = new Date().toISOString();
  await vault(admin).remove({ connectionId: c.id, workspaceId: auth.workspaceId });
  await admin
    .from("provider_connections")
    .update({ status: "disconnected", disconnected_at: now })
    .eq("id", c.id)
    .eq("workspace_id", auth.workspaceId);
  await admin
    .from("home_devices")
    .update({ removed_at: now, available: false })
    .eq("workspace_id", auth.workspaceId)
    .like("provider_key", `${TUYA_KEY_PREFIX}${c.id}:%`);
  forgetTuyaAccount(c.id);
  logger.info("tuya_disconnected", { region: c.region });
}
