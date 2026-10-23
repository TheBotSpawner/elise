import "server-only";

import { z } from "zod";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import {
  estimateTuya,
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
  tuyaConfig,
  tuyaEnabled,
  tuyaRemoteKeys,
  tuyaRemotes,
  tuyaSendAc,
  tuyaSendKey,
  tuyaUserDevices,
} from "@/infrastructure/home/tuya";
import { logger } from "@/infrastructure/observability/logger";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";

/**
 * Smart Life remotes in ELISE Home (ADR-118). The person sets up their TV and air conditioner
 * once in Smart Life; ELISE lists those remotes and controls them through Tuya's cloud — no
 * button is learned again, the home's hub isn't involved in sending.
 *
 * Whose account: during development, the one Smart Life account linked to ELISE's Tuya project
 * in Tuya's console, bound to exactly one workspace by the server's configuration. Nobody else
 * sees it. Every command re-checks that the remote's hub belongs to that account (the device rows
 * are editable by members, so a row alone is never proof).
 */

export type TuyaLinkState =
  | { state: "off" }
  | { state: "not_configured" }
  | { state: "not_linked" }
  | { state: "linked"; region: string };

function linkedUid(auth: Pick<AuthContext, "workspaceId">): string | null {
  const env = serverEnv();
  if (!tuyaConfig() || !env.TUYA_DEV_UID || !env.TUYA_DEV_WORKSPACE_ID) return null;
  return env.TUYA_DEV_WORKSPACE_ID === auth.workspaceId ? env.TUYA_DEV_UID : null;
}

export function tuyaLink(auth: Pick<AuthContext, "workspaceId">): TuyaLinkState {
  if (!tuyaEnabled()) return { state: "off" };
  const c = tuyaConfig();
  if (!c) return { state: "not_configured" };
  return linkedUid(auth) ? { state: "linked", region: c.region } : { state: "not_linked" };
}

function requireUid(auth: Pick<AuthContext, "workspaceId">): string {
  const uid = linkedUid(auth);
  if (!uid)
    throw new AppError("CAPABILITY_UNAVAILABLE", "Smart Life isn't linked to this account", {
      recovery: "configure",
    });
  return uid;
}

const hubsOf = (devices: TuyaDevice[]) => devices.filter((d) => isTuyaIrHub(d.category));

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
    .select("id, provider_key, name, display_name, removed_at, added_at")
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
  /** Another of the person's devices has this name: likely the same one, not imported again. */
  sameAs: string | null;
}

/** The linked account's infrared hubs and the remotes set up on each. */
export async function tuyaOverview(auth: AuthContext) {
  const uid = requireUid(auth);
  const [devices, { rows }] = await Promise.all([tuyaUserDevices(uid), homeRows(auth)]);
  const active = rows.filter((r) => !r.removed_at && r.added_at);
  const hubs = await Promise.all(
    hubsOf(devices).map(async (h) => {
      const remotes = await tuyaRemotes(h.id).catch((e: unknown) => {
        logger.warn("tuya_remotes_failed", { error: e instanceof Error ? e.message : "?" });
        return null;
      });
      return {
        id: h.id,
        name: h.name || "Smart IR",
        online: h.online,
        failed: remotes === null,
        remotes: (remotes ?? []).map((r): TuyaRemoteView => {
          const key = tuyaProviderKey(h.id, r.remote_id);
          const mine = active.find((x) => x.provider_key === key);
          const other = mine
            ? undefined
            : active.find(
                (x) =>
                  !x.provider_key.startsWith(TUYA_KEY_PREFIX) &&
                  [x.name, x.display_name].some((n) => n && sameName(n, r.remote_name)),
              );
          return {
            infraredId: h.id,
            remoteId: r.remote_id,
            name: r.remote_name || r.brand_name || "Control",
            brand: r.brand_name ?? null,
            kind: kindOf(r.category_id),
            deviceId: mine?.id ?? null,
            sameAs: other ? (other.display_name ?? other.name) : null,
          };
        }),
      };
    }),
  );
  return { hubs };
}

const importInput = z
  .array(
    z
      .object({
        infraredId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
        remoteId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
      })
      .strict(),
  )
  .min(1)
  .max(20);

/**
 * The chosen remotes become devices in the person's home, ready (Tuya already knows their keys).
 * Importing one again refreshes its keys; nothing is duplicated.
 */
export async function tuyaImport(auth: AuthContext, raw: unknown) {
  const refs = importInput.parse(raw);
  const uid = requireUid(auth);
  rateLimit(`tuya-import:${auth.workspaceId}`, 10, 60_000);
  const { home, rows } = await homeRows(auth);
  const db = createAdminClient();
  const { data: hub } = home
    ? await db
        .from("home_hubs")
        .select("id")
        .eq("home_id", home.id)
        .eq("workspace_id", auth.workspaceId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };
  // ponytail: rows still hang off the home's hub (hub_id is required); hub-less homes need
  // migration "hub_id nullable" first (ADR-118, pending).
  if (!home || !hub)
    throw new AppError("CAPABILITY_UNAVAILABLE", "ELISE Home isn't set up yet", {
      recovery: "configure",
    });
  const hubs = new Map(hubsOf(await tuyaUserDevices(uid)).map((h) => [h.id, h]));
  const added: {
    id: string;
    name: string;
    infraredId: string;
    remoteId: string;
    test: ReturnType<typeof tuyaTestAction>;
  }[] = [];
  const skipped: { name: string; reason: "not_found" | "no_keys" }[] = [];
  for (const ref of refs) {
    const h = hubs.get(ref.infraredId);
    const remote = h
      ? (await tuyaRemotes(h.id)).find((r) => r.remote_id === ref.remoteId)
      : undefined;
    if (!h || !remote) {
      skipped.push({ name: ref.remoteId, reason: "not_found" });
      continue;
    }
    const cap = remoteCapability(h.id, remote, await tuyaRemoteKeys(h.id, remote.remote_id));
    const name = (remote.remote_name || remote.brand_name || "Control").slice(0, 80);
    if (!cap) {
      skipped.push({ name, reason: "no_keys" });
      continue;
    }
    const key = tuyaProviderKey(h.id, remote.remote_id);
    const prior = rows.find((r) => r.provider_key === key);
    const now = new Date().toISOString();
    const fields = {
      hub_id: hub.id,
      device_type: KIND_TYPE[cap.kind],
      capabilities: [cap] as unknown as Json,
      available: h.online,
      provider_device_id: h.id,
      removed_at: null,
    };
    const { data, error } = prior
      ? await db
          .from("home_devices")
          .update({ ...fields, ...(prior.added_at && !prior.removed_at ? {} : { added_at: now }) })
          .eq("id", prior.id)
          .eq("workspace_id", auth.workspaceId)
          .select("id")
          .single()
      : await db
          .from("home_devices")
          .insert({
            ...fields,
            workspace_id: auth.workspaceId,
            home_id: home.id,
            provider_key: key,
            name,
            state: { estimated: true } as unknown as Json,
            added_at: now,
            state_updated_at: now,
          })
          .select("id")
          .single();
    if (error || !data)
      throw new AppError("INTERNAL_ERROR", "Could not add the device", { cause: error });
    added.push({ id: data.id, name, ...ref, test: tuyaTestAction(cap) });
  }
  logger.info("tuya_import", { added: added.length, skipped: skipped.length });
  return { added, skipped };
}

const tuyaOf = (d: Pick<HomeDevice, "capabilities">) =>
  d.capabilities.find((c): c is TuyaIrCapability => c.type === "tuya_ir");

export const isTuyaDevice = (d: Pick<HomeDevice, "capabilities">) => Boolean(tuyaOf(d));

/**
 * Sends validated actions to Smart Life remotes through Tuya's cloud. The remote's hub must be
 * one of the linked account's (checked against Tuya's own list, every time) and online.
 * Infrared has no feedback: "succeeded" means Tuya accepted and sent it.
 */
export async function executeTuyaCommands(
  auth: AuthContext,
  jobs: { device: HomeDevice; actions: HomeAction[] }[],
): Promise<HomeCommandOutcome[]> {
  const uid = linkedUid(auth);
  const owned = uid ? await tuyaUserDevices(uid).catch(() => null) : null;
  const out: HomeCommandOutcome[] = [];
  for (const { device, actions } of jobs) {
    const cap = tuyaOf(device)!;
    const base = { deviceId: device.id, name: device.name };
    const hub = owned?.find((d) => d.id === cap.infraredId && isTuyaIrHub(d.category));
    if (!owned) {
      out.push({ ...base, status: "offline", error: uid ? "tuya_unreachable" : "tuya_not_linked" });
      continue;
    }
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
        if (a.type === "tuya_ac") {
          await tuyaSendAc({
            ...target,
            power: a.power,
            ...(a.mode ? { mode: a.mode } : {}),
            ...(a.temp !== undefined ? { temp: a.temp } : {}),
            ...(a.fan ? { fan: a.fan } : {}),
          });
        } else if (a.type === "tuya_key")
          for (let i = 0; i < a.repeats; i++)
            await tuyaSendKey({
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
      const code = e instanceof AppError ? e.code : "INTERNAL_ERROR";
      logger.warn("tuya_command_failed", { device_id: device.id, code });
      out.push({ ...base, status: "failed", error: code.toLowerCase() });
    }
  }
  return out;
}
