import "server-only";

import { serverEnv } from "@/config/server-env";
import {
  buildContextPackage,
  MAX_HISTORY_MESSAGES,
  type HistoryMessage,
} from "@/core/agents/context";
import type { ToolCallOutcome } from "@/core/agents/executor";
import { runElise, toolNotes } from "@/core/agents/runtime";
import { AppError, toPublicError } from "@/core/errors";
import { getAIProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import type { Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import type {
  AssistantMessageMetadata,
  ChatStreamEvent,
  ClientToolOutcome,
  ClientToolTrace,
} from "./chat-protocol";
import { availableCapabilities, createExecutorPorts, toolContext, toolRegistry } from "./elise";

export interface ChatTurnInput {
  conversationId?: string;
  message: string;
  requestId: string;
}

/**
 * askElise(): one chat turn through the single ELISE Core runtime, streamed as events.
 * Persists the conversation, messages and AI run; the model never touches the database.
 */
export async function startChatTurn(
  auth: AuthContext,
  input: ChatTurnInput,
): Promise<ReadableStream<Uint8Array>> {
  await enforceRateLimit(auth);
  const ai = getAIProvider();
  const ports = createExecutorPorts(auth);
  const { bindings } = await ports.bindings();
  const capabilities = availableCapabilities(bindings);

  const conversationId = input.conversationId ?? (await createConversation(auth, input.message));
  const history = input.conversationId ? await loadHistory(auth, conversationId) : [];

  const { error: insertError } = await auth.db.from("messages").insert({
    conversation_id: conversationId,
    workspace_id: auth.workspaceId,
    role: "user",
    content: input.message,
  });
  if (insertError)
    throw new AppError("NOT_FOUND", "Conversation not found", { cause: insertError });

  const { data: run, error: runError } = await auth.db
    .from("ai_runs")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      conversation_id: conversationId,
      ai_provider: ai.id,
      model_key: serverEnv().OPENAI_MODEL,
      request_id: input.requestId,
    })
    .select("id, started_at")
    .single();
  if (runError || !run)
    throw new AppError("INTERNAL_ERROR", "Could not start the run", { cause: runError });
  const runId = run.id;

  const context = buildContextPackage({
    user: auth.profile,
    now: new Date(),
    availableCapabilities: [...capabilities],
    history,
    userMessage: input.message,
  });
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "conversation", conversationId, runId: runId });

      const traces = new Map<string, ClientToolTrace>();
      const started = Date.now();
      let finalText = "";
      let failure: ReturnType<typeof toPublicError> | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let model: string | null = null;

      try {
        for await (const event of runElise({
          ai,
          ports,
          ctx: toolContext(auth, "ai", runId),
          instructions: context.instructions,
          input: context.input,
          tools: toolRegistry.available(capabilities),
        })) {
          switch (event.type) {
            case "status":
            case "text":
            case "tool_started":
              if (event.type === "tool_started")
                traces.set(event.callId, { callId: event.callId, name: event.name });
              send(event);
              break;
            case "tool_finished": {
              const outcome = toClientOutcome(event.outcome);
              traces.set(event.callId, { callId: event.callId, name: event.name, outcome });
              send({ type: "tool_finished", callId: event.callId, name: event.name, outcome });
              break;
            }
            case "done":
              finalText = event.text;
              usage = event.usage;
              model = event.model;
              await persistAssistant(event.text, {
                tools: [...traces.values()],
                toolNotes: toolNotes(event.tools),
              });
              break;
            case "error":
              finalText = event.text;
              failure = event.error;
              await persistAssistant(event.text, {
                tools: [...traces.values()],
                toolNotes: toolNotes(event.tools),
                error: event.error,
              });
              send({ type: "error", error: event.error });
              break;
          }
        }
      } catch (error) {
        failure = toPublicError(error);
        send({ type: "error", error: failure });
      } finally {
        await finishRun();
        controller.close();
      }

      async function persistAssistant(text: string, metadata: AssistantMessageMetadata) {
        const { data } = await auth.db
          .from("messages")
          .insert({
            conversation_id: conversationId,
            workspace_id: auth.workspaceId,
            role: "assistant",
            content: text,
            run_id: runId,
            metadata: JSON.parse(JSON.stringify(metadata)) as Json,
          })
          .select("id")
          .single();
        if (!failure) send({ type: "done", messageId: data?.id ?? null });
      }

      async function finishRun() {
        const latency = Date.now() - started;
        await Promise.all([
          auth.db
            .from("ai_runs")
            .update({
              status: failure ? "failed" : "completed",
              completed_at: new Date().toISOString(),
              latency_ms: latency,
              token_usage: (usage ?? {}) as Json,
              tool_call_count: traces.size,
              error_code: failure?.code ?? null,
              ...(model ? { model_key: model } : {}),
            })
            .eq("id", runId),
          auth.db
            .from("conversations")
            .update({ last_message_at: new Date().toISOString() })
            .eq("id", conversationId),
        ]);
        logger.info("ai_run.finished", {
          run_id: runId,
          request_id: input.requestId,
          workspace_id: auth.workspaceId,
          status: failure ? "failed" : "completed",
          error_code: failure?.code,
          latency_ms: latency,
          tool_calls: traces.size,
          input_tokens: usage?.inputTokens,
          output_tokens: usage?.outputTokens,
          response_chars: finalText.length,
        });
      }
    },
  });
}

async function enforceRateLimit(auth: AuthContext) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await auth.db
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .gte("started_at", since);
  if ((count ?? 0) >= serverEnv().CHAT_RATE_LIMIT_PER_MINUTE) {
    throw new AppError(
      "RATE_LIMITED",
      "You're sending messages very quickly. Wait a moment and try again.",
    );
  }
}

async function createConversation(auth: AuthContext, firstMessage: string): Promise<string> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  const { data, error } = await auth.db
    .from("conversations")
    .insert({ workspace_id: auth.workspaceId, user_id: auth.userId, title })
    .select("id")
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the conversation", { cause: error });
  return data.id;
}

async function loadHistory(auth: AuthContext, conversationId: string): Promise<HistoryMessage[]> {
  const { data, error } = await auth.db
    .from("messages")
    .select("role, content, metadata")
    .eq("conversation_id", conversationId)
    .eq("workspace_id", auth.workspaceId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  if (error) throw new AppError("NOT_FOUND", "Conversation not found", { cause: error });
  return data.reverse().map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    toolNotes: ((m.metadata as AssistantMessageMetadata | null)?.toolNotes ?? []).slice(0, 10),
  }));
}

function toClientOutcome(outcome: ToolCallOutcome): ClientToolOutcome {
  switch (outcome.status) {
    case "succeeded":
      return { status: "succeeded", display: outcome.display };
    case "approval_required":
      return {
        status: "approval_required",
        approvalId: outcome.approvalId,
        summary: outcome.summary,
        reason: outcome.reason,
      };
    case "clarification_required":
      return { status: "clarification_required" };
    case "rejected":
      return { status: "rejected" };
    case "failed":
      return { status: "failed", error: outcome.error };
  }
}
