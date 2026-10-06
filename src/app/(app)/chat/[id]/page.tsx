import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { contextOptions } from "@/application/contexts-service";
import { loadConversation } from "@/application/conversations-service";
import { liveVoiceEnabled } from "@/application/live-voice-service";
import { openScheduledConversation } from "@/application/scheduled-conversation";
import { loadWorkspace } from "@/application/workspace-service";
import { ChatSurface } from "@/features/chat/chat-surface";

export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const auth = await requireAuthContext();
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

  return (
    <ChatSurface
      key={id}
      thread={{ kind: "conversation", id }}
      initialMessages={messages}
      voice={{ ...auth.profile.voice, runtime: liveVoiceEnabled() ? "live" : "legacy" }}
      timezone={auth.profile.timezone}
      workspaceId={auth.workspaceId}
      initialWorkspace={workspace}
      contexts={contexts}
      narration={scheduled ? { text: scheduled.spoken } : null}
    />
  );
}
