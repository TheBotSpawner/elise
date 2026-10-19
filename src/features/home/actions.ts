"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  createHomeRoom,
  createPairingCode,
  deleteHomeScene,
  executeHomeCommands,
  homeSnapshot,
  revokeHomeHub,
  saveHomeScene,
  removeHomeDevice,
  updateHomeDevice,
} from "@/application/home-service";
import { AppError, toPublicError, type PublicError } from "@/core/errors";
import {
  homeActionInputSchema,
  homeSceneActionSchema,
  validateAction,
  type HomeAction,
  type HomeCommandOutcome,
} from "@/core/home/model";

export type HomeResult<T = null> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<HomeResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise/home");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** The screen's controls: the same validation as ELISE's tools before anything is sent. */
export async function controlDeviceAction(deviceId: string, raw: unknown) {
  return run(async (): Promise<HomeCommandOutcome[]> => {
    const auth = await requireAuthContext();
    const inputs = z.array(homeActionInputSchema).min(1).max(6).parse(raw);
    const snap = await homeSnapshot(auth, { includeHidden: true });
    const device = snap.devices.find((d) => d.id === z.uuid().parse(deviceId));
    if (!device) throw new AppError("NOT_FOUND", "That device isn't in your home");
    const actions: HomeAction[] = [];
    for (const input of inputs) {
      const v = validateAction(device, input);
      if (!v.ok) throw new AppError("VALIDATION_ERROR", v.message, { recovery: "review" });
      actions.push(v.action);
    }
    return executeHomeCommands(auth, [{ deviceId: device.id, actions }], "user_ui");
  });
}

export async function runSceneAction(sceneId: string) {
  return run(async (): Promise<HomeCommandOutcome[]> => {
    const auth = await requireAuthContext();
    const snap = await homeSnapshot(auth, { includeHidden: true });
    const scene = snap.scenes.find((s) => s.id === z.uuid().parse(sceneId));
    if (!scene) throw new AppError("NOT_FOUND", "Mode not found");
    const byId = new Map(snap.devices.map((d) => [d.id, d]));
    const commands = scene.actions.flatMap((a) => {
      const d = byId.get(a.deviceId);
      if (!d) return [];
      const actions = a.actions
        .map((x) => validateAction(d, x))
        .flatMap((v) => (v.ok ? [v.action] : []));
      return actions.length ? [{ deviceId: d.id, actions }] : [];
    });
    return commands.length ? executeHomeCommands(auth, commands, "user_ui") : [];
  });
}

export async function updateDeviceAction(deviceId: string, patch: unknown) {
  return run(async () => updateHomeDevice(await requireAuthContext(), deviceId, patch));
}

export async function removeDeviceAction(deviceId: string) {
  return run(async () => removeHomeDevice(await requireAuthContext(), deviceId));
}

export async function createRoomAction(name: string) {
  return run(async () => createHomeRoom(await requireAuthContext(), name));
}

const sceneInput = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(80),
    icon: z.string().max(16).nullable().default(null),
    actions: z.array(homeSceneActionSchema).max(30),
  })
  .strict();

export async function saveSceneAction(raw: unknown) {
  return run(async () => {
    const s = sceneInput.parse(raw);
    return saveHomeScene(await requireAuthContext(), { ...s, aliases: [] });
  });
}

export async function deleteSceneAction(id: string) {
  return run(async () => deleteHomeScene(await requireAuthContext(), id));
}

/** For the development hub agent (and future ELISE hardware): a one-time code. */
export async function createPairingCodeAction() {
  return run(async () => createPairingCode(await requireAuthContext()));
}

export async function revokeHubAction(hubId: string) {
  return run(async () => revokeHomeHub(await requireAuthContext(), hubId));
}
