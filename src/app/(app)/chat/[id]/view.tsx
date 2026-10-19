"use client";

import { ChatSurface } from "@/features/chat/chat-surface";

import type { ConversationProps } from "./load";

export function View({
  id,
  messages,
  voice,
  timezone,
  workspaceId,
  workspace,
  contexts,
  narration,
}: ConversationProps) {
  return (
    <ChatSurface
      key={id}
      thread={{ kind: "conversation", id }}
      initialMessages={messages}
      voice={voice}
      timezone={timezone}
      workspaceId={workspaceId}
      initialWorkspace={workspace}
      contexts={contexts}
      narration={narration}
    />
  );
}
