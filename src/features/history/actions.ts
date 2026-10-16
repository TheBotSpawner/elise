"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { archiveConversation } from "@/application/conversations-service";
import {
  moveThread,
  pinThread,
  renameThread,
  setConversationArchived,
} from "@/application/history-organize-service";
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

// ── Organizing (ADR-070) ─────────────────────────────────────────────────────

const ref = z.object({ kind: z.enum(["conversation", "session"]), id: z.uuid() });
type Result = { ok: true } | { ok: false; error: PublicError };

async function attempt(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    revalidatePath("/chat");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Files a conversation in one Space or Section; null takes it out of every Space. */
export async function moveThreadAction(
  thread: z.input<typeof ref>,
  spaceId: string | null,
): Promise<Result> {
  return attempt(async () =>
    moveThread(
      await requireAuthContext(),
      ref.parse(thread),
      spaceId === null ? null : z.uuid().parse(spaceId),
    ),
  );
}

export async function renameThreadAction(
  thread: z.input<typeof ref>,
  title: string,
): Promise<Result> {
  return attempt(async () =>
    renameThread(
      await requireAuthContext(),
      ref.parse(thread),
      z.string().trim().min(1).max(120).parse(title),
    ),
  );
}

export async function pinThreadAction(
  thread: z.input<typeof ref>,
  pinned: boolean,
): Promise<Result> {
  return attempt(async () =>
    pinThread(await requireAuthContext(), ref.parse(thread), z.boolean().parse(pinned)),
  );
}

export async function archiveConversationAction(id: string, archived: boolean): Promise<Result> {
  return attempt(async () =>
    setConversationArchived(
      await requireAuthContext(),
      z.uuid().parse(id),
      z.boolean().parse(archived),
    ),
  );
}
