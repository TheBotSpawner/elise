"use client";

import { useCallback, useRef, useState } from "react";

import type { ChatStreamEvent } from "@/application/chat-protocol";
import { resolveOrbState, type OrbState } from "@/components/elise/orb/orb-states";
import type { ToolDisplay } from "@/core/agents/tools";
import type { SentAttachment } from "@/core/attachments/model";
import type { PublicError } from "@/core/errors";
import {
  threadUrl,
  type ThreadRef,
  type TurnModality,
  type VoiceTurnMeta,
} from "@/core/interaction";
import { WAKE_LABELS, WAKE_PHRASES, type WakePhrase } from "@/core/voice/wake";
import { applyOps, emptyWorkspace, type WorkspaceState } from "@/core/workspace/model";
import { locationForTurn } from "@/features/location/shared-location";
import { VOICE_PREFS_EVENT } from "@/features/voice/voice-controller";
import { applyAppearance } from "@/lib/theme";

import { draftAttachments, type DraftStore } from "./draft-attachments";
import type { ChatMessage } from "./types";

type RunState = "idle" | "thinking" | "using_tools" | "approving";

export interface SendOptions {
  modality?: TurnModality;
  voice?: VoiceTurnMeta;
  /** A GPT-Live delegation (ADR-026): runs through /api/voice/live/delegate, same events. */
  live?: { delegationId: string; sessionId?: string | null };
}

/** No streamed event for this long: the turn is treated as lost (the server caps a turn at 60 s). */
const STREAM_IDLE_MS = 90_000;

export type StreamListener = (
  event:
    | ChatStreamEvent
    | { type: "finished"; failed: boolean }
    /** A turn starts: what was said or typed, and whether it is a live delegation. */
    | { type: "turn_started"; text: string; live: boolean },
) => void;

/**
 * Streams a turn from /api/chat (NDJSON) and keeps the interaction's state. Typed and spoken
 * turns go through here alike (ADR-014); voice listens to the same stream to speak the reply.
 */
export function useEliseChat(initial: {
  /** The draft attachments a sent turn takes (tests pass their own). */
  attachments?: DraftStore;
  /** A History conversation or a voice session; none for a new interaction. */
  thread?: ThreadRef;
  messages?: ChatMessage[];
  /** A new conversation started from a Knowledge Space. */
  spaceId?: string;
  /** The conversation's Live Workspace, restored by the server (ADR-013). */
  workspace?: WorkspaceState;
}) {
  const attachments = initial.attachments ?? draftAttachments;
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages ?? []);
  const [workspace, setWorkspace] = useState<WorkspaceState>(initial.workspace ?? emptyWorkspace());
  /** Set when streamed ops didn't land on the server's version: re-read after the turn. */
  const [outOfSync, setOutOfSync] = useState(false);
  const [runState, setRunState] = useState<RunState>("idle");
  const [lastOutcome, setLastOutcome] = useState<"success" | "error" | null>(null);
  const thread = useRef<ThreadRef | null>(initial.thread ?? null);
  const abort = useRef<AbortController | null>(null);
  /** Read when acting (the thread arrives with the first streamed event). */
  const getThread = useCallback(() => thread.current, []);
  const listeners = useRef(new Set<StreamListener>());
  const subscribe = useCallback((fn: StreamListener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);
  /** A turn sent while another still streams (e.g. the user interrupted ELISE): sent next. */
  const queued = useRef<{ text: string; options: SendOptions } | null>(null);
  /** The text of the turn in flight: the same text again (double Enter, a repeated voice
   * finalization, a reconnect) is a duplicate, not a new turn. */
  const inFlight = useRef<string | null>(null);
  /** A turn waiting for its attachments' uploads. */
  const claiming = useRef<string | null>(null);
  /** A typed turn that failed: the composer offers its text back instead of losing it. */
  const [failedDraft, setFailedDraft] = useState<{ text: string; at: number } | null>(null);

  const patchAssistant = useCallback((id: string, patch: (m: ChatMessage) => ChatMessage) => {
    setMessages((all) => all.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const send = useCallback(
    async function run(text: string, options: SendOptions = {}): Promise<void> {
      const message = text.trim();
      if (!message) return;
      if (abort.current) {
        if (inFlight.current === message || queued.current?.text === message) return;
        queued.current = { text: message, options };
        return;
      }
      if (claiming.current) {
        if (claiming.current !== message) queued.current = { text: message, options };
        return;
      }
      // The draft's attachments belong to this turn, typed or spoken (ADR-031): wait for their
      // uploads; a failed one keeps the turn from going without it.
      claiming.current = message;
      const files = await attachments.take();
      claiming.current = null;
      if (!files) {
        setFailedDraft({ text: message, at: Date.now() });
        return;
      }
      inFlight.current = message;
      const emit = (e: Parameters<StreamListener>[0]) => listeners.current.forEach((fn) => fn(e));
      emit({ type: "turn_started", text: message, live: Boolean(options.live) });
      const sent: SentAttachment[] = files.map((a) => ({
        id: a.id!,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
      }));
      /** The server accepted the turn (its attachments are now part of it). */
      let accepted = false;

      const assistantId = crypto.randomUUID();
      setMessages((all) => [
        ...all,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: message,
          ...(options.modality === "voice" ? { modality: "voice" as const } : {}),
          ...(sent.length ? { attachments: sent } : {}),
          tools: [],
          fresh: true,
          createdAt: new Date().toISOString(),
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          tools: [],
          streaming: true,
          fresh: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      setRunState("thinking");
      setLastOutcome(null);
      const controller = new AbortController();
      abort.current = controller;
      let failed: PublicError | undefined;
      // A stream that goes silent (network dropped mid-turn) must not leave ELISE "thinking".
      let idleTimer = 0;
      let timedOut = false;
      const touch = () => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, STREAM_IDLE_MS);
      };
      touch();
      // Text deltas are applied once per frame: a long answer arriving in a burst (after a
      // research run) committed one render per token and hit React's nested-update limit.
      let pendingText = "";
      let frame = 0;
      const flushText = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        if (!pendingText) return;
        const delta = pendingText;
        pendingText = "";
        patchAssistant(assistantId, (m) => ({ ...m, content: m.content + delta }));
      };

      try {
        const current = thread.current;
        // The device position, refreshed first only for a location question (ADR-028).
        const here = await locationForTurn(message);
        const response = await fetch(options.live ? "/api/voice/live/delegate" : "/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            options.live
              ? {
                  delegationId: options.live.delegationId,
                  conversationId: current?.kind === "conversation" ? current.id : null,
                  sessionId:
                    current?.kind === "session" ? current.id : (options.live.sessionId ?? null),
                  text: message,
                  ...(sent.length ? { attachments: sent.map((a) => a.id) } : {}),
                  ...(here ? { here } : {}),
                }
              : {
                  ...(thread.current?.kind === "conversation"
                    ? { conversationId: thread.current.id }
                    : {}),
                  ...(thread.current?.kind === "session" ? { sessionId: thread.current.id } : {}),
                  message,
                  ...(sent.length ? { attachments: sent.map((a) => a.id) } : {}),
                  ...(!thread.current && initial.spaceId ? { spaceId: initial.spaceId } : {}),
                  ...(options.modality === "voice"
                    ? { modality: "voice", voice: options.voice }
                    : {}),
                  // Only while the user shares it (ADR-023/028).
                  ...(here ? { here } : {}),
                },
          ),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = (await response.json().catch(() => null)) as { error?: PublicError } | null;
          failed = body?.error ?? {
            code: "INTERNAL_ERROR",
            message: "",
            retryable: true,
            recovery: "retry",
            referenceId: "",
          };
          return;
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          touch();
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ChatStreamEvent;
            emit(event);
            switch (event.type) {
              case "conversation":
                accepted = true;
                if (!thread.current) {
                  thread.current = event.thread;
                  // Keep the URL reloadable without remounting (a voice session reopens on Home).
                  window.history.replaceState(null, "", threadUrl(event.thread));
                }
                break;
              case "status":
                setRunState(event.state);
                break;
              case "text":
                pendingText += event.delta;
                if (!frame) frame = requestAnimationFrame(flushText);
                break;
              case "tool_started":
                patchAssistant(assistantId, (m) => ({
                  ...m,
                  tools: [
                    ...m.tools,
                    {
                      callId: event.callId,
                      name: event.name,
                      ...(event.parentId ? { parentId: event.parentId } : {}),
                    },
                  ],
                }));
                break;
              case "workspace": {
                const { ops, version } = event;
                setWorkspace((s) => {
                  const next = applyOps(s, ops);
                  if (next.version !== version) setOutOfSync(true);
                  return next;
                });
                break;
              }
              case "tool_finished":
                // ELISE changed its own appearance: apply the approved values right away.
                if (
                  event.outcome.status === "succeeded" &&
                  event.outcome.display?.kind === "appearance"
                )
                  applyAppearance(event.outcome.display);
                // ELISE changed her wake phrase: the voice session follows without a reload.
                if (
                  event.outcome.status === "succeeded" &&
                  event.outcome.display?.kind === "setting_changed"
                )
                  announceVoicePrefs(event.outcome.display.changes);
                patchAssistant(assistantId, (m) => ({
                  ...m,
                  tools: m.tools.map((t) =>
                    t.callId === event.callId
                      ? {
                          ...t,
                          outcome: event.outcome,
                          durationMs: event.durationMs,
                          ...(event.surfaceIds ? { surfaceIds: event.surfaceIds } : {}),
                        }
                      : t,
                  ),
                }));
                break;
              case "error":
                failed = event.error;
                break;
              case "done":
                if (event.messageId)
                  patchAssistant(assistantId, (m) => ({
                    ...m,
                    serverId: event.messageId ?? undefined,
                  }));
                break;
            }
          }
        }
      } catch (error) {
        if (timedOut || !(error instanceof DOMException && error.name === "AbortError")) {
          failed = {
            code: timedOut ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
            message: "",
            retryable: true,
            recovery: "retry",
            referenceId: "",
          };
        }
      } finally {
        window.clearTimeout(idleTimer);
        inFlight.current = null;
        if (failed && options.modality !== "voice")
          setFailedDraft({ text: message, at: Date.now() });
        // Refused before it started: the files go back to the draft with the text.
        if (accepted) attachments.release(files);
        else attachments.restore(files);
        flushText();
        patchAssistant(assistantId, (m) => ({ ...m, streaming: false, error: failed }));
        setRunState("idle");
        setLastOutcome(failed ? "error" : "success");
        abort.current = null;
        emit({ type: "finished", failed: Boolean(failed) });
        const next = queued.current;
        queued.current = null;
        if (next) void run(next.text, next.options);
      }
    },
    [patchAssistant, initial.spaceId, attachments],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  /** Approvals run outside a chat turn: executing while it runs, then success or error. */
  const trackApproval = useCallback((phase: "start" | "success" | "error") => {
    if (phase === "start") {
      setRunState("approving");
      return;
    }
    setRunState("idle");
    setLastOutcome(phase);
  }, []);

  const waitingApproval = messages.some((m) =>
    m.tools.some((t) => t.outcome?.status === "approval_required" && !t.resolution),
  );

  const markApprovalResolved = useCallback(
    (approvalId: string, decision: "approved" | "rejected", display?: ToolDisplay) => {
      setMessages((all) =>
        all.map((m) => ({
          ...m,
          tools: m.tools.map((tool) =>
            tool.outcome?.status === "approval_required" && tool.outcome.approvalId === approvalId
              ? { ...tool, resolution: { decision, display } }
              : tool,
          ),
        })),
      );
    },
    [],
  );

  // Most important signal wins (motion spec priority).
  const orbState: OrbState = resolveOrbState([
    ...(waitingApproval ? (["waiting_approval"] as const) : []),
    ...(runState === "using_tools" || runState === "approving" ? (["executing"] as const) : []),
    ...(runState === "thinking" ? (["thinking"] as const) : []),
    ...(lastOutcome ? [lastOutcome] : []),
  ]);

  return {
    messages,
    workspace,
    setWorkspace,
    outOfSync,
    clearOutOfSync: () => setOutOfSync(false),
    getThread,
    subscribe,
    send,
    stop,
    failedDraft,
    busy: runState === "thinking" || runState === "using_tools",
    orbState,
    trackApproval,
    markApprovalResolved,
  };
}

function announceVoicePrefs(changes: Extract<ToolDisplay, { kind: "setting_changed" }>["changes"]) {
  const detail: { wakePhrase?: WakePhrase; wakeEnabled?: boolean } = {};
  for (const c of changes) {
    if (c.setting !== "wake_phrase") continue;
    if (c.subject === "enabled") detail.wakeEnabled = c.to === "on";
    else {
      const phrase = WAKE_PHRASES.find((p) => WAKE_LABELS[p] === c.to);
      if (phrase) detail.wakePhrase = phrase;
    }
  }
  if (Object.keys(detail).length)
    window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT, { detail }));
}
