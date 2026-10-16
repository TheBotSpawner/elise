"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { setModuleVisibility } from "@/application/modules-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type ModuleActionResult = { ok: true } | { ok: false; error: PublicError };

/**
 * Shows or hides one module in Mi ELISE (ADR-070), through the one service that decides it. The
 * app re-renders from the server: desktop and phone navigation and Connections agree. Hiding
 * never touches the module's data.
 */
export async function setModuleAction(key: string, enabled: boolean): Promise<ModuleActionResult> {
  try {
    await setModuleVisibility(
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
