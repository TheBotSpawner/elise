import type { ClientToolTrace } from "@/application/chat-protocol";
import type { PublicError } from "@/core/errors";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** A spoken turn (its transcript is the content). */
  modality?: "text" | "voice";
  content: string;
  tools: ClientToolTrace[];
  error?: PublicError;
  createdAt: string;
  /** Created in this session (animates in); history loaded from the server does not. */
  fresh?: boolean;
  /** True while the assistant response is streaming. */
  streaming?: boolean;
  /** Stored message id, once persisted (history loads with it; live turns get it on "done"). */
  serverId?: string;
}
