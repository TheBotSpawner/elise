import "server-only";

import type { ToolCallOutcome } from "@/core/agents/executor";
import { toolNotes } from "@/core/agents/runtime";
import type { BriefPresentItem } from "@/core/briefs/canvas";
import { AppError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import { presentOps } from "@/core/workspace/from-results";
import { emptyWorkspace, type SurfaceDraft } from "@/core/workspace/model";
import { logger } from "@/infrastructure/observability/logger";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import type { AssistantMessageMetadata, ClientToolTrace } from "./chat-protocol";
import { toClientOutcome, WorkspaceSession } from "./workspace-service";

/**
 * Scheduled conversations (ADR-041): a scheduled run is an ELISE-initiated conversation. The run
 * creates a normal conversation, presents its results as normal Surfaces in that conversation's
 * Live Workspace, and says its synthesis as ELISE's first message. From then on it is just a
 * conversation: the same Canvas, the same follow-ups, the same voice, the same History.
 */

export interface ScheduledPresentation {
  items: BriefPresentItem[];
  focus: SurfaceDraft | null;
}

const succeeded = (item: BriefPresentItem): ToolCallOutcome => ({
  status: "succeeded",
  output: null,
  display: item.display,
  actionId: null,
  providerLabel: "elise",
});

/**
 * Presents a briefing's Surfaces through the canonical path: each read keeps its query, so the
 * Canvas refreshes and reconciles it after writes like any read of a conversation. Used by the
 * scheduled run, by "my brief now" in chat, and to rebuild an expired scheduled Canvas.
 */
export function presentBriefing(
  session: WorkspaceSession,
  p: ScheduledPresentation,
): ClientToolTrace[] {
  const at = new Date().toISOString();
  if (p.focus)
    session.apply(presentOps([{ ...p.focus, intentId: session.state().intent?.id ?? null }], at));
  return p.items.map((item) => {
    const outcome = succeeded(item);
    const surfaceIds = session.present(
      item.tool,
      item.callId,
      outcome,
      { tool: item.tool, args: item.args },
      null,
      item.priority,
    );
    return {
      callId: item.callId,
      name: item.tool,
      outcome: toClientOutcome(outcome),
      durationMs: 0,
      ...(surfaceIds.length ? { surfaceIds } : {}),
    };
  });
}

/**
 * The run's conversation: created once per run (a retried run reopens it), with its Canvas
 * presented and ELISE's opening message. Returns the conversation id.
 */
export async function createScheduledConversation(
  auth: AuthContext,
  input: {
    scheduleId: string;
    runId: string;
    /** "Morning Brief — 5 oct" */
    title: string;
    name: string;
    spoken: string;
    presentation: ScheduledPresentation;
  },
): Promise<string> {
  const { data: existing } = await auth.db
    .from("conversations")
    .select("id")
    .eq("schedule_run_id", input.runId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: conversation, error } = await auth.db
    .from("conversations")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      title: input.title.slice(0, 200),
      origin: "scheduled",
      schedule_id: input.scheduleId,
      schedule_run_id: input.runId,
    })
    .select("id")
    .single();
  if (error || !conversation)
    throw new AppError("INTERNAL_ERROR", "Could not open the scheduled conversation", {
      cause: error,
    });
  const thread: ThreadRef = { kind: "conversation", id: conversation.id };
  const at = new Date().toISOString();
  const session = new WorkspaceSession(auth, thread, emptyWorkspace());
  session.apply([
    {
      op: "intent",
      intent: {
        id: `intent:scheduled:${input.runId}`,
        kind: "planning",
        description: input.title.slice(0, 160),
        startedAt: at,
      },
      at,
    },
  ]);
  const tools = presentBriefing(session, input.presentation);
  await session.flush();
  const metadata: AssistantMessageMetadata = {
    tools,
    // Later turns know what is on screen ("ese mail", "la primera tarea") by its ids.
    toolNotes: toolNotes(
      input.presentation.items.map((item) => ({
        callId: item.callId,
        name: item.tool,
        outcome: succeeded(item),
      })),
    ),
    scheduled: {
      scheduleId: input.scheduleId,
      runId: input.runId,
      name: input.name,
      spoken: input.spoken,
      presentation: input.presentation,
    },
  };
  const { error: messageError } = await auth.db.from("messages").insert({
    conversation_id: conversation.id,
    workspace_id: auth.workspaceId,
    role: "assistant",
    content: input.spoken,
    metadata: JSON.parse(JSON.stringify(metadata)) as Json,
  });
  if (messageError)
    throw new AppError("INTERNAL_ERROR", "Could not save the scheduled message", {
      cause: messageError,
    });
  logger.info("schedule.conversation_created", {
    schedule_run_id: input.runId,
    surfaces:
      tools.reduce((n, t) => n + (t.surfaceIds?.length ?? 0), 0) +
      (input.presentation.focus ? 1 : 0),
  });
  return conversation.id;
}

/** What the conversation page needs to know about a scheduled conversation. */
export interface ScheduledInfo {
  name: string;
  spoken: string;
}

/**
 * A scheduled conversation's opening (its narration) and, once its Live Workspace expired, the
 * Canvas rebuilt from what the run presented: reopening Oct 5's brief shows Oct 5's Surfaces.
 * A workspace the user changed (even emptied) and that is still current is never touched.
 */
export async function openScheduledConversation(
  auth: AuthContext,
  conversationId: string,
): Promise<ScheduledInfo | null> {
  const { data: conversation } = await auth.db
    .from("conversations")
    .select("origin")
    .eq("id", conversationId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (conversation?.origin !== "scheduled") return null;
  const { data: first } = await auth.db
    .from("messages")
    .select("metadata")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const scheduled = (first?.metadata as AssistantMessageMetadata | null)?.scheduled;
  if (!scheduled) return null;
  const { data: live } = await auth.db
    .from("live_workspaces")
    .select("expires_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (!live || Date.parse(live.expires_at) <= Date.now()) {
    const thread: ThreadRef = { kind: "conversation", id: conversationId };
    const session = new WorkspaceSession(auth, thread, emptyWorkspace());
    presentBriefing(session, scheduled.presentation);
    await session.flush();
    logger.info("schedule.canvas_restored", { items: scheduled.presentation.items.length });
  }
  return { name: scheduled.name, spoken: scheduled.spoken };
}
