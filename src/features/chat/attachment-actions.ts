"use server";

import { z } from "zod";

import {
  completeAttachment,
  removeAttachment,
  stageAttachments,
  type StagedUpload,
} from "@/application/attachments-service";
import { requireAuthContext } from "@/application/auth-context";
import { toPublicError, type PublicError } from "@/core/errors";

export type AttachmentResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<AttachmentResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const file = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0) });

/** Draft attachments (ADR-031): staging only — nothing is sent or kept in Knowledge here. */
export async function stageAttachmentsAction(
  files: { name: string; size: number }[],
): Promise<AttachmentResult<StagedUpload[]>> {
  return run(async () =>
    stageAttachments(await requireAuthContext(), z.array(file).max(20).parse(files)),
  );
}

export async function completeAttachmentAction(id: string) {
  return run(async () => completeAttachment(await requireAuthContext(), z.uuid().parse(id)));
}

export async function removeAttachmentAction(id: string) {
  return run(async () => removeAttachment(await requireAuthContext(), z.uuid().parse(id)));
}
