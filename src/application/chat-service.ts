import "server-only";

import { serverEnv } from "@/config/server-env";
import { buildContextPackage } from "@/core/agents/context";
import type { ToolCallOutcome } from "@/core/agents/executor";
import { runElise, toolNotes } from "@/core/agents/runtime";
import {
  activeContextOf,
  contextLabel,
  describeActiveContext,
  resolveContext,
  type ContextProfile,
  type Entity,
} from "@/core/contexts/model";
import { AppError, toPublicError } from "@/core/errors";
import type { ThreadRef, TurnModality, VoiceTurnMeta } from "@/core/interaction";
import { recallIntent, type RecallResult } from "@/core/recall/model";
import { matchShortcut } from "@/core/shortcuts/match";
import { stepsToCalls } from "@/core/shortcuts/model";
import { todayIn } from "@/core/time";
import { bindVoiceApproval } from "@/core/voice/approval";
import { approvalDecidedOps, intentForTool } from "@/core/workspace/from-results";
import { describeWorkspace } from "@/core/workspace/registry";
import { getAIProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import type { Json } from "@/infrastructure/supabase/database.types";

import { pendingForInteraction, resolveApproval } from "./approvals-service";
import type { AuthContext } from "./auth-context";
import type {
  AssistantMessageMetadata,
  ChatStreamEvent,
  ClientToolOutcome,
  ClientToolTrace,
} from "./chat-protocol";
import { associateInteraction, listContextProfiles, listEntities } from "./contexts-service";
import {
  accountSummaries,
  availableCapabilities,
  createExecutorPorts,
  toolContext,
  toolRegistry,
} from "./elise";
import { openThread } from "./interaction-thread";
import { queueRecallIndex, searchRecall } from "./recall-service";
import { enabledShortcuts, shortcutStore } from "./shortcuts-service";
import { structuredSourcesForChat } from "./structured-service";
import { studyStore } from "./study-service";
import { webSearchConfigured } from "./web-service";
import { openWorkspaceSession, toClientOutcome, type WorkspaceSession } from "./workspace-service";

export interface ChatTurnInput {
  conversationId?: string;
  /** A voice session in progress (ADR-014). */
  sessionId?: string;
  message: string;
  requestId: string;
  spaceId?: string;
  /** Spoken turns run the same ELISE; only how the reply is shaped differs. */
  modality?: TurnModality;
  voice?: VoiceTurnMeta;
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

  const modality: TurnModality = input.modality ?? "text";
  const web = webSearchConfigured();
  const thread = await openThread(auth, {
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    modality,
    firstMessage: input.message,
    spaceId: input.spaceId,
  });
  const [history, activeSpace] = await Promise.all([thread.history(), thread.activeSpace()]);
  const [structuredSources, recallEvidence, contexts, studySession, pendingApprovals, shortcuts] =
    await Promise.all([
      capabilities.has("structured") ? structuredSourcesForChat(auth) : [],
      recallIntent(input.message) ? prefetchRecall(auth, input.message, thread.ref) : null,
      loadContexts(auth),
      thread.isNew
        ? null
        : studyStore(auth)
            .activeSession(thread.ref)
            .catch(() => null),
      // Read now, before this turn's run exists: only earlier runs can have asked.
      modality === "voice" && !thread.isNew
        ? pendingForInteraction(auth, thread.ref).catch(() => [])
        : [],
      enabledShortcuts(auth),
    ]);

  await thread.addUserTurn(input.message, modality, input.voice);

  const { data: run, error: runError } = await auth.db
    .from("ai_runs")
    .insert({
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      conversation_id: thread.ref.kind === "conversation" ? thread.ref.id : null,
      interaction_session_id: thread.ref.kind === "session" ? thread.ref.id : null,
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
  const workspace = await openWorkspaceSession(auth, thread.ref, thread.isNew);
  workspace.apply([{ op: "turn", at: new Date().toISOString() }]);
  // "Ask ELISE" from a Section starts the conversation in that Section's context (ADR-018).
  const sectionContext =
    thread.isNew && activeSpace
      ? contexts.profiles.find((p) => p.section?.spaceId === activeSpace.id)
      : undefined;
  if (sectionContext) {
    workspace.apply([
      { op: "context", context: activeContextOf(sectionContext), at: new Date().toISOString() },
    ]);
    await associateInteraction(auth, sectionContext.id, thread.ref, "activated").catch(
      () => undefined,
    );
  }
  // Which area of the user's world this message is about (ADR-016 §5), after the turn's decay.
  const contextHint = await resolveTurnContext(
    auth,
    workspace,
    thread.ref,
    input.message,
    contexts,
  );
  const activeProfile = contexts.profiles.find((p) => p.id === workspace.state().context?.id);

  // A spoken "sí" / "no" may answer exactly one pending approval of this interaction
  // (ADR-017 §16); anything less certain stays conversation.
  const approval =
    modality === "voice"
      ? bindVoiceApproval({
          text: input.message,
          modality,
          pending: pendingApprovals,
          now: new Date(),
        })
      : ({ kind: "none" } as const);
  // A Shortcut phrase runs its steps without planning (ADR-017 §12); everything else is
  // normal reasoning.
  const shortcut =
    approval.kind === "none"
      ? matchShortcut(input.message, shortcuts)
      : ({ kind: "none" } as const);
  const ranShortcut =
    shortcut.kind === "match" && !shortcut.shortcut.requiresConfirmation ? shortcut.shortcut : null;
  const preset = ranShortcut
    ? stepsToCalls(ranShortcut.steps, {
        contextId: ranShortcut.contextId,
        today: todayIn(auth.profile.timezone),
      })
    : null;
  const turnHints = [
    contextHint,
    approval.kind === "ask"
      ? `The user answered "${input.message.slice(0, 40)}" but ${approval.count} approvals are pending in this interaction. Approve nothing: ask which one (by what it does).`
      : null,
    shortcut.kind === "match" && shortcut.shortcut.requiresConfirmation
      ? `The message matches the user's Shortcut "${shortcut.shortcut.name}", which asks for confirmation first: ask whether to run it; if they confirm, call shortcuts.run.`
      : null,
    shortcut.kind === "ambiguous"
      ? `The message matches several Shortcuts (${shortcut.shortcuts.map((x) => x.name).join(", ")}): ask which one.`
      : null,
    ranShortcut
      ? `This turn is the user's Shortcut "${ranShortcut.name}": its steps already ran (results above, as tool results). Answer from them — briefly, the details are on screen — and don't call those tools again unless the user asks for more.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

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
    modality,
    web,
    activeContext: activeProfile ? describeActiveContext(activeProfile) : null,
    contexts: contexts.profiles
      .filter((p) => p.id !== activeProfile?.id)
      .map((p) => ({ name: p.name, kind: p.kind })),
    contextHint: turnHints || null,
    studySession: describeStudy(studySession, contexts.profiles),
  });
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      send({ type: "conversation", thread: thread.ref, runId });
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
        if (approval.kind === "resolve") {
          await answerVoiceApproval(approval);
          return;
        }
        if (ranShortcut) {
          void shortcutStore(auth)
            .markRun(ranShortcut.id)
            .catch(() => undefined);
          logger.info("shortcut.run", { run_id: runId, steps: ranShortcut.steps.length, modality });
          await auth.db.from("audit_events").insert({
            workspace_id: auth.workspaceId,
            user_id: auth.userId,
            event_type: "shortcut.run",
            resource_type: "shortcut",
            resource_id: ranShortcut.id,
            origin: "ai",
            result: "success",
            metadata: { steps: ranShortcut.steps.map((x) => x.type) },
          });
        }
        for await (const event of runElise({
          ai,
          ports,
          ctx: {
            ...toolContext(auth, "ai", runId, thread.ref),
            knowledgeSpaceId: activeSpace?.id ?? null,
            workspace,
            voiceWake: input.voice?.wake ?? null,
            // Live: a context activated by a tool applies to the rest of the run.
            get context() {
              const c = workspace.state().context;
              return c ? { id: c.id, name: c.name, kind: c.kind } : null;
            },
          },
          instructions: context.instructions,
          input: context.input,
          // A Shortcut's steps run first, through the same executor and policy (ADR-017 §12).
          ...(preset ? { preset } : {}),
          // A spoken turn waits on every second of thinking: less deliberation, same tools.
          ...(modality === "voice" ? { reasoning: "low" as const } : {}),
          tools: toolRegistry
            .available(capabilities)
            .filter((t) => web || t.capability !== "web_search"),
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
        const messageId = await thread.addAssistantTurn(text, modality, {
          ...metadata,
          ...(ranShortcut ? { shortcut: { id: ranShortcut.id, name: ranShortcut.name } } : {}),
        });
        if (!failure) send({ type: "done", messageId });
      }

      /**
       * The spoken answer resolved one pending approval: the same resolution as the Approve
       * button (audited as voice), then a reply that states only what really happened.
       */
      async function answerVoiceApproval(a: Extract<typeof approval, { kind: "resolve" }>) {
        const at = new Date().toISOString();
        let outcome: Awaited<ReturnType<typeof resolveApproval>> = null;
        let problem: string | null = null;
        try {
          outcome = await resolveApproval(auth, a.approvalId, a.decision, "voice");
        } catch (error) {
          problem = toPublicError(error).message;
        }
        const display = outcome?.status === "succeeded" ? outcome.display : undefined;
        if (!problem)
          workspace.apply(
            approvalDecidedOps(workspace.state(), a.approvalId, a.decision, display, at),
          );
        const es = auth.profile.locale === "es";
        const failedRun = outcome && outcome.status !== "succeeded";
        const text = problem
          ? es
            ? `No pude resolverla: ${problem}`
            : `I couldn't resolve it: ${problem}`
          : a.decision === "rejected"
            ? es
              ? `Listo, no lo hago: ${a.summary}.`
              : `Okay, I won't: ${a.summary}.`
            : failedRun
              ? es
                ? `La aprobé, pero no se pudo completar: ${a.summary}.`
                : `Approved, but it couldn't be completed: ${a.summary}.`
              : es
                ? `Hecho: ${a.summary}.`
                : `Done: ${a.summary}.`;
        logger.info("voice.approval_resolved", {
          run_id: runId,
          decision: a.decision,
          status: problem ? "failed" : (outcome?.status ?? "rejected"),
        });
        finalText = text;
        send({ type: "text", delta: text });
        await persistAssistant(text, {
          voiceApproval: { approvalId: a.approvalId, decision: a.decision },
        });
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
          thread.touch(),
        ]);
        // Recall indexing never delays or fails the chat (spoken turns included).
        queueRecallIndex(auth.workspaceId, thread.ref);
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
          modality,
          thread: thread.ref.kind,
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

/** Profiles and people for resolution; contexts never block a turn. */
async function loadContexts(
  auth: AuthContext,
): Promise<{ profiles: ContextProfile[]; entities: Entity[] }> {
  try {
    const [profiles, entities] = await Promise.all([listContextProfiles(auth), listEntities(auth)]);
    return { profiles, entities };
  } catch (error) {
    logger.warn("context.load_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    return { profiles: [], entities: [] };
  }
}

/**
 * One clear match activates (or keeps) the context; two comparable ones become a question for
 * the model to ask; nothing matching leaves the active context to decay on its own.
 */
async function resolveTurnContext(
  auth: AuthContext,
  workspace: WorkspaceSession,
  thread: ThreadRef,
  message: string,
  contexts: { profiles: ContextProfile[]; entities: Entity[] },
): Promise<string | null> {
  if (!contexts.profiles.length) return null;
  const active = workspace.state().context;
  const r = resolveContext({ message, ...contexts, activeId: active?.id ?? null });
  if (r.kind === "match") {
    const p = r.profile;
    workspace.apply([
      {
        op: "context",
        context: activeContextOf(p),
        at: new Date().toISOString(),
      },
    ]);
    if (p.id !== active?.id) {
      logger.info("context.resolved_automatically", {
        reason: r.reason,
        explicit: r.explicit,
        kind: p.kind,
      });
      await associateInteraction(auth, p.id, thread, "activated").catch(() => undefined);
    }
    return null;
  }
  if (r.kind === "ambiguous") {
    logger.info("context.resolution_ambiguous", { candidates: r.candidates.length });
    return `This message may be about several contexts (${r.candidates.map(contextLabel).join(", ")}). If it matters for the answer, ask which one before using any of them.`;
  }
  return null;
}

/** The pending study question, for the model: the question only, never its key points. */
function describeStudy(
  session: Awaited<ReturnType<ReturnType<typeof studyStore>["activeSession"]>>,
  profiles: ContextProfile[],
): string | null {
  if (!session?.current) return null;
  const subject = profiles.find((p) => p.id === session.contextId)?.name ?? "the subject";
  const c = session.current;
  return `Study session in progress (${session.mode} · ${subject} · ${session.scope.label}, id ${session.id}). Question ${c.number} is waiting for the user's answer: "${c.question.replace(/"/g, "'")}" (about ${c.conceptLabel}). Feedback ${session.preferences.feedback === "end" ? "only at the end" : "after each answer"}. If this message answers it, call study.answer with the user's words; if it's something else, handle that and the session stays open.`;
}

/** Bounded, best-effort: a slow or failing index never blocks the turn. */
async function prefetchRecall(
  auth: AuthContext,
  message: string,
  thread: ThreadRef,
): Promise<RecallResult[] | null> {
  try {
    return await Promise.race([
      searchRecall(auth, message, thread, 3),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
  } catch (error) {
    logger.warn("recall.prefetch_failed", {
      code: error instanceof AppError ? error.code : "UNKNOWN",
    });
    return null;
  }
}
