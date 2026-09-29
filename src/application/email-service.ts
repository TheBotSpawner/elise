import "server-only";

import type { ToolDisplay } from "@/core/agents/tools";

import type { AuthContext } from "./auth-context";
import { runUserTool } from "./elise";

/**
 * Draft card actions. Clicking Send on the card that shows the exact email is the user's
 * approval of that version: the send is pinned to it and fails if the draft changed since.
 */
export async function sendDraftFromCard(
  auth: AuthContext,
  draftId: string,
  version: string,
): Promise<ToolDisplay | undefined> {
  const outcome = await runUserTool(
    auth,
    "email.sendDraft",
    { draftId, version },
    `send:${draftId}:${version}`,
  );
  return outcome.display;
}

export async function discardDraftFromCard(
  auth: AuthContext,
  draftId: string,
): Promise<ToolDisplay | undefined> {
  return (await runUserTool(auth, "email.discardDraft", { draftId })).display;
}
