import "server-only";

import { isEnabled } from "@/config/flags";
import { serverEnv } from "@/config/server-env";
import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall, type ToolCallOutcome } from "@/core/agents/executor";
import { escalateAfter, MODEL_POLICY, routeTurn } from "@/core/agents/model-policy";
import { runElise, toolNotes } from "@/core/agents/runtime";
import { selectTools, toolsInNotes } from "@/core/agents/tool-selection";
import type { ToolContext } from "@/core/agents/tools";
import { getOperation } from "@/core/capabilities/registry";
import {
  activeContextOf,
  contextLabel,
  describeActiveContext,
  resolveContext,
  type ContextProfile,
  type Entity,
} from "@/core/contexts/model";
import { AppError, toPublicError } from "@/core/errors";
import { knowledgeMap, resolveMentioned } from "@/core/history/links";
import type { ThreadRef, TurnModality, VoiceTurnMeta } from "@/core/interaction";
import { coarse, type LatLng } from "@/core/location/model";
import { TurnPerf } from "@/core/perf";
import { recallIntent, type RecallResult } from "@/core/recall/model";
import { matchShortcut } from "@/core/shortcuts/match";
import { stepsToCalls } from "@/core/shortcuts/model";
import { todayIn } from "@/core/time";
import { bindVoiceApproval } from "@/core/voice/approval";
import { SpokenSplitter } from "@/core/voice/speech-text";
import { approvalDecidedOps, intentForTool } from "@/core/workspace/from-results";
import { changeOf } from "@/core/workspace/lifecycle";
import { describeWorkspace } from "@/core/workspace/registry";
import { getAIProvider } from "@/infrastructure/ai";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";
import { withUsageScope } from "@/infrastructure/observability/usage";
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
import { autoLinkThread, historyLinks } from "./history-links-service";
import { openThread } from "./interaction-thread";
import { syncDueSources } from "./knowledge-background";
import { locationConfigured } from "./location-service";
import { queueRecallIndex, searchRecall } from "./recall-service";
import { enabledShortcuts, shortcutStore } from "./shortcuts-service";
import { structuredSourcesForChat } from "./structured-service";
import { studyStore } from "./study-service";
import { webSearchConfigured } from "./web-service";
import {
  isReadTool,
  openWorkspaceSession,
  readRunner,
  toClientOutcome,
  type WorkspaceSession,
} from "./workspace-service";

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
  /** The position the user shared for this session (ADR-023): never stored or logged. */
  here?: LatLng;
  /**
   * A GPT-Live delegation (ADR-026): the voice model already acknowledged; the reply is a
   * compact verified result, and false starts in the transcript are expected.
   */
  live?: { delegationId: string };
  /** When the request arrived and how long auth took (performance telemetry). */
  receivedAt?: number;
  authMs?: number;
}

/** Where a turn's events go: an HTTP stream, a GPT-Live delegation, a test… */
export type TurnEventSink = (event: ChatStreamEvent) => void;

/**
 * A turn ready to run (ADR-026): setup done (auth checks, rate limit, thread, history, run row,
 * context), nothing streamed yet. Errors before this point are request errors.
 */
export interface PreparedTurn {
  thread: ThreadRef;
  runId: string;
  /** Runs the turn, emitting its events in order; resolves when the turn is fully persisted. */
  run(emit: TurnEventSink, opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * HTTP adapter: one chat turn as newline-delimited JSON (POST /api/chat). Typed and spoken
 * turns of the legacy voice pipeline both come through here.
 */
export async function startChatTurn(
  auth: AuthContext,
  input: ChatTurnInput,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const turn = await prepareTurn(auth, input);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      await turn.run((event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)), {
        signal,
      });
      controller.close();
    },
  });
}

/**
 * ELISE's turn engine (ADR-026): one turn through the single ELISE Core runtime, independent
 * of transport. Persists the conversation or voice session, messages and AI run; the model
 * never touches the database. Every adapter (HTTP chat, GPT-Live delegation) runs this.
 */
export async function prepareTurn(auth: AuthContext, input: ChatTurnInput): Promise<PreparedTurn> {
  const perf = new TurnPerf(input.receivedAt ?? Date.now(), input.modality ?? "text");
  if (input.authMs != null) {
    perf.span("auth", input.authMs);
    perf.mark("auth", input.authMs);
  }
  const ai = getAIProvider();
  const ports = createExecutorPorts(auth);
  const env = serverEnv();
  const adaptive = env.ELISE_AI_ROUTING === "adaptive";
  const modality: TurnModality = input.modality ?? "text";
  const web = webSearchConfigured() && isEnabled("research", auth);
  const location = locationConfigured();
  const here = input.here ? coarse(input.here) : null;

  // Setup in dependency phases (ADR-025): independent reads share one round trip. Nothing is
  // written before the rate limit passes; history is read before this turn's message is saved.
  const [, { bindings }, contexts, shortcuts, nodes] = await perf.time(
    "setup.reads",
    Promise.all([
      perf.time("rate_limit", enforceRateLimit(auth)),
      perf.time("bindings", ports.bindings()),
      perf.time("preload.contexts", loadContexts(auth)),
      perf.time("preload.shortcuts", enabledShortcuts(auth)),
      perf.time(
        "knowledge_nodes",
        historyLinks(auth)
          .nodes()
          .catch(() => []),
      ),
    ]),
  );
  const capabilities = availableCapabilities(bindings);
  const thread = await perf.time(
    "thread",
    openThread(auth, {
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      modality,
      firstMessage: input.message,
      spaceId: input.spaceId,
    }),
  );
  const [
    history,
    activeSpace,
    structuredSources,
    recallEvidence,
    studySession,
    pendingApprovals,
    workspace,
  ] = await perf.time(
    "preload",
    Promise.all([
      perf.time("history", thread.history()),
      thread.activeSpace(),
      capabilities.has("structured")
        ? perf.time("preload.structured", structuredSourcesForChat(auth))
        : [],
      // Legacy only: an adaptive turn searches Recall with its tool when it needs it, so a
      // blocking prefetch would only delay the first byte (ADR-025).
      !adaptive && recallIntent(input.message)
        ? perf.time("preload.recall", prefetchRecall(auth, input.message, thread.ref))
        : null,
      thread.isNew
        ? null
        : perf.time(
            "preload.study",
            studyStore(auth)
              .activeSession(thread.ref)
              .catch(() => null),
          ),
      // Read now, before this turn's run exists: only earlier runs can have asked.
      modality === "voice" && !thread.isNew
        ? perf.time(
            "preload.approvals",
            pendingForInteraction(auth, thread.ref).catch(() => []),
          )
        : [],
      // The interaction's Live Workspace: untouched Surfaces decay at the start of each turn.
      perf.time("workspace", openWorkspaceSession(auth, thread.ref, thread.isNew)),
    ]),
  );

  const [, { data: run, error: runError }] = await Promise.all([
    perf.time("user_turn", thread.addUserTurn(input.message, modality, input.voice)),
    perf.time("run_insert", () =>
      auth.db
        .from("ai_runs")
        .insert({
          workspace_id: auth.workspaceId,
          user_id: auth.userId,
          conversation_id: thread.ref.kind === "conversation" ? thread.ref.id : null,
          interaction_session_id: thread.ref.kind === "session" ? thread.ref.id : null,
          ai_provider: ai.id,
          // The model actually used replaces this when the run finishes.
          model_key: "pending",
          request_id: input.requestId,
        })
        .select("id, started_at")
        .single()
        .then((r) => r),
    ),
  ]);
  if (runError || !run)
    throw new AppError("INTERNAL_ERROR", "Could not start the run", { cause: runError });
  const runId = run.id;

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
  const contextHint = await perf.time("turn_context", () =>
    resolveTurnContext(auth, workspace, thread.ref, input.message, contexts),
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

  // Object first (what is the user talking about?), tool second: a Section the message clearly
  // names is resolved here, from the user's own names for it, before the model picks a tool.
  const mentioned = activeSpace ? null : resolveMentioned(input.message, nodes);
  const resolvedPath = mentioned
    ? mentioned.parentName
      ? `${mentioned.parentName} › ${mentioned.name}`
      : mentioned.name
    : null;
  logger.info("chat.routing", {
    request_id: input.requestId,
    modality,
    active_space: activeSpace?.id ?? null,
    resolved_space: mentioned?.id ?? null,
    knowledge_nodes: nodes.length,
    web,
    location: location ? "configured" : "not_configured",
    location_shared: Boolean(here),
  });

  const context = buildContextPackage({
    user: auth.profile,
    now: new Date(),
    availableCapabilities: [...capabilities],
    accounts: accountSummaries(bindings),
    history,
    userMessage: input.message,
    activeSpace: activeSpace?.path ?? null,
    knowledgeMap: knowledgeMap(nodes),
    resolvedSpace: resolvedPath,
    spaceNotes: await perf.time(
      "space_notes",
      spaceNotes(auth, [
        activeSpace?.id ?? null,
        mentioned?.id ?? null,
        mentioned?.parentId ?? null,
        activeProfile?.section?.spaceId ?? null,
        activeProfile?.section?.parentId ?? null,
      ]).catch(() => []),
    ),
    structuredSources,
    recallEvidence,
    workspace: describeWorkspace(workspace.state(), auth.profile.timezone),
    modality,
    voiceDelivery: input.live ? "live" : "speech",
    web,
    location: location ? { here: Boolean(here) } : null,
    activeContext: activeProfile ? describeActiveContext(activeProfile) : null,
    contexts: contexts.profiles
      .filter((p) => p.id !== activeProfile?.id)
      .map((p) => ({ name: p.name, kind: p.kind })),
    contextHint: turnHints || null,
    studySession: describeStudy(studySession, contexts.profiles),
  });
  // Model profile and tool exposure (ADR-025): legacy sends every tool to the standard
  // profile; adaptive routes by request and exposes the relevant tool groups (rest on demand).
  const route = adaptive
    ? routeTurn(input.message)
    : modality === "voice"
      ? MODEL_POLICY.voice_turn
      : MODEL_POLICY.chat;
  perf.profile = route.tier;
  const allTools = toolRegistry
    .available(capabilities)
    .filter(
      (t) => (web || t.capability !== "web_search") && (location || t.capability !== "location"),
    );
  const selection =
    env.ELISE_TOOL_SELECTION === "selected"
      ? selectTools(allTools, {
          message: input.message,
          surfaceTypes: workspace.state().surfaces.map((s) => s.type),
          recentTools: toolsInNotes(
            history.slice(-4).flatMap((m) => ("toolNotes" in m && m.toolNotes) || []),
          ),
          contextKind: activeProfile?.kind ?? null,
        })
      : { tools: allTools, rest: [] };
  perf.mark("context_built");
  // Every model, Web and speech call made by this turn is attributed to it.
  const usageScope = {
    workspaceId: auth.workspaceId,
    userId: auth.userId,
    feature: modality === "voice" ? "voice_turn" : "chat",
    aiRunId: runId,
  };

  return {
    thread: thread.ref,
    runId,
    run: (emit, opts = {}) =>
      withUsageScope(usageScope, async () => {
        const signal = opts.signal;
        const send = (event: ChatStreamEvent) => {
          if (event.type === "text" || event.type === "spoken") perf.mark("first_text");
          if (event.type === "workspace" && event.ops.some((o) => o.op === "present"))
            perf.mark("first_surface");
          if (event.type !== "conversation") perf.mark("first_event");
          emit(event);
        };
        perf.mark("stream_start");
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
            traces.set(step.id, {
              callId: step.id,
              name: step.tool,
              outcome,
              durationMs,
              ...nest,
            });
            send({
              type: "tool_finished",
              callId: step.id,
              name: step.tool,
              outcome,
              durationMs,
            });
          },
        );

        const contextAtStart = workspace.state().context?.id ?? null;
        const traces = new Map<string, ClientToolTrace>();
        const stepStarted = new Map<string, number>();
        const started = Date.now();
        let finalText = "";
        let failure: ReturnType<typeof toPublicError> | null = null;
        let usage: { inputTokens: number; outputTokens: number } | null = null;
        const splitter = modality === "voice" ? new SpokenSplitter() : null;
        let model: string | null = null;
        // The turn's tool context, kept so a Surface's own read can be replayed (ADR-029).
        let toolCtx: ToolContext | null = null;
        const readSurface = readRunner(
          (call) =>
            executeToolCall(
              ports,
              // A replay presents nothing by itself: the session reconciles its result.
              {
                ...toolCtx!,
                workspace: { state: () => workspace.state(), apply: () => 0, activity: () => {} },
              },
              call,
            ),
          (name) => isReadTool(ports.registry.get(name)),
        );

        try {
          if (approval.kind === "resolve") {
            await answerVoiceApproval(approval);
            return;
          }
          if (ranShortcut) {
            void shortcutStore(auth)
              .markRun(ranShortcut.id)
              .catch(() => undefined);
            logger.info("shortcut.run", {
              run_id: runId,
              steps: ranShortcut.steps.length,
              modality,
            });
            trackEvent(auth, "shortcut_run", { modality, steps: ranShortcut.steps.length });
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
            ctx: (toolCtx = {
              ...toolContext(auth, "ai", runId, thread.ref),
              // The conversation's Space, else the Section this message named.
              knowledgeSpaceId: activeSpace?.id ?? mentioned?.id ?? null,
              userMessage: input.message,
              workspace,
              voiceWake: input.voice?.wake ?? null,
              here,
              // Live: a context activated by a tool applies to the rest of the run.
              get context() {
                const c = workspace.state().context;
                return c
                  ? {
                      id: c.id,
                      name: c.name,
                      kind: c.kind,
                      sectionSpaceId:
                        contexts.profiles.find((p) => p.id === c.id)?.section?.spaceId ?? null,
                    }
                  : null;
              },
            }),
            // Adaptive: stable instructions, per-turn context last (prompt caching, ADR-025).
            instructions: adaptive ? context.cached.instructions : context.instructions,
            input: adaptive ? context.cached.input : context.input,
            // A Shortcut's steps run first, through the same executor and policy (ADR-017 §12).
            ...(preset ? { preset } : {}),
            ...route,
            ...(adaptive ? { escalate: escalateAfter } : {}),
            ...(signal ? { signal } : {}),
            tools: selection.tools,
            moreTools: selection.rest,
          })) {
            switch (event.type) {
              case "model_call": {
                const s = event.stats;
                const rel = (t: number | null) => (t == null ? null : t - perf.origin);
                perf.model({
                  model: s.model,
                  profile: s.tier,
                  reasoning: s.reasoning,
                  serviceTier: s.serviceTier,
                  start: s.start - perf.origin,
                  firstEvent: rel(s.firstEvent),
                  firstText: rel(s.firstText),
                  end: s.end - perf.origin,
                  inputTokens: s.usage?.inputTokens ?? 0,
                  cachedTokens: s.usage?.cachedTokens ?? 0,
                  outputTokens: s.usage?.outputTokens ?? 0,
                  reasoningTokens: s.usage?.reasoningTokens ?? 0,
                  toolsExposed: s.toolsExposed,
                  toolCalls: s.toolCalls,
                });
                break;
              }
              case "text": {
                // Voice: the spoken synthesis and the on-screen answer travel separately.
                if (!splitter) {
                  send(event);
                  break;
                }
                const part = splitter.push(event.delta);
                if (part.spoken) send({ type: "spoken", delta: part.spoken });
                if (part.display) send({ type: "text", delta: part.display });
                break;
              }
              case "status":
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
                perf.tool({
                  name: event.name,
                  start: (stepStarted.get(event.callId) ?? Date.now()) - perf.origin,
                  end: perf.now(),
                  ok: event.outcome.status === "succeeded",
                });
                workspace.current = null;
                // A write reconciles every visible Surface that shows what it changed — before
                // the model speaks, so voice, text and Canvas agree (ADR-029).
                const tool = ports.registry.get(event.name);
                const op = tool ? getOperation(tool.capability, tool.operation) : null;
                const change =
                  tool && op && toolCtx
                    ? changeOf(event.name, { name: tool.operation, kind: op.kind }, event.outcome)
                    : null;
                const refreshed = change ? await workspace.reconcile(change, readSurface) : 0;
                const query =
                  op?.kind === "read" && event.args && typeof event.args === "object"
                    ? { tool: event.name, args: event.args as Record<string, unknown> }
                    : null;
                // Every result ELISE fetched is presented by the application, never "drawn".
                const surfaceIds = event.name.startsWith("ui.")
                  ? []
                  : workspace.present(
                      event.name,
                      event.callId,
                      event.outcome,
                      query,
                      refreshed > 0,
                    );
                if (event.name === "meeting.prepare") logMeetingPrep(event.outcome, durationMs);
                if (event.outcome.status === "succeeded" && TOOL_EVENTS[event.name])
                  trackEvent(auth, TOOL_EVENTS[event.name]!, { modality });
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
                finalText = finishSpoken(event.text);
                usage = event.usage;
                model = event.model;
                await persistAssistant(finalText, {
                  tools: [...traces.values()],
                  toolNotes: toolNotes(event.tools),
                });
                break;
              case "error":
                finalText = finishSpoken(event.text);
                failure = event.error;
                await persistAssistant(finalText, {
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
        }

        /**
         * The text kept on screen and in History. A voice reply that was only spoken still
         * shows on screen (the same words), so nothing ELISE said is missing from the thread.
         */
        function finishSpoken(text: string): string {
          if (!splitter) return text;
          const rest = splitter.flush();
          if (rest.spoken) send({ type: "spoken", delta: rest.spoken });
          if (rest.display) send({ type: "text", delta: rest.display });
          const display = splitter.display.trim();
          if (display) return display;
          const spoken = splitter.spoken.trim();
          if (spoken) send({ type: "text", delta: spoken });
          return spoken;
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
          perf.mark("complete");
          perf.intent = workspace.state().intent?.kind ?? null;
          const perfSummary = perf.summary();
          // Numbers and names only (docs/performance).
          logger.info("turn.perf", {
            run_id: runId,
            modality,
            intent: perfSummary.intent,
            ...perfSummary.metrics,
            spans: perfSummary.spans,
            tools: perfSummary.tools.map((t) => `${t.name}:${t.end - t.start}`),
          });
          await Promise.all([
            auth.db
              .from("ai_runs")
              .update({
                status: failure ? "failed" : "completed",
                completed_at: new Date().toISOString(),
                latency_ms: latency,
                token_usage: { ...(usage ?? {}), perf: perfSummary } as unknown as Json,
                tool_call_count: traces.size,
                error_code: failure?.code ?? null,
                ...(model ? { model_key: model } : {}),
              })
              .eq("id", runId),
            thread.touch(),
          ]);
          if (modality === "voice") trackEvent(auth, "voice_used", { failed: Boolean(failure) });
          if (!failure) void trackFirstTurn(auth).catch(() => undefined);
          if ([...traces.values()].some((x) => x.name.startsWith("knowledge.")))
            void syncDueSources(auth.workspaceId).catch(() => 0);
          // History tags (ADR-020): after the reply, from evidence; never delays the turn.
          if (!failure) {
            const sectionOf = (id: string | null | undefined) =>
              contexts.profiles.find((p) => p.id === id)?.section?.spaceId ?? null;
            const active = sectionOf(workspace.state().context?.id);
            const scoped = activeSpace?.id ?? null;
            const strong = [
              ...(active && active !== sectionOf(contextAtStart) ? [active] : []),
              ...(scoped && thread.isNew ? [scoped] : []),
            ];
            void autoLinkThread(auth, thread.ref, {
              activeSpaceIds: active ? [active] : [],
              // The Section the request was resolved to: linked even if its Knowledge
              // had no answer.
              resolvedSpaceIds: mentioned ? [mentioned.id] : [],
              scopedSpaceIds: scoped ? [scoped] : [],
              strongSpaceIds: strong,
            });
          }
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
            // Which tools ran (names only): routing is diagnosable without content.
            tools: [...new Set([...traces.values()].map((x) => x.name))],
            input_tokens: usage?.inputTokens,
            output_tokens: usage?.outputTokens,
            response_chars: finalText.length,
            modality,
            thread: thread.ref.kind,
          });
        }
      }),
  };
}

/**
 * The user's own descriptions of their Spaces/Sections (ADR-020 §9): the active ones in full,
 * up to eight others briefly. Names and the user's words only — never documents.
 */
async function spaceNotes(auth: AuthContext, activeIds: (string | null)[]) {
  const { data } = await auth.db
    .from("knowledge_spaces")
    .select("id, name, parent_space_id, context")
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "active");
  const rows = data ?? [];
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const active = new Set(activeIds.filter(Boolean));
  const path = (r: (typeof rows)[number]) =>
    r.parent_space_id ? `${names.get(r.parent_space_id) ?? ""} › ${r.name}` : r.name;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const withContext = rows.filter((r) => r.context?.trim());
  return [
    ...withContext
      .filter((r) => active.has(r.id))
      .map((r) => ({ path: path(r), context: clip(r.context!.trim(), 2000), active: true })),
    ...withContext
      .filter((r) => !active.has(r.id))
      .slice(0, 8)
      .map((r) => ({ path: path(r), context: clip(r.context!.trim(), 280), active: false })),
  ];
}

/** Product events for tools that mark adoption of a feature (ADR-019). */
const TOOL_EVENTS: Partial<Record<string, "study_started" | "work_brief_run">> = {
  "study.start": "study_started",
  "work.brief": "work_brief_run",
};

/** Activation: the first turn that completed for this user. */
async function trackFirstTurn(auth: AuthContext) {
  const { count } = await auth.db
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.userId)
    .eq("status", "completed");
  if (count === 1) trackEvent(auth, "first_successful_turn");
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
