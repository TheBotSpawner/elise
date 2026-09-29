"use server";

import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { discardDraftFromCard, sendDraftFromCard } from "@/application/email-service";
import type { ToolDisplay } from "@/core/agents/tools";
import { toPublicError, type PublicError } from "@/core/errors";

export type DraftActionResult =
  { ok: true; display?: ToolDisplay } | { ok: false; error: PublicError };

const draftId = z.string().min(1).max(1000);

export async function sendDraftAction(id: string, version: string): Promise<DraftActionResult> {
  try {
    const auth = await requireAuthContext();
    const display = await sendDraftFromCard(
      auth,
      draftId.parse(id),
      z.string().max(128).parse(version),
    );
    return { ok: true, display };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

export async function discardDraftAction(id: string): Promise<DraftActionResult> {
  try {
    const auth = await requireAuthContext();
    return { ok: true, display: await discardDraftFromCard(auth, draftId.parse(id)) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
