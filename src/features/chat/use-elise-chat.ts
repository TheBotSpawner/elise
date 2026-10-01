"use client";

import { useCallback, useRef, useState } from "react";

import type { ChatStreamEvent } from "@/application/chat-protocol";
import { resolveOrbState, type OrbState } from "@/components/elise/orb/orb-states";
import type { ToolDisplay } from "@/core/agents/tools";
import type { PublicError } from "@/core/errors";
import {
  threadUrl,
  type ThreadRef,
  type TurnModality,
  type VoiceTurnMeta,
} from "@/core/interaction";
import { applyOps, emptyWorkspace, type WorkspaceState } from "@/core/workspace/model";
import { applyAppearance } from "@/lib/theme";

import type { ChatMessage } from "./types";

type RunState = "idle" | "thinking" | "using_tools" | "approving";

export interface SendOptions {
  modality?: TurnModality;
  voice?: VoiceTurnMeta;
}

type StreamListener = (event: ChatStreamEvent | { type: "finished"; failed: boolean }) => void;

/**
 * Streams a turn from /api/chat (NDJSON) and keeps the interaction's state. Typed and spoken
 * turns go through here alike (ADR-014); voice listens to the same stream to speak the reply.
 */
export function useEliseChat(initial: {
  /** A History conversation or a voice session; none for a new interaction. */
  thread?: ThreadRef;
  messages?: ChatMessage[];
  /** A new conversation started from a Knowledge Space. */
  spaceId?: string;
  /** The conversation's Live Workspace, restored by the server (ADR-013). */
  workspace?: WorkspaceState;
}) {
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

  const patchAssistant = useCallback((id: string, patch: (m: ChatMessage) => ChatMessage) => {
    setMessages((all) => all.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const send = useCallback(
    async function run(text: string, options: SendOptions = {}): Promise<void> {
      const message = text.trim();
      if (!message) return;
      if (abort.current) {
        queued.current = { text: message, options };
        return;
      }
      const emit = (e: Parameters<StreamListener>[0]) => listeners.current.forEach((fn) => fn(e));

      const assistantId = crypto.randomUUID();
      setMessages((all) => [
        ...all,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: message,
          ...(options.modality === "voice" ? { modality: "voice" as const } : {}),
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
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(thread.current?.kind === "conversation"
              ? { conversationId: thread.current.id }
              : {}),
            ...(thread.current?.kind === "session" ? { sessionId: thread.current.id } : {}),
            message,
            ...(!thread.current && initial.spaceId ? { spaceId: initial.spaceId } : {}),
            ...(options.modality === "voice" ? { modality: "voice", voice: options.voice } : {}),
          }),
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
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line) as ChatStreamEvent;
            emit(event);
            switch (event.type) {
              case "conversation":
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
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          failed = {
            code: "PROVIDER_UNAVAILABLE",
            message: "",
            retryable: true,
            recovery: "retry",
            referenceId: "",
          };
        }
      } finally {
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
    [patchAssistant, initial.spaceId],
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
    busy: runState === "thinking" || runState === "using_tools",
    orbState,
    trackApproval,
    markApprovalResolved,
  };
}
