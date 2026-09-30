"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { archiveConversation } from "@/application/conversations-service";
import { archiveVoiceSession } from "@/application/interaction-thread";
import { toPublicError, type PublicError } from "@/core/errors";

export async function deleteConversationAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: PublicError }> {
  try {
    await archiveConversation(await requireAuthContext(), z.uuid().parse(id));
    revalidatePath("/chat");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Deleting a voice session forgets its transcripts, Recall excerpts and workspace. */
export async function deleteVoiceSessionAction(
  id: string,
): Promise<{ ok: true } | { ok: false; error: PublicError }> {
  try {
    await archiveVoiceSession(await requireAuthContext(), z.uuid().parse(id));
    revalidatePath("/chat");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
