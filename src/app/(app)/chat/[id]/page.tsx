import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { loadConversation } from "@/application/conversations-service";
import { ChatSurface } from "@/features/chat/chat-surface";

export default async function ConversationPage({ params }: PageProps<"/chat/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const auth = await requireAuthContext();
  const messages = await loadConversation(auth, id);
  if (!messages) notFound();

  return (
    <ChatSurface
      key={id}
      conversationId={id}
      initialMessages={messages}
      timezone={auth.profile.timezone}
    />
  );
}
