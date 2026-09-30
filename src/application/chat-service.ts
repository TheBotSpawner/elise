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
import { recallIntent, type RecallResult } from "@/core/recall/model";
import { intentForTool } from "@/core/workspace/from-results";
import { describeWorkspace } from "@/core/workspace/registry";
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
import {
  accountSummaries,
  availableCapabilities,
  createExecutorPorts,
  toolContext,
  toolRegistry,
} from "./elise";
import { listSpaces } from "./knowledge-service";
import { queueRecallIndex, searchRecall } from "./recall-service";
import { structuredSourcesForChat } from "./structured-service";
import { openWorkspaceSession, toClientOutcome } from "./workspace-service";

export interface ChatTurnInput {
  conversationId?: string;
  message: string;
  requestId: string;
  spaceId?: string;
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

  const conversationId =
    input.conversationId ?? (await createConversation(auth, input.message, input.spaceId));
  const history = input.conversationId ? await loadHistory(auth, conversationId) : [];
  const activeSpace = await loadActiveSpace(auth, conversationId);
  const [structuredSources, recallEvidence] = await Promise.all([
    capabilities.has("structured") ? structuredSourcesForChat(auth) : [],
    recallIntent(input.message) ? prefetchRecall(auth, input.message, conversationId) : null,
  ]);

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

  // The interaction's Live Workspace: untouched Surfaces decay at the start of each turn.
  const workspace = await openWorkspaceSession(auth, conversationId, !input.conversationId);
  workspace.apply([{ op: "turn", at: new Date().toISOString() }]);

  const context = buildContextPackage({
    user: auth.profile,
    now: new Date(),
    availableCapabilities: [...capabilities],
    accounts: accountSummaries(bindings),
    history,
    userMessage: input.message,
    activeSpace: activeSpace?.path ?? null,
    structuredSources,
    recallEvidence,
    workspace: describeWorkspace(workspace.state(), auth.profile.timezone),
  });
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "conversation", conversationId, runId: runId });
      workspace.attach(
        (ops, version) => send({ type: "workspace", ops, version }),
        (step, parent) => {
          // Orchestration steps show in the activity trace, nested under their tool.
          const nest = parent ? { parentId: parent } : {};
          if (step.status === "running") {
            traces.set(step.id, { callId: step.id, name: step.tool, ...nest });
            stepStarted.set(step.id, Date.now());
            send({ type: "tool_started", callId: step.id, name: step.tool, ...nest });
            return;
          }
          const outcome: ClientToolOutcome =
            step.status === "done"
              ? { status: "succeeded" }
              : {
                  status: "failed",
                  error: toPublicError(
                    new AppError(
                      step.status === "unavailable"
                        ? "CAPABILITY_UNAVAILABLE"
                        : "PROVIDER_UNAVAILABLE",
                      "Source unavailable",
                    ),
                  ),
                };
          const durationMs = Date.now() - (stepStarted.get(step.id) ?? Date.now());
          traces.set(step.id, { callId: step.id, name: step.tool, outcome, durationMs, ...nest });
          send({ type: "tool_finished", callId: step.id, name: step.tool, outcome, durationMs });
        },
      );

      const traces = new Map<string, ClientToolTrace>();
      const stepStarted = new Map<string, number>();
      const started = Date.now();
      let finalText = "";
      let failure: ReturnType<typeof toPublicError> | null = null;
      let usage: { inputTokens: number; outputTokens: number } | null = null;
      let model: string | null = null;

      try {
        for await (const event of runElise({
          ai,
          ports,
          ctx: {
            ...toolContext(auth, "ai", runId, conversationId),
            knowledgeSpaceId: activeSpace?.id ?? null,
            workspace,
          },
          instructions: context.instructions,
          input: context.input,
          tools: toolRegistry.available(capabilities),
        })) {
          switch (event.type) {
            case "status":
            case "text":
            case "tool_started":
              if (event.type === "tool_started") {
                traces.set(event.callId, { callId: event.callId, name: event.name });
                stepStarted.set(event.callId, Date.now());
                workspace.current = event.callId;
                beginIntent(event.name);
                if (event.name === "meeting.prepare")
                  logger.info("meeting_prep.started", { run_id: runId });
              }
              send(event);
              break;
            case "tool_finished": {
              const outcome = toClientOutcome(event.outcome);
              const durationMs = Date.now() - (stepStarted.get(event.callId) ?? Date.now());
              workspace.current = null;
              // Every result ELISE fetched is presented by the application, never "drawn".
              const surfaceIds = event.name.startsWith("ui.")
                ? []
                : workspace.present(event.name, event.callId, event.outcome);
              if (event.name === "meeting.prepare") logMeetingPrep(event.outcome, durationMs);
              const shown = surfaceIds.length ? { surfaceIds } : {};
              traces.set(event.callId, {
                callId: event.callId,
                name: event.name,
                outcome,
                durationMs,
                ...shown,
              });
              send({
                type: "tool_finished",
                callId: event.callId,
                name: event.name,
                outcome,
                durationMs,
                ...shown,
              });
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
        await workspace.flush();
        await finishRun();
        controller.close();
      }

      /** A request's first tool sets a lightweight intent when there is none yet. */
      function beginIntent(toolName: string) {
        if (workspace.state().intent || toolName.startsWith("meeting.")) return;
        const kind = intentForTool(toolName);
        if (!kind) return;
        const at = new Date().toISOString();
        workspace.apply([
          {
            op: "intent",
            intent: {
              id: `intent:${runId}`,
              kind,
              description: input.message.slice(0, 160),
              startedAt: at,
            },
            at,
          },
        ]);
      }

      function logMeetingPrep(outcome: ToolCallOutcome, latencyMs: number) {
        const out = (outcome.status === "succeeded" ? outcome.output : null) as {
          found?: boolean;
          unavailable?: string[];
        } | null;
        logger.info("meeting_prep.completed", {
          run_id: runId,
          status: outcome.status,
          found: Boolean(out?.found),
          unavailable_sources: out?.unavailable?.length ?? 0,
          surfaces: workspace.state().surfaces.length,
          latency_ms: latencyMs,
        });
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
        // Recall indexing never delays or fails the chat.
        queueRecallIndex(auth.workspaceId, conversationId);
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

async function createConversation(
  auth: AuthContext,
  firstMessage: string,
  spaceId?: string,
): Promise<string> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  const { data, error } = await auth.db
    .from("conversations")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      title,
      // The Space is re-validated on every turn (loadActiveSpace); this is only a reference.
      active_context: spaceId ? { knowledgeSpaceId: spaceId } : {},
    })
    .select("id")
    .single();
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not start the conversation", { cause: error });
  return data.id;
}

/** The conversation's Knowledge Space, if it has one and it is still an active Space here. */
async function loadActiveSpace(
  auth: AuthContext,
  conversationId: string,
): Promise<{ id: string; path: string } | null> {
  const { data } = await auth.db
    .from("conversations")
    .select("active_context")
    .eq("id", conversationId)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  const spaceId = (data?.active_context as { knowledgeSpaceId?: string } | null)?.knowledgeSpaceId;
  if (!spaceId) return null;
  const spaces = await listSpaces(auth).catch(() => []);
  const space = spaces.find((s) => s.id === spaceId);
  return space ? { id: space.id, path: space.path } : null;
}

/** Bounded, best-effort: a slow or failing index never blocks the turn. */
async function prefetchRecall(
  auth: AuthContext,
  message: string,
  conversationId: string,
): Promise<RecallResult[] | null> {
  try {
    return await Promise.race([
      searchRecall(auth, message, conversationId, 3),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
  } catch (error) {
    logger.warn("recall.prefetch_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    return null;
  }
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
