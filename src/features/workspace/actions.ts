"use server";

import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import type { ClientToolOutcome } from "@/application/chat-protocol";
import {
  applyUserOp,
  loadSurfaceDetail,
  loadWorkspace,
  presentFromHistory,
  runSurfaceAction,
  type SurfaceDetail,
} from "@/application/workspace-service";
import { toPublicError, type PublicError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import { ACTION_IDS, SURFACE_SIZES, type WorkspaceState } from "@/core/workspace/model";

type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Which interaction: a History conversation or a voice session (ownership checked on use). */
const threadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), id: z.uuid() }).strict(),
  z.object({ kind: z.literal("session"), id: z.uuid() }).strict(),
]);
const id = z.string().min(1).max(120);

export async function getWorkspaceAction(thread: ThreadRef): Promise<Result<WorkspaceState>> {
  return run(async () => loadWorkspace(await requireAuthContext(), threadSchema.parse(thread)));
}

const userOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("focus"), id: id.nullable() }),
  z.object({ op: z.literal("dismiss"), id }),
  z.object({ op: z.literal("resize"), id, size: z.enum(SURFACE_SIZES) }),
  z.object({
    op: z.literal("approval_decided"),
    approvalId: z.uuid(),
    decision: z.enum(["approved", "rejected"]),
  }),
]);

export async function workspaceOpAction(
  thread: ThreadRef,
  op: z.input<typeof userOp>,
): Promise<Result<WorkspaceState>> {
  return run(async () =>
    applyUserOp(await requireAuthContext(), threadSchema.parse(thread), userOp.parse(op)),
  );
}

export async function presentFromHistoryAction(
  thread: ThreadRef,
  messageId: string,
  callId: string,
): Promise<Result<WorkspaceState>> {
  return run(async () =>
    presentFromHistory(
      await requireAuthContext(),
      threadSchema.parse(thread),
      z.uuid().parse(messageId),
      z.string().min(1).max(200).parse(callId),
    ),
  );
}

export async function surfaceActionAction(
  thread: ThreadRef,
  surfaceId: string,
  action: string,
  itemId: string | null,
): Promise<Result<{ state: WorkspaceState; outcome: ClientToolOutcome }>> {
  return run(async () =>
    runSurfaceAction(
      await requireAuthContext(),
      threadSchema.parse(thread),
      id.parse(surfaceId),
      z.enum(ACTION_IDS).parse(action),
      z.string().max(1000).nullable().parse(itemId),
    ),
  );
}

export async function surfaceDetailAction(
  thread: ThreadRef,
  surfaceId: string,
  itemId: string | null,
): Promise<Result<SurfaceDetail>> {
  return run(async () =>
    loadSurfaceDetail(
      await requireAuthContext(),
      threadSchema.parse(thread),
      id.parse(surfaceId),
      z.string().max(1000).nullable().parse(itemId),
    ),
  );
}
