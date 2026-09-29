/**
 * Wire protocol between POST /api/chat and the browser: newline-delimited JSON events.
 * Shared by server and client; contains no server-only code.
 */
import type { ApprovalReason } from "@/core/agents/policy";
import type { ToolDisplay } from "@/core/agents/tools";
import type { PublicError } from "@/core/errors";

/** Tool outcome as the UI needs it (model-facing output stripped). */
export type ClientToolOutcome =
  | { status: "succeeded"; display?: ToolDisplay }
  | {
      status: "approval_required";
      approvalId: string;
      summary: string;
      reason: ApprovalReason;
      /** Exactly what will happen (e.g. the email that will be sent). */
      preview?: ToolDisplay;
    }
  | { status: "clarification_required" }
  | { status: "rejected" }
  | { status: "failed"; error: PublicError };

export interface ClientToolTrace {
  callId: string;
  name: string;
  outcome?: ClientToolOutcome;
  /** Wall time of the step, measured server-side. */
  durationMs?: number;
  /** Set once an approval requested by this step was decided. */
  resolution?: { decision: "approved" | "rejected"; display?: ToolDisplay };
}

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string; runId: string }
  | { type: "status"; state: "thinking" | "using_tools" }
  | { type: "text"; delta: string }
  | { type: "tool_started"; callId: string; name: string }
  | {
      type: "tool_finished";
      callId: string;
      name: string;
      outcome: ClientToolOutcome;
      durationMs: number;
    }
  | { type: "done"; messageId: string | null }
  | { type: "error"; error: PublicError };

/** Stored in messages.metadata for assistant messages so history re-renders cards. */
export interface AssistantMessageMetadata {
  tools?: ClientToolTrace[];
  toolNotes?: string[];
  error?: PublicError;
}
