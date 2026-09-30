"use client";

import { useCallback, useRef, useState } from "react";

import type { ChatStreamEvent } from "@/application/chat-protocol";
import { resolveOrbState, type OrbState } from "@/components/elise/orb/orb-states";
import type { ToolDisplay } from "@/core/agents/tools";
import type { PublicError } from "@/core/errors";
import { applyOps, emptyWorkspace, type WorkspaceState } from "@/core/workspace/model";
import { applyAppearance } from "@/lib/theme";

import type { ChatMessage } from "./types";

type RunState = "idle" | "thinking" | "using_tools" | "approving";

/** Streams a chat turn from /api/chat (NDJSON) and keeps the conversation state. */
export function useEliseChat(initial: {
  conversationId?: string;
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
  const conversationId = useRef(initial.conversationId);
  const abort = useRef<AbortController | null>(null);
  /** Read when acting (the id arrives with the first streamed event). */
  const getConversationId = useCallback(() => conversationId.current ?? null, []);

  const patchAssistant = useCallback((id: string, patch: (m: ChatMessage) => ChatMessage) => {
    setMessages((all) => all.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || abort.current) return;

      const assistantId = crypto.randomUUID();
      setMessages((all) => [
        ...all,
        {
          id: crypto.randomUUID(),
          role: "user",
          content: message,
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

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationId.current,
            message,
            ...(!conversationId.current && initial.spaceId ? { spaceId: initial.spaceId } : {}),
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
            switch (event.type) {
              case "conversation":
                if (!conversationId.current) {
                  conversationId.current = event.conversationId;
                  // Keep the URL shareable/reloadable without remounting the chat.
                  window.history.replaceState(null, "", `/chat/${event.conversationId}`);
                }
                break;
              case "status":
                setRunState(event.state);
                break;
              case "text":
                patchAssistant(assistantId, (m) => ({ ...m, content: m.content + event.delta }));
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
        patchAssistant(assistantId, (m) => ({ ...m, streaming: false, error: failed }));
        setRunState("idle");
        setLastOutcome(failed ? "error" : "success");
        abort.current = null;
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
    getConversationId,
    send,
    stop,
    busy: runState === "thinking" || runState === "using_tools",
    orbState,
    trackApproval,
    markApprovalResolved,
  };
}
