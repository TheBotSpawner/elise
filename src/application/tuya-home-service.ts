import "server-only";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  estimateTuya,
  homeCapabilitySchema,
  type HomeAction,
  type HomeCommandOutcome,
  type HomeDevice,
  type HomeState,
  type TuyaIrCapability,
} from "@/core/home/model";
import {
  isTuyaIrHub,
  KIND_TYPE,
  kindOf,
  remoteCapability,
  sameName,
  TUYA_KEY_PREFIX,
  tuyaProviderKey,
  tuyaTestAction,
  type TuyaDevice,
} from "@/core/home/tuya";
import {
  tuyaRemoteKeys,
  tuyaRemotes,
  tuyaSendAc,
  tuyaSendKey,
  tuyaUserDevices,
  type TuyaAuth,
} from "@/infrastructure/home/tuya";
import { logger } from "@/infrastructure/observability/logger";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import {
  tuyaAuthFor,
  tuyaConnection,
  tuyaConnections,
  type TuyaConnection,
} from "./tuya-connection-service";

/**
 * Smart Life remotes in ELISE Home (ADR-118, ADR-119). Each person connects their own Tuya
 * account; ELISE lists the remotes they already set up in Smart Life and controls them through
 * Tuya's cloud with THEIR token — no button learned again, no ELISE Home hub needed.
 *
 * Nothing a client sends is trusted: the connection is looked up in this workspace, the account's
 * uid comes from ELISE's own record of it, and every hub and remote is checked against Tuya's
 * answer for that account's token before anything is read or sent.
 */

type AccountAuth = ReturnType<typeof tuyaAuthFor>;

const hubsOf = (devices: TuyaDevice[]) => devices.filter((d) => isTuyaIrHub(d.category));
const ownKeyPrefix = (connectionId: string) => `${TUYA_KEY_PREFIX}${connectionId}:`;

async function homeRows(auth: AuthContext) {
  const { data: home } = await auth.db
    .from("homes")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!home) return { home: null, rows: [] };
  const { data, error } = await auth.db
    .from("home_devices")
    .select("id, provider_key, name, display_name, removed_at, added_at, hidden, capabilities")
    .eq("home_id", home.id)
    .eq("workspace_id", auth.workspaceId);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not load the home", { cause: error });
  return { home, rows: data ?? [] };
}

export interface TuyaRemoteView {
  infraredId: string;
  remoteId: string;
  name: string;
  brand: string | null;
  kind: ReturnType<typeof kindOf>;
  /** Already in the person's home (its device id). */
  deviceId: string | null;
  /** Another of the person's devices has this name (the engine's TV, a Broadlink remote…). */
  sameAs: { id: string; name: string } | null;
}

export interface TuyaHubView {
  id: string;
  name: string;
  online: boolean;
  failed: boolean;
  remotes: TuyaRemoteView[];
}

async function clearProblem(auth: AuthContext, c: TuyaConnection) {
  await createAdminClient()
    .from("provider_connections")
    .update({
      last_error_code: null,
      status: "connected",
      last_health_check_at: new Date().toISOString(),
    })
    .eq("id", c.id)
    .eq("workspace_id", auth.workspaceId);
}

/** One connection's infrared hubs and the remotes set up on each (fresh from Tuya). */
export async function tuyaOverview(auth: AuthContext, connectionId: unknown) {
  const c = await tuyaConnection(auth, connectionId);
  const tuya = tuyaAuthFor(auth.workspaceId, c);
  try {
    const [devices, { rows }] = await Promise.all([
      tuyaUserDevices(tuya, c.uid, true),
      homeRows(auth),
    ]);
    const active = rows.filter((r) => !r.removed_at && r.added_at && !r.hidden);
    const hubs: TuyaHubView[] = await Promise.all(
      hubsOf(devices).map(async (h) => {
        const remotes = await tuyaRemotes(tuya, h.id, true).catch(async (e: unknown) => {
          await tuya.reportProblem(e);
          return null;
        });
        return {
          id: h.id,
          name: h.name || "Smart IR",
          online: h.online,
          failed: remotes === null,
          remotes: (remotes ?? []).map((r): TuyaRemoteView => {
            const key = tuyaProviderKey(c.id, h.id, r.remote_id);
            const mine = active.find((x) => x.provider_key === key);
            const other = mine
              ? undefined
              : active.find(
                  (x) =>
                    !x.provider_key.startsWith(ownKeyPrefix(c.id)) &&
                    [x.name, x.display_name].some((n) => n && sameName(n, r.remote_name)),
                );
            return {
              infraredId: h.id,
              remoteId: r.remote_id,
              name: r.remote_name || r.brand_name || "Control",
              brand: r.brand_name ?? null,
              kind: kindOf(r.category_id),
              deviceId: mine?.id ?? null,
              sameAs: other ? { id: other.id, name: other.display_name ?? other.name } : null,
            };
          }),
        };
      }),
    );
    if (hubs.every((h) => !h.failed)) await clearProblem(auth, c);
    // Devices this adapter doesn't control yet are counted, never pretended.
    return { hubs, otherDevices: devices.length - hubsOf(devices).length };
  } catch (e) {
    await tuya.reportProblem(e);
    throw e;
  }
}

const importInput = z
  .object({
    connectionId: z.uuid(),
    remotes: z
      .array(
        z
          .object({
            infraredId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
            remoteId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
            roomId: z.uuid().nullable().optional(),
            /** "Usar Smart Life": that other device (same name) leaves the person's list. */
            replaces: z.uuid().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/**
 * The chosen remotes become devices in the person's home, ready (Tuya already knows their keys).
 * Importing one again refreshes its keys; its alias and room stay the person's.
 */
export async function tuyaImport(auth: AuthContext, raw: unknown) {
  const input = importInput.parse(raw);
  rateLimit(`tuya-import:${auth.workspaceId}`, 10, 60_000);
  const c = await tuyaConnection(auth, input.connectionId);
  if (c.status !== "connected")
    throw new AppError("PERMISSION_DENIED", "Reconnect Smart Life first", {
      recovery: "configure",
    });
  const tuya = tuyaAuthFor(auth.workspaceId, c);
  const { ensureHome } = await import("./home-service");
  const home = await ensureHome(auth);
  const { rows } = await homeRows(auth);
  const db = createAdminClient();
  const { data: hubRow } = await db
    .from("home_hubs")
    .select("id")
    .eq("home_id", home.id)
    .eq("workspace_id", auth.workspaceId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { data: rooms } = await auth.db
    .from("home_rooms")
    .select("id")
    .eq("home_id", home.id)
    .eq("workspace_id", auth.workspaceId);
  const roomIds = new Set((rooms ?? []).map((r) => r.id));
  const hubs = new Map(hubsOf(await tuyaUserDevices(tuya, c.uid)).map((h) => [h.id, h]));
  const added: {
    id: string;
    name: string;
    infraredId: string;
    remoteId: string;
    test: ReturnType<typeof tuyaTestAction>;
  }[] = [];
  const skipped: { remoteId: string; reason: "not_found" | "no_keys" }[] = [];
  for (const ref of input.remotes) {
    const h = hubs.get(ref.infraredId);
    const remote = h
      ? (await tuyaRemotes(tuya, h.id)).find((r) => r.remote_id === ref.remoteId)
      : undefined;
    if (!h || !remote) {
      skipped.push({ remoteId: ref.remoteId, reason: "not_found" });
      continue;
    }
    const cap = remoteCapability(
      c.id,
      h.id,
      remote,
      await tuyaRemoteKeys(tuya, h.id, remote.remote_id),
    );
    const name = (remote.remote_name || remote.brand_name || "Control").slice(0, 80);
    if (!cap) {
      skipped.push({ remoteId: ref.remoteId, reason: "no_keys" });
      continue;
    }
    const key = tuyaProviderKey(c.id, h.id, remote.remote_id);
    const prior = rows.find((r) => r.provider_key === key);
    const now = new Date().toISOString();
    const room = ref.roomId && roomIds.has(ref.roomId) ? ref.roomId : null;
    const fields = {
      device_type: KIND_TYPE[cap.kind],
      capabilities: [cap] as unknown as Json,
      available: h.online,
      provider_device_id: h.id,
      removed_at: null,
      hidden: false,
      ...(room ? { room_id: room, room_override: true } : {}),
    };
    let id: string;
    if (prior) {
      const { error } = await db
        .from("home_devices")
        .update({ ...fields, ...(prior.added_at && !prior.removed_at ? {} : { added_at: now }) })
        .eq("id", prior.id)
        .eq("workspace_id", auth.workspaceId);
      if (error) throw new AppError("INTERNAL_ERROR", "Could not add the device", { cause: error });
      id = prior.id;
    } else {
      const row = {
        ...fields,
        workspace_id: auth.workspaceId,
        home_id: home.id,
        provider_key: key,
        name,
        state: { estimated: true } as unknown as Json,
        added_at: now,
        state_updated_at: now,
      };
      // Cloud devices need no hub (migration 067). Before it, they hang off the home's hub.
      let r = await db
        .from("home_devices")
        .insert({ ...row, hub_id: null })
        .select("id")
        .single();
      if (r.error?.code === "23502" && hubRow)
        r = await db
          .from("home_devices")
          .insert({ ...row, hub_id: hubRow.id })
          .select("id")
          .single();
      if (r.error?.code === "23502")
        throw new AppError(
          "CAPABILITY_UNAVAILABLE",
          "ELISE Home needs the latest database update",
          {
            recovery: "review",
          },
        );
      if (r.error || !r.data)
        throw new AppError("INTERNAL_ERROR", "Could not add the device", { cause: r.error });
      id = r.data.id;
    }
    if (ref.replaces) {
      const other = rows.find(
        (r) => r.id === ref.replaces && !r.provider_key.startsWith(TUYA_KEY_PREFIX),
      );
      if (other)
        await auth.db
          .from("home_devices")
          .update({ hidden: true })
          .eq("id", other.id)
          .eq("workspace_id", auth.workspaceId);
    }
    added.push({
      id,
      name,
      infraredId: h.id,
      remoteId: remote.remote_id,
      test: tuyaTestAction(cap),
    });
  }
  logger.info("tuya_import", { added: added.length, skipped: skipped.length });
  return { added, skipped };
}

/**
 * Brings imported remotes in line with Smart Life: renamed ones get the new name (the person's
 * alias stays), changed keys are refreshed, deleted ones leave the home, hubs' online state is
 * updated. Never adds anything by itself.
 */
export async function syncTuya(auth: AuthContext, connectionId: unknown) {
  const c = await tuyaConnection(auth, connectionId);
  const tuya = tuyaAuthFor(auth.workspaceId, c);
  const { rows } = await homeRows(auth);
  const mine = rows.filter((r) => r.provider_key.startsWith(ownKeyPrefix(c.id)) && !r.removed_at);
  const db = createAdminClient();
  let updated = 0;
  let removed = 0;
  try {
    if (mine.length) {
      const hubs = new Map(hubsOf(await tuyaUserDevices(tuya, c.uid, true)).map((h) => [h.id, h]));
      for (const row of mine) {
        const cap = z
          .array(homeCapabilitySchema)
          .catch([])
          .parse(row.capabilities)
          .find((x): x is TuyaIrCapability => x.type === "tuya_ir");
        const h = cap ? hubs.get(cap.infraredId) : undefined;
        const remote =
          cap && h
            ? (await tuyaRemotes(tuya, h.id, true)).find((r) => r.remote_id === cap.remoteId)
            : undefined;
        if (!cap || !h || !remote) {
          await db
            .from("home_devices")
            .update({ removed_at: new Date().toISOString(), available: false })
            .eq("id", row.id)
            .eq("workspace_id", auth.workspaceId);
          removed++;
          continue;
        }
        const next = remoteCapability(
          c.id,
          h.id,
          remote,
          await tuyaRemoteKeys(tuya, h.id, remote.remote_id),
        );
        await db
          .from("home_devices")
          .update({
            name: (remote.remote_name || row.name).slice(0, 120),
            available: h.online,
            ...(next
              ? { capabilities: [next] as unknown as Json, device_type: KIND_TYPE[next.kind] }
              : {}),
          })
          .eq("id", row.id)
          .eq("workspace_id", auth.workspaceId);
        updated++;
      }
    }
    await clearProblem(auth, c);
    return { updated, removed };
  } catch (e) {
    await tuya.reportProblem(e);
    throw e;
  }
}

const SYNC_EVERY_MS = 6 * 60 * 60_000;

/** Moderate background sync: each connection at most every 6 h, from Hogar's own load. */
export async function syncTuyaIfDue(auth: AuthContext) {
  const { data } = await auth.db
    .from("provider_connections")
    .select("id, last_health_check_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("provider_key", "tuya")
    .eq("status", "connected");
  for (const c of data ?? [])
    if (
      !c.last_health_check_at ||
      Date.now() - new Date(c.last_health_check_at).getTime() > SYNC_EVERY_MS
    )
      await syncTuya(auth, c.id).catch(() => undefined);
}

const tuyaOf = (d: Pick<HomeDevice, "capabilities">) =>
  d.capabilities.find((c): c is TuyaIrCapability => c.type === "tuya_ir");

export const isTuyaDevice = (d: Pick<HomeDevice, "capabilities">) => Boolean(tuyaOf(d));

/**
 * Sends validated actions to Smart Life remotes through Tuya's cloud with the owner's token.
 * The connection must be this workspace's and connected; the remote's hub must be in THAT
 * account (Tuya's own list) and online. Infrared has no feedback: "succeeded" means Tuya
 * accepted and sent it.
 */
export async function executeTuyaCommands(
  auth: AuthContext,
  jobs: { device: HomeDevice; actions: HomeAction[] }[],
): Promise<HomeCommandOutcome[]> {
  const connections = await tuyaConnections(auth).catch(() => [] as TuyaConnection[]);
  const accounts = new Map<string, { tuya: AccountAuth; devices: TuyaDevice[] | null }>();
  const out: HomeCommandOutcome[] = [];
  for (const { device, actions } of jobs) {
    const cap = tuyaOf(device)!;
    const base = { deviceId: device.id, name: device.name };
    const c = connections.find((x) => x.id === cap.connectionId);
    if (!c || c.status !== "connected") {
      out.push({
        ...base,
        status: "unavailable",
        error: c ? "tuya_reconnect" : "tuya_not_linked",
      });
      continue;
    }
    let account = accounts.get(c.id);
    if (!account) {
      const tuya = tuyaAuthFor(auth.workspaceId, c);
      const devices = await tuyaUserDevices(tuya, c.uid).catch(async (e: unknown) => {
        await tuya.reportProblem(e);
        return null;
      });
      account = { tuya, devices };
      accounts.set(c.id, account);
    }
    if (!account.devices) {
      out.push({ ...base, status: "offline", error: "tuya_unreachable" });
      continue;
    }
    const hub = account.devices.find((d) => d.id === cap.infraredId && isTuyaIrHub(d.category));
    if (!hub) {
      logger.warn("tuya_not_owned", { device_id: device.id });
      out.push({ ...base, status: "unavailable", error: "tuya_not_linked" });
      continue;
    }
    if (!hub.online) {
      out.push({ ...base, status: "unavailable" });
      continue;
    }
    try {
      rateLimit(`tuya-send:${auth.workspaceId}`, 40, 60_000);
      const target = {
        infraredId: cap.infraredId,
        remoteId: cap.remoteId,
        categoryId: cap.categoryId,
        ...(cap.remoteIndex !== undefined ? { remoteIndex: cap.remoteIndex } : {}),
      };
      let state: HomeState = device.state;
      const at = new Date().toISOString();
      for (const a of actions) {
        if (a.type === "tuya_ac")
          await tuyaSendAc(account.tuya, {
            ...target,
            power: a.power,
            ...(a.mode ? { mode: a.mode } : {}),
            ...(a.temp !== undefined ? { temp: a.temp } : {}),
            ...(a.fan ? { fan: a.fan } : {}),
          });
        else if (a.type === "tuya_key")
          for (let i = 0; i < a.repeats; i++)
            await tuyaSendKey(account.tuya, {
              ...target,
              key: a.tuya,
              ...(a.keyId !== undefined ? { keyId: a.keyId } : {}),
            });
        else continue;
        state = estimateTuya(state, a, at);
      }
      await auth.db
        .from("home_devices")
        .update({ state: state as unknown as Json, state_updated_at: at })
        .eq("id", device.id)
        .eq("workspace_id", auth.workspaceId);
      out.push({ ...base, status: "succeeded", state });
    } catch (e) {
      await account.tuya.reportProblem(e);
      const code = e instanceof AppError ? e.code : "INTERNAL_ERROR";
      logger.warn("tuya_command_failed", { device_id: device.id, code });
      out.push({ ...base, status: "failed", error: code.toLowerCase() });
    }
  }
  return out;
}

export type { TuyaAuth };
