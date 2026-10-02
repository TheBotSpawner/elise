"use client";

import { Copy, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { MessageThread, type ThreadHandlers } from "@/features/chat/message-thread";
import type { ChatMessage } from "@/features/chat/types";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { EASE } from "./motion";

/**
 * The transcript, secondary to the Canvas (ADR-021): a drawer on the right on large screens, a
 * sheet on phones. Closing it returns to exactly the same Canvas — it never owns workspace
 * state. Everything said or typed stays readable, copyable and inspectable here.
 */
export function TranscriptPanel({
  open,
  onClose,
  messages,
  timezone,
  handlers,
  mobile,
}: {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  timezone: string;
  handlers: ThreadHandlers;
  mobile: boolean;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  const last = messages.at(-1);
  const signature = `${messages.length}:${last?.content.length ?? 0}`;
  useEffect(() => {
    if (open) body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [open, signature]);
  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const copy = async () => {
    const text = messages
      .map((m) => `${m.role === "user" ? t.canvas.you : "ELISE"}: ${m.content}`)
      .join("\n\n");
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="transcript"
          aria-labelledby="canvas-transcript-title"
          initial={reduced ? { opacity: 0 } : mobile ? { y: "100%" } : { opacity: 0, x: 24 }}
          animate={reduced ? { opacity: 1 } : mobile ? { y: 0 } : { opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0 } : mobile ? { y: "100%" } : { opacity: 0, x: 24 }}
          transition={{ duration: 0.28, ease: EASE }}
          className={cn(
            "fixed z-40 flex flex-col border border-border bg-[var(--drawer-bg)] shadow-[var(--dock-shadow)] backdrop-blur-xl",
            mobile
              ? "inset-x-0 bottom-0 h-[72dvh] rounded-t-[22px] border-b-0"
              : "top-24 right-4 bottom-4 w-[384px] rounded-[20px]",
          )}
        >
          {mobile && (
            <span aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-border-strong" />
          )}
          <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[var(--sf-ambient-line)] pr-2.5 pl-5">
            <h2
              id="canvas-transcript-title"
              ref={heading}
              tabIndex={-1}
              className="text-[15px] font-medium outline-none"
            >
              {t.canvas.transcript}
            </h2>
            <span className="font-mono text-[10.5px] tracking-[0.12em] text-faint">
              {messages.length}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={t.canvas.copyTranscript}
              title={copied ? t.canvas.copied : t.canvas.copyTranscript}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-active hover:text-fg"
            >
              <Copy className="size-[15px]" aria-hidden />
            </button>
            <span aria-live="polite" className="sr-only">
              {copied ? t.canvas.copied : ""}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t.canvas.closeTranscript}
              className="grid size-9 place-items-center rounded-lg text-muted hover:bg-active hover:text-fg"
            >
              <X className="size-[15px]" aria-hidden />
            </button>
          </div>
          <div
            ref={body}
            className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto overscroll-contain pb-6"
          >
            <div className="px-5">
              <MessageThread messages={messages} timezone={timezone} column handlers={handlers} />
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
