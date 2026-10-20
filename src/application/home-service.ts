import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  HOME_COMMAND_TTL_MS,
  HOME_DEVICE_TYPES,
  homeActionSchema,
  homeCapabilitySchema,
  homeSceneActionSchema,
  homeSetupState,
  homeStateSchema,
  hubStatus,
  validateAction,
  type HomeAction,
  type HomeCapability,
  type HomeCommandOutcome,
  type HomeDevice,
  type HomePort,
  type HomeScene,
  type HomeSnapshot,
  type HomeState,
  type HubCommand,
  type HubPresence,
} from "@/core/home/model";
import { logger } from "@/infrastructure/observability/logger";
import { notMigrated } from "@/infrastructure/providers/elise-native/common";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { HomeDeviceRow, HomeHubRow, Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * ELISE Home (ADR-079). Two sides:
 * - the person (their session, under RLS): their home, devices, rooms, modes, and commands that
 *   ELISE validated before they leave;
 * - the hub (its own revocable token, never a user session): pairing, heartbeat, registry sync,
 *   claiming commands and reporting results — every statement scoped to the hub's workspace.
 * Physical commands live 30 s: an "encendé la luz" never runs after the hub comes back hours
 * later. Each is claimed atomically, so a reconnect never runs one twice.
 */

type Db = AuthContext["db"];

const needsUpdate = () =>
  new AppError("CAPABILITY_UNAVAILABLE", "ELISE Home needs the latest database update", {
    recovery: "review",
  });

function check(error: { code?: string; message: string } | null, what: string) {
  if (!error) return;
  if (notMigrated(error.code)) throw needsUpdate();
  throw new AppError("INTERNAL_ERROR", `Could not ${what}`, { cause: error });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Reading ──────────────────────────────────────────────────────────────────

const deviceOf = (r: HomeDeviceRow): HomeDevice => ({
  id: r.id,
  name: r.display_name ?? r.name,
  aliases: r.aliases,
  roomId: r.room_id,
  type: r.device_type,
  capabilities: z.array(homeCapabilitySchema).catch([]).parse(r.capabilities),
  state: homeStateSchema.catch({}).parse(r.state),
  available: r.available,
  stateUpdatedAt: r.state_updated_at,
  favorite: r.favorite,
});

const presenceOf = (h: HomeHubRow): HubPresence => ({
  lastSeenAt: h.last_seen_at,
  providerConnected: h.provider_connected,
  runtimeState: h.runtime_state,
  protocolVersion: h.protocol_version,
  lastSyncAt: h.last_sync_at,
});

async function currentHome(db: Db, workspaceId: string) {
  const { data, error } = await db
    .from("homes")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  check(error, "load the home");
  return data;
}

async function currentHub(db: Db, homeId: string) {
  const { data, error } = await db
    .from("home_hubs")
    .select("*")
    .eq("home_id", homeId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(error, "load the hub");
  return data;
}

/** Everything ELISE knows about the home (hidden and removed devices left out unless asked). */
export async function homeSnapshot(
  auth: AuthContext,
  options: { includeHidden?: boolean } = {},
): Promise<
  HomeSnapshot & { hidden: HomeDevice[]; found: HomeDevice[]; hubInfo: HomeHubRow | null }
> {
  const home = await currentHome(auth.db, auth.workspaceId);
  if (!home)
    return {
      home: null,
      hub: null,
      rooms: [],
      devices: [],
      groups: [],
      scenes: [],
      hidden: [],
      found: [],
      hubInfo: null,
    };
  const [hub, rooms, devices, groups, scenes] = await Promise.all([
    currentHub(auth.db, home.id),
    auth.db.from("home_rooms").select("*").eq("home_id", home.id).order("name"),
    auth.db
      .from("home_devices")
      .select("*")
      .eq("home_id", home.id)
      .is("removed_at", null)
      .order("name"),
    auth.db.from("home_groups").select("*").eq("home_id", home.id).order("name"),
    auth.db.from("home_scenes").select("*").eq("home_id", home.id).order("name"),
  ]);
  for (const r of [rooms, devices, groups, scenes]) check(r.error, "load the home");
  // ADR-103: only what the person added (before migration 060 the column is absent: all were).
  const rows = (devices.data ?? []).map((d) => ({ row: d, device: deviceOf(d) }));
  const all = rows.filter((x) => x.row.added_at !== null);
  return {
    home,
    hub: hub
      ? {
          id: hub.id,
          name: hub.name,
          status: hubStatus(
            { lastSeenAt: hub.last_seen_at, providerConnected: hub.provider_connected },
            new Date(),
          ),
          setup: homeSetupState(presenceOf(hub), new Date()),
          lastSeenAt: hub.last_seen_at,
          lastSyncAt: hub.last_sync_at,
        }
      : null,
    hubInfo: hub,
    rooms: (rooms.data ?? []).map((r) => ({
      id: r.id,
      name: r.display_name ?? r.name,
      aliases: r.aliases,
      icon: r.icon,
      favorite: r.favorite,
    })),
    devices: all.filter((x) => !x.row.hidden || options.includeHidden).map((x) => x.device),
    hidden: all.filter((x) => x.row.hidden).map((x) => x.device),
    found: rows.filter((x) => x.row.added_at === null && !x.row.hidden).map((x) => x.device),
    groups: (groups.data ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      aliases: g.aliases,
      deviceIds: g.device_ids,
    })),
    scenes: (scenes.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      aliases: s.aliases,
      favorite: s.favorite,
      actions: z.array(homeSceneActionSchema).catch([]).parse(s.actions),
    })),
  };
}

async function ensureHome(auth: AuthContext) {
  const existing = await currentHome(auth.db, auth.workspaceId);
  if (existing) return existing;
  const { data, error } = await auth.db
    .from("homes")
    .insert({
      workspace_id: auth.workspaceId,
      name: auth.profile.locale === "es" ? "Casa" : "Home",
      timezone: auth.profile.timezone,
      created_by_user_id: auth.userId,
    })
    .select("id, name")
    .single();
  check(error, "create the home");
  return data!;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

/** "ELISE-7KD2-PQ9A": no 0/O or 1/I, so it reads aloud and types cleanly. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_TTL_MS = 10 * 60_000;

const newCode = () => {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `ELISE-${chars.slice(0, 4)}-${chars.slice(4)}`;
};
const normalizeCode = (code: string) =>
  code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/** A single-use code, valid 10 minutes, that links a hub to this person's home. */
export async function createPairingCode(auth: AuthContext) {
  const home = await ensureHome(auth);
  const code = newCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const { error } = await createAdminClient()
    .from("home_pairing_codes")
    .insert({
      workspace_id: auth.workspaceId,
      home_id: home.id,
      code_hash: sha256(normalizeCode(code)),
      expires_at: expiresAt,
      created_by_user_id: auth.userId,
    });
  check(error, "create the pairing code");
  logger.info("home_pairing_code_created", { workspace_id: auth.workspaceId, home_id: home.id });
  return { code, expiresAt };
}

const pairInput = z
  .object({
    code: z.string().trim().min(8).max(40),
    hostKind: z.enum(["desktop", "service", "hardware"]).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    agentVersion: z.string().max(40).optional(),
    protocolVersion: z.number().int().optional(),
    installationId: z.uuid().optional(),
  })
  .strict();

/** The hub redeems a code: once, before it expires. Returns its own credential (once). */
export async function redeemPairingCode(raw: unknown) {
  const input = pairInput.parse(raw);
  const db = createAdminClient();
  const now = new Date().toISOString();
  // Atomic: the first redeemer marks it used; a second (or an expired code) gets nothing.
  const { data: codes, error } = await db
    .from("home_pairing_codes")
    .update({ used_at: now })
    .eq("code_hash", sha256(normalizeCode(input.code)))
    .is("used_at", null)
    .gt("expires_at", now)
    .select("workspace_id, home_id");
  check(error, "check the pairing code");
  const code = codes?.[0];
  if (!code)
    throw new AppError("PERMISSION_DENIED", "This pairing code is invalid, used or expired", {
      recovery: "review",
    });
  const token = `ehh_${randomBytes(32).toString("base64url")}`;
  const { data: hub, error: hubError } = await db
    .from("home_hubs")
    .insert({
      workspace_id: code.workspace_id,
      home_id: code.home_id,
      name: input.name ?? "ELISE Home Hub",
      host_kind: input.hostKind ?? "service",
      token_prefix: token.slice(0, 8),
      agent_version: input.agentVersion ?? null,
      protocol_version: input.protocolVersion ?? null,
      installation_id: input.installationId ?? null,
    })
    .select("id, home_id")
    .single();
  check(hubError, "register the hub");
  const { error: credError } = await db
    .from("home_hub_credentials")
    .insert({ hub_id: hub!.id, token_hash: sha256(token) });
  check(credError, "register the hub");
  logger.info("home_hub_paired", { workspace_id: code.workspace_id, hub_id: hub!.id });
  return { hubId: hub!.id, homeId: hub!.home_id, token };
}

const desktopInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    agentVersion: z.string().max(40).optional(),
    protocolVersion: z.number().int().optional(),
    installationId: z.uuid().optional(),
  })
  .strict();

/**
 * ELISE Desktop, signed in as this person, registers itself as the home's hub (ADR-080): no
 * code to copy. It gets a hub-only credential (once) — the person's session never leaves the
 * Desktop app and the hub never holds it. A previous Desktop hub of this home is replaced.
 */
export async function registerDesktopHub(auth: AuthContext, raw: unknown) {
  const input = desktopInput.parse(raw);
  const home = await ensureHome(auth);
  const db = createAdminClient();
  const token = `ehh_${randomBytes(32).toString("base64url")}`;
  await db
    .from("home_hubs")
    .update({ revoked_at: new Date().toISOString() })
    .eq("home_id", home.id)
    .eq("workspace_id", auth.workspaceId)
    .eq("host_kind", "desktop")
    .is("revoked_at", null);
  const { data: hub, error } = await db
    .from("home_hubs")
    .insert({
      workspace_id: auth.workspaceId,
      home_id: home.id,
      name: input.name ?? "ELISE Desktop",
      host_kind: "desktop",
      token_prefix: token.slice(0, 8),
      agent_version: input.agentVersion ?? null,
      protocol_version: input.protocolVersion ?? null,
      installation_id: input.installationId ?? null,
    })
    .select("id, home_id")
    .single();
  check(error, "register ELISE Desktop");
  const { error: credError } = await db
    .from("home_hub_credentials")
    .insert({ hub_id: hub!.id, token_hash: sha256(token) });
  check(credError, "register ELISE Desktop");
  logger.info("home_hub_paired", {
    workspace_id: auth.workspaceId,
    hub_id: hub!.id,
    host: "desktop",
  });
  return { hubId: hub!.id, homeId: hub!.home_id, token };
}

export interface AuthedHub {
  id: string;
  workspaceId: string;
  homeId: string;
}

/** A hub's bearer token → the hub (not revoked). Never a user identity. */
export async function authenticateHub(header: string | null): Promise<AuthedHub> {
  const token = header?.match(/^Bearer\s+(ehh_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!token) throw new AppError("AUTH_ERROR", "Hub credential required");
  const db = createAdminClient();
  const { data: cred } = await db
    .from("home_hub_credentials")
    .select("hub_id")
    .eq("token_hash", sha256(token))
    .maybeSingle();
  if (!cred) throw new AppError("AUTH_ERROR", "Unknown hub credential");
  const { data: hub } = await db
    .from("home_hubs")
    .select("id, workspace_id, home_id, revoked_at")
    .eq("id", cred.hub_id)
    .maybeSingle();
  if (!hub || hub.revoked_at) throw new AppError("AUTH_ERROR", "This hub was disconnected");
  return { id: hub.id, workspaceId: hub.workspace_id, homeId: hub.home_id };
}

// ── The hub's side ───────────────────────────────────────────────────────────

const heartbeatInput = z
  .object({
    providerConnected: z.boolean(),
    runtimeState: z.enum(["initializing", "ready", "error"]).optional(),
    providerVersion: z.string().max(40).nullable().optional(),
    agentVersion: z.string().max(40).optional(),
    protocolVersion: z.number().int().optional(),
  })
  .strict();

export async function hubHeartbeat(hub: AuthedHub, raw: unknown) {
  const h = heartbeatInput.parse(raw);
  const { error } = await createAdminClient()
    .from("home_hubs")
    .update({
      last_seen_at: new Date().toISOString(),
      provider_connected: h.providerConnected,
      ...(h.runtimeState ? { runtime_state: h.runtimeState } : {}),
      ...(h.providerVersion !== undefined ? { provider_version: h.providerVersion } : {}),
      ...(h.agentVersion ? { agent_version: h.agentVersion } : {}),
      ...(h.protocolVersion ? { protocol_version: h.protocolVersion } : {}),
    })
    .eq("id", hub.id)
    .eq("workspace_id", hub.workspaceId);
  check(error, "record the heartbeat");
}

const syncedDevice = z
  .object({
    providerKey: z.string().min(1).max(300),
    providerDeviceId: z.string().max(200).nullable(),
    entityIds: z.array(z.string().max(255)).min(1).max(30),
    name: z.string().trim().min(1).max(120),
    areaId: z.string().max(200).nullable(),
    type: z.enum(HOME_DEVICE_TYPES),
    capabilities: z.array(homeCapabilitySchema).max(20),
    state: homeStateSchema,
    available: z.boolean(),
    stateUpdatedAt: z.string().max(40).nullable(),
  })
  .strict();

const syncInput = z
  .object({
    rooms: z
      .array(
        z
          .object({
            providerAreaId: z.string().min(1).max(200),
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .max(200),
    devices: z.array(syncedDevice).max(500),
  })
  .strict();

/**
 * The provider's registry → ELISE's, reconciled by stable provider ids: names and rooms follow
 * the provider unless the person overrode them; a device that disappears is marked removed
 * (its aliases and modes stay) and comes back as it was.
 */
export async function hubSync(hub: AuthedHub, raw: unknown) {
  const started = Date.now();
  const input = syncInput.parse(raw);
  const db = createAdminClient();
  const scope = { workspace_id: hub.workspaceId, home_id: hub.homeId };

  const { data: existingRooms, error: roomsError } = await db
    .from("home_rooms")
    .select("id, provider_area_id")
    .eq("home_id", hub.homeId)
    .eq("workspace_id", hub.workspaceId);
  check(roomsError, "sync rooms");
  const roomByArea = new Map((existingRooms ?? []).map((r) => [r.provider_area_id, r.id]));
  for (const r of input.rooms) {
    const id = roomByArea.get(r.providerAreaId);
    if (id)
      await db
        .from("home_rooms")
        .update({ name: r.name })
        .eq("id", id)
        .eq("workspace_id", hub.workspaceId);
    else {
      const { data } = await db
        .from("home_rooms")
        .insert({ ...scope, provider_area_id: r.providerAreaId, name: r.name })
        .select("id")
        .single();
      if (data) roomByArea.set(r.providerAreaId, data.id);
    }
  }

  const { data: existing, error } = await db
    .from("home_devices")
    // "*": added_at exists only once migration 060 is applied.
    .select("*")
    .eq("hub_id", hub.id)
    .eq("workspace_id", hub.workspaceId);
  check(error, "sync devices");
  const byKey = new Map((existing ?? []).map((d) => [d.provider_key, d]));
  const now = new Date().toISOString();
  for (const d of input.devices) {
    const room = d.areaId ? (roomByArea.get(d.areaId) ?? null) : null;
    const fields = {
      provider_device_id: d.providerDeviceId,
      provider_entity_ids: d.entityIds,
      name: d.name,
      device_type: d.type,
      capabilities: d.capabilities as unknown as Json,
      state: d.state as unknown as Json,
      available: d.available,
      state_updated_at: d.stateUpdatedAt ?? now,
      removed_at: null,
    };
    const prior = byKey.get(d.providerKey);
    if (prior)
      await db
        .from("home_devices")
        .update({
          ...fields,
          ...(prior.room_override ? {} : { room_id: room }),
          // ADR-103: a device the person removed that the engine brings back is found again,
          // not silently theirs again.
          ...(prior.removed_at && prior.added_at !== undefined ? { added_at: null } : {}),
        })
        .eq("id", prior.id)
        .eq("workspace_id", hub.workspaceId);
    else
      await db.from("home_devices").insert({
        ...scope,
        hub_id: hub.id,
        provider_key: d.providerKey,
        room_id: room,
        ...fields,
      });
  }
  const seen = new Set(input.devices.map((d) => d.providerKey));
  const gone = (existing ?? []).filter((d) => !seen.has(d.provider_key)).map((d) => d.id);
  if (gone.length)
    await db
      .from("home_devices")
      .update({ removed_at: now })
      .in("id", gone)
      .eq("workspace_id", hub.workspaceId);
  await db.from("home_hubs").update({ last_sync_at: now, last_seen_at: now }).eq("id", hub.id);
  logger.info("home_sync", {
    hub_id: hub.id,
    devices: input.devices.length,
    rooms: input.rooms.length,
    removed: gone.length,
    latency_ms: Date.now() - started,
  });
  return { devices: input.devices.length, rooms: input.rooms.length, removed: gone.length };
}

const statesInput = z
  .object({
    devices: z
      .array(
        z
          .object({
            providerKey: z.string().min(1).max(300),
            state: homeStateSchema,
            available: z.boolean(),
            stateUpdatedAt: z.string().max(40).nullable(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

/** Meaningful state changes (already normalized by the hub) — the cache, with its time. */
export async function hubStates(hub: AuthedHub, raw: unknown) {
  const input = statesInput.parse(raw);
  const db = createAdminClient();
  const now = new Date().toISOString();
  for (const d of input.devices)
    await db
      .from("home_devices")
      .update({
        state: d.state as unknown as Json,
        available: d.available,
        state_updated_at: d.stateUpdatedAt ?? now,
      })
      .eq("hub_id", hub.id)
      .eq("workspace_id", hub.workspaceId)
      .eq("provider_key", d.providerKey);
}

/**
 * Commands for this hub: stale ones expire first (never delivered late), then queued ones are
 * claimed atomically. Waits up to `waitMs` for one to arrive (long poll over outbound HTTPS:
 * no open ports at home).
 */
export async function hubClaimCommands(hub: AuthedHub, waitMs: number): Promise<HubCommand[]> {
  const db = createAdminClient();
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
  await db.from("home_hubs").update({ last_seen_at: new Date().toISOString() }).eq("id", hub.id);
  for (;;) {
    const now = new Date().toISOString();
    const { data: expired } = await db
      .from("home_commands")
      .update({ status: "expired", finished_at: now, error_code: "EXPIRED" })
      .eq("hub_id", hub.id)
      .eq("status", "queued")
      .lte("expires_at", now)
      .select("id");
    if (expired?.length)
      logger.info("home_commands_expired", { hub_id: hub.id, count: expired.length });
    const { data: claimed, error } = await db
      .from("home_commands")
      .update({ status: "delivered", delivered_at: now })
      .eq("hub_id", hub.id)
      .eq("workspace_id", hub.workspaceId)
      .eq("status", "queued")
      .gt("expires_at", now)
      .select("id, device_id, actions, expires_at, created_at");
    check(error, "claim commands");
    if (claimed?.length) {
      const { data: devices } = await db
        .from("home_devices")
        .select("id, provider_key, provider_entity_ids")
        .in(
          "id",
          claimed.map((c) => c.device_id),
        )
        .eq("workspace_id", hub.workspaceId);
      const dev = new Map((devices ?? []).map((d) => [d.id, d]));
      return claimed
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .flatMap((c) => {
          const d = dev.get(c.device_id);
          const actions = z.array(homeActionSchema).safeParse(c.actions);
          if (!d || !actions.success) return [];
          return [
            {
              id: c.id,
              deviceId: c.device_id,
              target: { providerKey: d.provider_key, entityIds: d.provider_entity_ids },
              actions: actions.data,
              expiresAt: c.expires_at,
            },
          ];
        });
    }
    if (Date.now() >= deadline) return [];
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const resultInput = z
  .object({
    status: z.enum(["executing", "succeeded", "failed"]),
    error: z.string().max(60).optional(),
    state: homeStateSchema.optional(),
    latencyMs: z.number().int().min(0).max(120_000).optional(),
  })
  .strict();

/** The hub reports what happened (only its own, delivered commands can change). */
export async function hubReportResult(hub: AuthedHub, commandId: string, raw: unknown) {
  const r = resultInput.parse(raw);
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("home_commands")
    .update({
      status: r.status,
      ...(r.status === "executing" ? {} : { finished_at: now }),
      ...(r.error ? { error_code: r.error } : {}),
      ...(r.state ? { result: { state: r.state } as unknown as Json } : {}),
    })
    .eq("id", z.uuid().parse(commandId))
    .eq("hub_id", hub.id)
    .eq("workspace_id", hub.workspaceId)
    .in("status", r.status === "executing" ? ["delivered"] : ["delivered", "executing"])
    .select("device_id")
    .maybeSingle();
  check(error, "record the result");
  if (!data) throw new AppError("CONFLICT", "This command isn't waiting for a result");
  if (r.state)
    await db
      .from("home_devices")
      .update({ state: r.state as unknown as Json, available: true, state_updated_at: now })
      .eq("id", data.device_id)
      .eq("workspace_id", hub.workspaceId);
  logger.info("home_command", {
    hub_id: hub.id,
    command_id: commandId,
    status: r.status,
    error: r.error ?? null,
    latency_ms: r.latencyMs ?? null,
  });
}

// ── The person's side: commands ──────────────────────────────────────────────

const WAIT_FOR_RESULT_MS = 8_000;

/**
 * Validated actions per device → commands for the hub, then a short wait for the results. An
 * offline hub or an unavailable device answers at once (never a fake success).
 */
export async function executeHomeCommands(
  auth: AuthContext,
  commands: { deviceId: string; actions: HomeAction[] }[],
  origin: "user_ui" | "ai" | "schedule" = "user_ui",
): Promise<HomeCommandOutcome[]> {
  const snap = await homeSnapshot(auth, { includeHidden: true });
  const hub = snap.hub;
  const byId = new Map(snap.devices.map((d) => [d.id, d]));
  const outcomes: HomeCommandOutcome[] = [];
  const toSend: { device: HomeDevice; actions: HomeAction[] }[] = [];
  for (const c of commands) {
    const device = byId.get(c.deviceId);
    if (!device)
      throw new AppError("NOT_FOUND", "That device isn't in your home", { recovery: "review" });
    if (!hub || hub.status === "offline")
      outcomes.push({ deviceId: device.id, name: device.name, status: "offline" });
    // Removing works on a device that doesn't answer (a TV that's off): the engine does it.
    else if (!device.available && !c.actions.every((a) => a.type === "remove"))
      outcomes.push({ deviceId: device.id, name: device.name, status: "unavailable" });
    else toSend.push({ device, actions: c.actions.map((a) => homeActionSchema.parse(a)) });
  }
  if (!toSend.length || !hub || !snap.home) return outcomes;
  const expiresAt = new Date(Date.now() + HOME_COMMAND_TTL_MS).toISOString();
  const { data: rows, error } = await auth.db
    .from("home_commands")
    .insert(
      toSend.map((c) => ({
        workspace_id: auth.workspaceId,
        home_id: snap.home!.id,
        hub_id: hub.id,
        device_id: c.device.id,
        actions: c.actions as unknown as Json,
        origin,
        created_by_user_id: auth.userId,
        expires_at: expiresAt,
      })),
    )
    .select("id, device_id");
  check(error, "send the command");
  const ids = (rows ?? []).map((r) => r.id);
  const deadline = Date.now() + WAIT_FOR_RESULT_MS;
  let done: {
    id: string;
    device_id: string;
    status: string;
    error_code: string | null;
    result: Json | null;
  }[] = [];
  while (Date.now() < deadline) {
    const { data } = await auth.db
      .from("home_commands")
      .select("id, device_id, status, error_code, result")
      .in("id", ids);
    done = data ?? [];
    if (done.every((d) => ["succeeded", "failed", "expired", "cancelled"].includes(d.status)))
      break;
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const c of toSend) {
    const row = done.find((d) => d.device_id === c.device.id);
    const state = (row?.result as { state?: HomeState } | null)?.state;
    outcomes.push({
      deviceId: c.device.id,
      name: c.device.name,
      status:
        row?.status === "succeeded"
          ? "succeeded"
          : row?.status === "failed"
            ? "failed"
            : row?.status === "expired"
              ? "expired"
              : "pending",
      ...(row?.error_code ? { error: row.error_code } : {}),
      ...(state ? { state } : {}),
    });
  }
  return outcomes;
}

// ── The person's side: names, rooms, modes ───────────────────────────────────

const devicePatch = z
  .object({
    displayName: z.string().trim().min(1).max(80).nullable().optional(),
    aliases: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    roomId: z.uuid().nullable().optional(),
    favorite: z.boolean().optional(),
    hidden: z.boolean().optional(),
    /** ADR-103: "Agregar" on a device found on the network. */
    added: z.literal(true).optional(),
  })
  .strict();

export async function updateHomeDevice(auth: AuthContext, deviceId: string, raw: unknown) {
  const p = devicePatch.parse(raw);
  const { error } = await auth.db
    .from("home_devices")
    .update({
      ...(p.displayName !== undefined ? { display_name: p.displayName } : {}),
      ...(p.aliases ? { aliases: [...new Set(p.aliases)] } : {}),
      ...(p.roomId !== undefined ? { room_id: p.roomId, room_override: true } : {}),
      ...(p.favorite !== undefined ? { favorite: p.favorite } : {}),
      ...(p.hidden !== undefined ? { hidden: p.hidden } : {}),
      ...(p.added ? { added_at: new Date().toISOString(), hidden: false } : {}),
    })
    .eq("id", z.uuid().parse(deviceId))
    .eq("workspace_id", auth.workspaceId);
  check(error, "update the device");
}

/**
 * ADR-103: right after the person finishes adding a device in Hogar's setup, what the engine
 * registered since then is theirs — that's what they just added. Only rows found since `since`
 * (at most ten minutes back), never ones they ignored.
 */
export async function adoptNewHomeDevices(auth: AuthContext, since: string) {
  const at = new Date(z.iso.datetime().parse(since));
  const floor = new Date(Date.now() - 10 * 60_000);
  const { data, error } = await auth.db
    .from("home_devices")
    .update({ added_at: new Date().toISOString() })
    .eq("workspace_id", auth.workspaceId)
    .is("added_at", null)
    .is("removed_at", null)
    .eq("hidden", false)
    .gte("created_at", (at > floor ? at : floor).toISOString())
    .select("id");
  check(error, "add the new devices");
  return { added: data?.length ?? 0 };
}

/**
 * "Quitar": the hub takes the device out of the home engine, so it can be found and added again
 * later. When the hub can't do it now (offline, an older ELISE Desktop), the device still leaves
 * the person's list.
 */
export async function removeHomeDevice(auth: AuthContext, deviceId: string) {
  const id = z.uuid().parse(deviceId);
  const [outcome] = await executeHomeCommands(auth, [
    { deviceId: id, actions: [{ type: "remove" }] },
  ]).catch(() => []);
  const removed = outcome?.status === "succeeded";
  const { error } = await auth.db
    .from("home_devices")
    .update(removed ? { removed_at: new Date().toISOString() } : { hidden: true })
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId);
  check(error, "remove the device");
  return { removed };
}

export async function createHomeRoom(auth: AuthContext, name: string) {
  const home = await ensureHome(auth);
  const { data, error } = await auth.db
    .from("home_rooms")
    .insert({
      workspace_id: auth.workspaceId,
      home_id: home.id,
      name: z.string().trim().min(1).max(80).parse(name),
    })
    .select("id")
    .single();
  check(error, "create the room");
  return data!.id;
}

/**
 * A mode, validated against the devices it names: each action must be one the device supports,
 * in range. Saved as typed actions (never a prompt, never provider service names).
 */
export async function saveHomeScene(
  auth: AuthContext,
  scene: Omit<HomeScene, "id" | "favorite"> & { id?: string },
): Promise<HomeScene> {
  const snap = await homeSnapshot(auth, { includeHidden: true });
  if (!snap.home)
    throw new AppError("VALIDATION_ERROR", "Set up ELISE Home first", { recovery: "review" });
  const byId = new Map(snap.devices.map((d) => [d.id, d]));
  const actions = z.array(homeSceneActionSchema).max(30).parse(scene.actions);
  for (const a of actions) {
    const d = byId.get(a.deviceId);
    if (!d)
      throw new AppError("VALIDATION_ERROR", "A device in this mode isn't in your home", {
        recovery: "review",
      });
    for (const input of a.actions) {
      const v = validateAction(d, { ...input, relative: false });
      if (!v.ok) throw new AppError("VALIDATION_ERROR", v.message, { recovery: "review" });
    }
  }
  const row = {
    workspace_id: auth.workspaceId,
    home_id: snap.home.id,
    name: z.string().trim().min(1).max(80).parse(scene.name),
    icon: scene.icon,
    aliases: scene.aliases.slice(0, 12),
    actions: actions as unknown as Json,
  };
  const { data, error } = scene.id
    ? await auth.db
        .from("home_scenes")
        .update(row)
        .eq("id", z.uuid().parse(scene.id))
        .eq("workspace_id", auth.workspaceId)
        .select("*")
        .single()
    : await auth.db.from("home_scenes").insert(row).select("*").single();
  check(error, "save the mode");
  return {
    id: data!.id,
    name: data!.name,
    icon: data!.icon,
    aliases: data!.aliases,
    favorite: data!.favorite,
    actions,
  };
}

export async function deleteHomeScene(auth: AuthContext, id: string) {
  const { error } = await auth.db
    .from("home_scenes")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("workspace_id", auth.workspaceId);
  check(error, "delete the mode");
}

export async function revokeHomeHub(auth: AuthContext, hubId: string) {
  const { error } = await auth.db
    .from("home_hubs")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", z.uuid().parse(hubId))
    .eq("workspace_id", auth.workspaceId);
  check(error, "disconnect the hub");
}

/** ELISE's tools' view of the home (the core port). */
export function homeStore(auth: AuthContext, origin: "ai" | "schedule" = "ai"): HomePort {
  return {
    snapshot: () => homeSnapshot(auth),
    execute: (commands) => executeHomeCommands(auth, commands, origin),
    saveScene: (scene) => saveHomeScene(auth, scene),
    deleteScene: (id) => deleteHomeScene(auth, id),
  };
}

export type { HomeCapability };
