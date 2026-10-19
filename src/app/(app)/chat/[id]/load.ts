import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { contextOptions } from "@/application/contexts-service";
import { loadConversation } from "@/application/conversations-service";
import { liveVoiceEnabled } from "@/application/live-voice-service";
import { openScheduledConversation } from "@/application/scheduled-conversation";
import { loadWorkspace } from "@/application/workspace-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth, { params }) => {
  const id = params.id ?? "";
  if (!z.uuid().safeParse(id).success) notFound();

  // A scheduled run's conversation (ADR-041): its Canvas is rebuilt first if it expired.
  const scheduled = await openScheduledConversation(auth, id).catch(() => null);
  const [messages, workspace, contexts] = await Promise.all([
    loadConversation(auth, id),
    // The Live Workspace survives refreshes and navigation; a failure never blocks the chat.
    loadWorkspace(auth, { kind: "conversation", id }).catch(() => undefined),
    contextOptions(auth),
  ]);
  // Deleted or not this user's: back to a fresh Home, which forgets it if the tab had it open.
  if (!messages) redirect(`/?gone=${id}`);

  return {
    id,
    messages,
    voice: {
      ...auth.profile.voice,
      runtime: liveVoiceEnabled() ? ("live" as const) : ("legacy" as const),
    },
    timezone: auth.profile.timezone,
    workspaceId: auth.workspaceId,
    workspace,
    contexts,
    narration: scheduled ? { text: scheduled.spoken } : null,
  };
}) satisfies RouteLoader<unknown>;

export type ConversationProps = Awaited<ReturnType<typeof load>>;
