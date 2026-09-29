import type { ClientToolTrace } from "@/application/chat-protocol";
import type { PublicError } from "@/core/errors";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: ClientToolTrace[];
  error?: PublicError;
  /** True while the assistant response is streaming. */
  streaming?: boolean;
}
