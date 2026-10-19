import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { AppError } from "@/core/errors";
import { HOME_RUNTIME_PHASES } from "@/core/home/runtime";
import { PLATFORM_CAPABILITIES } from "@/core/platform/platform";
import { MIN_DESKTOP_BRIDGE_PROTOCOL, type DesktopPresence } from "@/core/platform/presence";
import { logger } from "@/infrastructure/observability/logger";
import { notMigrated } from "@/infrastructure/providers/elise-native/common";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { mintSessionForUser } from "@/infrastructure/supabase/desktop-session";

import type { AuthContext } from "./auth-context";

/**
 * ELISE Desktop (ADR-081) — the cloud side:
 * - sign-in through the system browser: the person, signed in on the web, approves; the app gets
 *   a single-use code bound to its PKCE challenge, and exchanges it (with the verifier) for a
 *   normal session. No Desktop-only accounts, no passwords typed into the app.
 * - presence: each installation (random id, several per person) reports version, protocol and
 *   capabilities, so the web can tell "detected", "offline" or "update required".
 */

const CODE_TTL_MS = 5 * 60_000;

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const b64urlSha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

function check(error: { code?: string; message: string } | null, what: string) {
  if (!error) return;
  if (notMigrated(error.code))
    throw new AppError("CAPABILITY_UNAVAILABLE", "ELISE Desktop needs the latest database update", {
      recovery: "review",
    });
  throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

export const connectRequestSchema = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  installation: z.uuid(),
});

/** The signed-in person approved this Desktop: a code only that app's verifier can redeem. */
export async function createDesktopAuthCode(auth: AuthContext, raw: unknown) {
  const input = connectRequestSchema.parse(raw);
  const code = randomBytes(32).toString("base64url");
  const { error } = await createAdminClient()
    .from("desktop_auth_codes")
    .insert({
      code_hash: sha256hex(code),
      challenge: input.challenge,
      user_id: auth.userId,
      workspace_id: auth.workspaceId,
      installation_id: input.installation,
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    });
  check(error, "approve ELISE Desktop");
  logger.info("desktop_connect_approved", { workspace_id: auth.workspaceId });
  const url = new URL("elise://auth/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", input.state);
  return { redirect: url.toString() };
}

const exchangeSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  installationId: z.uuid(),
});

/** Single use, short-lived, bound to the challenge and the installation that asked. */
export async function exchangeDesktopCode(raw: unknown) {
  const input = exchangeSchema.parse(raw);
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("desktop_auth_codes")
    .update({ used_at: now })
    .eq("code_hash", sha256hex(input.code))
    .is("used_at", null)
    .gt("expires_at", now)
    .select("challenge, user_id, workspace_id, installation_id");
  check(error, "sign in ELISE Desktop");
  const row = data?.[0];
  const expected = row ? Buffer.from(row.challenge) : Buffer.alloc(0);
  const given = Buffer.from(b64urlSha256(input.verifier));
  const ok =
    row &&
    row.installation_id === input.installationId &&
    expected.length === given.length &&
    timingSafeEqual(expected, given);
  if (!ok)
    throw new AppError("PERMISSION_DENIED", "This sign-in link is invalid, used or expired", {
      recovery: "sign_in",
    });
  const session = await mintSessionForUser(row.user_id);
  logger.info("desktop_signed_in", { workspace_id: row.workspace_id });
  return { ...session, userId: row.user_id, workspaceId: row.workspace_id };
}

export const heartbeatSchema = z.object({
  installationId: z.uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  platform: z.enum(["windows", "macos", "linux"]),
  desktopVersion: z.string().max(40),
  bridgeProtocolVersion: z.number().int().min(0),
  capabilities: z.array(z.enum(PLATFORM_CAPABILITIES)).max(20),
  homeRuntime: z
    .object({
      phase: z.enum(HOME_RUNTIME_PHASES),
      enabled: z.boolean(),
      progress: z.number().int().min(0).max(100).nullable(),
    })
    .nullable()
    .optional(),
});

/** Presence, as the person (RLS): their own row only. Answers what this backend requires. */
export async function desktopHeartbeat(auth: AuthContext, raw: unknown) {
  const input = heartbeatSchema.parse(raw);
  const base = {
    user_id: auth.userId,
    workspace_id: auth.workspaceId,
    installation_id: input.installationId,
    platform: input.platform,
    desktop_version: input.desktopVersion,
    bridge_protocol_version: input.bridgeProtocolVersion,
    capabilities: input.capabilities,
    last_seen_at: new Date().toISOString(),
    ...(input.name ? { name: input.name } : {}),
  };
  const home = input.homeRuntime
    ? {
        home_enabled: input.homeRuntime.enabled,
        home_runtime_phase: input.homeRuntime.phase,
        home_runtime_progress: input.homeRuntime.progress,
      }
    : {};
  const upsert = (row: typeof base) =>
    auth.db.from("desktop_installations").upsert(row, { onConflict: "user_id,installation_id" });
  let { error } = await upsert({ ...base, ...home });
  // Before migration 051 the Home columns don't exist yet: presence still works without them.
  if (error?.code === "42703") ({ error } = await upsert(base));
  check(error, "update ELISE Desktop presence");
  return {
    minBridgeProtocolVersion: MIN_DESKTOP_BRIDGE_PROTOCOL,
    updateRequired: input.bridgeProtocolVersion < MIN_DESKTOP_BRIDGE_PROTOCOL,
  };
}

/** This person's computers in this workspace (RLS: never anyone else's installation). */
export async function listDesktops(auth: AuthContext): Promise<DesktopPresence[]> {
  const { data, error } = await auth.db
    .from("desktop_installations")
    .select("*")
    .eq("user_id", auth.userId)
    .eq("workspace_id", auth.workspaceId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false });
  if (error) {
    if (notMigrated(error.code)) return []; // before migration 050/051: no Desktop yet
    throw new AppError("INTERNAL_ERROR", "Could not load ELISE Desktop", { cause: error });
  }
  return (data ?? []).map((d) => ({
    installationId: d.installation_id,
    name: d.name,
    platform: d.platform,
    lastSeenAt: d.last_seen_at,
    bridgeProtocolVersion: d.bridge_protocol_version,
    homeEnabled: d.home_enabled ?? false,
    homeRuntimePhase: (d.home_runtime_phase as DesktopPresence["homeRuntimePhase"]) ?? null,
    homeRuntimeProgress: d.home_runtime_progress ?? null,
  }));
}
