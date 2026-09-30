import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { loadConversation } from "@/application/conversations-service";
import { loadWorkspace } from "@/application/workspace-service";
import { ChatSurface } from "@/features/chat/chat-surface";

export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const auth = await requireAuthContext();
  const [messages, workspace] = await Promise.all([
    loadConversation(auth, id),
    // The Live Workspace survives refreshes and navigation; a failure never blocks the chat.
    loadWorkspace(auth, { kind: "conversation", id }).catch(() => undefined),
  ]);
  if (!messages) notFound();

  return (
    <ChatSurface
      key={id}
      thread={{ kind: "conversation", id }}
      initialMessages={messages}
      voice={auth.profile.voice}
      timezone={auth.profile.timezone}
      workspaceId={auth.workspaceId}
      initialWorkspace={workspace}
    />
  );
}
