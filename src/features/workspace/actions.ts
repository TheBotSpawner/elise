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
import { ACTION_IDS, SURFACE_SIZES, type WorkspaceState } from "@/core/workspace/model";

type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const conversation = z.uuid();
const id = z.string().min(1).max(120);

export async function getWorkspaceAction(conversationId: string): Promise<Result<WorkspaceState>> {
  return run(async () =>
    loadWorkspace(await requireAuthContext(), conversation.parse(conversationId)),
  );
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
  conversationId: string,
  op: z.input<typeof userOp>,
): Promise<Result<WorkspaceState>> {
  return run(async () =>
    applyUserOp(await requireAuthContext(), conversation.parse(conversationId), userOp.parse(op)),
  );
}

export async function presentFromHistoryAction(
  conversationId: string,
  messageId: string,
  callId: string,
): Promise<Result<WorkspaceState>> {
  return run(async () =>
    presentFromHistory(
      await requireAuthContext(),
      conversation.parse(conversationId),
      z.uuid().parse(messageId),
      z.string().min(1).max(200).parse(callId),
    ),
  );
}

export async function surfaceActionAction(
  conversationId: string,
  surfaceId: string,
  action: string,
  itemId: string | null,
): Promise<Result<{ state: WorkspaceState; outcome: ClientToolOutcome }>> {
  return run(async () =>
    runSurfaceAction(
      await requireAuthContext(),
      conversation.parse(conversationId),
      id.parse(surfaceId),
      z.enum(ACTION_IDS).parse(action),
      z.string().max(1000).nullable().parse(itemId),
    ),
  );
}

export async function surfaceDetailAction(
  conversationId: string,
  surfaceId: string,
  itemId: string | null,
): Promise<Result<SurfaceDetail>> {
  return run(async () =>
    loadSurfaceDetail(
      await requireAuthContext(),
      conversation.parse(conversationId),
      id.parse(surfaceId),
      z.string().max(1000).nullable().parse(itemId),
    ),
  );
}
