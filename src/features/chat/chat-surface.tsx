"use client";

import { ArrowUp, CircleAlert, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";

import { Orb } from "@/components/elise/orb/orb";
import { Button } from "@/components/ui/button";
import type { ToolDisplay } from "@/core/agents/tools";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ToolResults, ToolTrace } from "./tool-cards";
import type { ChatMessage } from "./types";
import { useEliseChat } from "./use-elise-chat";

/**
 * The center of ELISE: one continuous conversation with the Orb as Elise's presence.
 * The Orb reflects the real runtime state (thinking, executing, waiting for approval…).
 */
export function ChatSurface({
  conversationId,
  initialMessages = [],
  timezone,
  greeting,
}: {
  conversationId?: string;
  initialMessages?: ChatMessage[];
  timezone: string;
  greeting?: string;
}) {
  const { t } = useI18n();
  const { messages, send, stop, busy, orbState, setMessages } = useEliseChat({
    conversationId,
    messages: initialMessages,
  });
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function submit(text = draft) {
    if (!text.trim() || busy) return;
    setDraft("");
    void send(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function onApprovalResolved(approvalId: string, display?: ToolDisplay, rejected?: boolean) {
    setMessages((all) =>
      all.map((m) => ({
        ...m,
        tools: m.tools.map((tool) =>
          tool.outcome?.status === "approval_required" && tool.outcome.approvalId === approvalId
            ? {
                ...tool,
                outcome: rejected ? { status: "rejected" } : { status: "succeeded", display },
              }
            : tool,
        ),
      })),
    );
  }

  return (
    <div className="elise-backdrop relative flex min-h-dvh flex-1 flex-col md:min-h-dvh">
      <div
        className={cn(
          "flex flex-col items-center transition-all duration-500",
          empty ? "pt-[14vh]" : "pt-6",
        )}
      >
        <Orb state={orbState} size={empty ? 180 : 76} />
        <AnimatePresence>
          {empty && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-6 px-4 text-center"
            >
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                {greeting ?? t.chat.emptyTitle}
              </h1>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-40 md:px-6">
        {empty ? (
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {t.chat.suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="rounded-full border border-border bg-surface/70 px-3.5 py-2 text-sm text-muted backdrop-blur transition-colors hover:border-accent/50 hover:text-fg"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          <ol className="mt-6 space-y-6" aria-live="polite">
            {messages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                timezone={timezone}
                onApprovalResolved={onApprovalResolved}
              />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <div className="fixed inset-x-0 bottom-16 z-30 px-4 pb-4 md:sticky md:bottom-0 md:px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-surface/90 p-2 shadow-[0_8px_40px_-12px_var(--glow)] backdrop-blur focus-within:border-accent/60"
        >
          <label htmlFor="chat-input" className="sr-only">
            {t.chat.placeholder}
          </label>
          <textarea
            id="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={8000}
            placeholder={t.chat.placeholder}
            className="[field-sizing:content] max-h-40 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted/70"
          />
          {busy ? (
            <Button size="icon" variant="secondary" onClick={stop} aria-label={t.chat.stop}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!draft.trim()} aria-label={t.chat.send}>
              <ArrowUp />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

function MessageItem({
  message,
  timezone,
  onApprovalResolved,
}: {
  message: ChatMessage;
  timezone: string;
  onApprovalResolved: (approvalId: string, display?: ToolDisplay, rejected?: boolean) => void;
}) {
  const { t } = useI18n();
  if (message.role === "user") {
    return (
      <li className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </p>
      </li>
    );
  }

  const thinking = message.streaming && !message.content && message.tools.length === 0;
  return (
    <li className="space-y-3">
      <ToolTrace tools={message.tools} running={Boolean(message.streaming)} />
      <ToolResults
        tools={message.tools}
        timezone={timezone}
        onApprovalResolved={onApprovalResolved}
      />
      {thinking && <p className="animate-pulse text-sm text-muted">{t.chat.thinking}</p>}
      {message.content && (
        <div className="prose-elise text-sm leading-relaxed">
          <Markdown
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-accent underline"
                >
                  {children}
                </a>
              ),
            }}
          >
            {message.content}
          </Markdown>
        </div>
      )}
      {message.error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {message.error.code === "AI_NOT_CONFIGURED"
              ? t.chat.aiNotConfigured
              : t.errors.codes[message.error.code]}
            {message.error.referenceId && (
              <span className="ml-2 font-mono text-xs text-muted">{`${t.chat.reference}: ${message.error.referenceId}`}</span>
            )}
          </span>
        </p>
      )}
    </li>
  );
}
