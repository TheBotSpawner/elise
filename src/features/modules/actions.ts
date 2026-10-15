"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { setModules } from "@/application/modules-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type ModuleActionResult = { ok: true } | { ok: false; error: PublicError };

/**
 * Turns one Mi ELISE module on or off (ADR-064), through the one service that decides module
 * state. The whole app re-renders from the server: navigation, guards and Connections agree.
 */
export async function setModuleAction(key: string, enabled: boolean): Promise<ModuleActionResult> {
  try {
    await setModules(
      await requireAuthContext(),
      { [z.string().max(40).parse(key)]: z.boolean().parse(enabled) },
      "user_ui",
    );
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
