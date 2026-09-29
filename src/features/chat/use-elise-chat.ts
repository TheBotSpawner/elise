"use client";

import { useCallback, useRef, useState } from "react";

import type { ChatStreamEvent } from "@/application/chat-protocol";
import type { OrbState } from "@/components/elise/orb/orb-states";
import type { PublicError } from "@/core/errors";

import type { ChatMessage } from "./types";

type RunState = "idle" | "thinking" | "using_tools";

/** Streams a chat turn from /api/chat (NDJSON) and keeps the conversation state. */
export function useEliseChat(initial: { conversationId?: string; messages?: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial.messages ?? []);
  const [runState, setRunState] = useState<RunState>("idle");
  const [lastOutcome, setLastOutcome] = useState<"success" | "error" | null>(null);
  const conversationId = useRef(initial.conversationId);
  const abort = useRef<AbortController | null>(null);

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
        { id: crypto.randomUUID(), role: "user", content: message, tools: [] },
        { id: assistantId, role: "assistant", content: "", tools: [], streaming: true },
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
          body: JSON.stringify({ conversationId: conversationId.current, message }),
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
                  tools: [...m.tools, { callId: event.callId, name: event.name }],
                }));
                break;
              case "tool_finished":
                patchAssistant(assistantId, (m) => ({
                  ...m,
                  tools: m.tools.map((t) =>
                    t.callId === event.callId ? { ...t, outcome: event.outcome } : t,
                  ),
                }));
                break;
              case "error":
                failed = event.error;
                break;
              case "done":
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
    [patchAssistant],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  const waitingApproval = messages.some((m) =>
    m.tools.some((t) => t.outcome?.status === "approval_required"),
  );

  const orbState: OrbState =
    runState === "thinking"
      ? "thinking"
      : runState === "using_tools"
        ? "executing"
        : lastOutcome === "error"
          ? "error"
          : waitingApproval
            ? "waiting_approval"
            : lastOutcome === "success"
              ? "success"
              : "idle";

  return { messages, send, stop, busy: runState !== "idle", orbState, setMessages };
}
