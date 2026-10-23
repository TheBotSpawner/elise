import * as cloud from "rpc-stub:features/home/actions";

import { toPublicError } from "@/core/errors";
import type { HomeActionInput, HomeCommandOutcome } from "@/core/home/model";
import type { HomeResult } from "@/features/home/actions";

import { localHome } from "../local-home";
import { CloudUnavailableError } from "../rpc";

/**
 * Hogar's actions on Desktop (ADR-081): the same Cloud actions as the web — and when ELISE Cloud
 * is unreachable, a device control goes to the local runtime instead (validated there against
 * the same canonical model). Everything else needs the cloud and says so.
 */
export const {
  adoptNewDevicesAction,
  runSceneAction,
  updateDeviceAction,
  removeDeviceAction,
  createRoomAction,
  saveSceneAction,
  deleteSceneAction,
  createPairingCodeAction,
  revokeHubAction,
  createIrDeviceAction,
  irCommandAction,
  irProfilesAction,
  applyIrProfileAction,
} = cloud as typeof import("@/features/home/actions");

const remote = cloud as typeof import("@/features/home/actions");

export async function controlDeviceAction(
  deviceId: string,
  raw: unknown,
): Promise<HomeResult<HomeCommandOutcome[]>> {
  if (!localHome.cloudDown()) {
    try {
      return await remote.controlDeviceAction(deviceId, raw);
    } catch (error) {
      if (!(error instanceof CloudUnavailableError))
        return { ok: false, error: toPublicError(error) };
    }
  }
  const target = localHome.device(deviceId);
  if (!target) return { ok: false, error: toPublicError(new CloudUnavailableError()) };
  const r = await window.eliseDesktop!.executeLocalHome({
    providerKey: target.providerKey,
    actions: raw as HomeActionInput[],
  });
  if (!r.ok) return { ok: false, error: toPublicError(new Error(r.error)) };
  localHome.applied(deviceId, r.state);
  return {
    ok: true,
    value: [
      {
        deviceId,
        name: target.name,
        status: "succeeded",
        ...(r.state ? { state: r.state as HomeCommandOutcome["state"] } : {}),
      },
    ],
  };
}
