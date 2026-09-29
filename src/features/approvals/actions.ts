"use server";

import { z } from "zod";

import { resolveApproval } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import type { ToolDisplay } from "@/core/agents/tools";
import { toPublicError, type PublicError } from "@/core/errors";

export type ApprovalResult =
  | { ok: true; decision: "approved" | "rejected"; display?: ToolDisplay }
  | { ok: false; error: PublicError };

export async function decideApproval(
  approvalId: string,
  decision: "approved" | "rejected",
): Promise<ApprovalResult> {
  try {
    const id = z.uuid().parse(approvalId);
    const auth = await requireAuthContext();
    const outcome = await resolveApproval(auth, id, decision);
    if (outcome && outcome.status === "failed") return { ok: false, error: outcome.error };
    return {
      ok: true,
      decision,
      display: outcome?.status === "succeeded" ? outcome.display : undefined,
    };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}
