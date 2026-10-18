"use server";

import { requireAuthContext } from "@/application/auth-context";
import { createDesktopAuthCode } from "@/application/desktop-service";
import { toPublicError, type PublicError } from "@/core/errors";

/** The person approves ELISE Desktop from their own signed-in browser (ADR-081). */
export async function approveDesktopConnect(
  request: unknown,
): Promise<{ ok: true; redirect: string } | { ok: false; error: PublicError }> {
  try {
    const { redirect } = await createDesktopAuthCode(await requireAuthContext(), request);
    return { ok: true, redirect };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
