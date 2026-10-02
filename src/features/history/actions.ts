"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { archiveConversation } from "@/application/conversations-service";
import { linkThread, unlinkThread } from "@/application/history-links-service";
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

const threadInput = z.object({
  kind: z.enum(["conversation", "session"]),
  id: z.uuid(),
  spaceId: z.uuid(),
});

/** The user tags a conversation with a Space/Section, or removes the tag (ADR-020). */
export async function setThreadLinkAction(
  input: z.input<typeof threadInput> & { linked: boolean },
): Promise<{ ok: true } | { ok: false; error: PublicError }> {
  try {
    const q = threadInput.parse({ kind: input.kind, id: input.id, spaceId: input.spaceId });
    const auth = await requireAuthContext();
    const thread = { kind: q.kind, id: q.id };
    if (input.linked) await linkThread(auth, thread, q.spaceId);
    else await unlinkThread(auth, thread, q.spaceId);
    revalidatePath("/chat");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
