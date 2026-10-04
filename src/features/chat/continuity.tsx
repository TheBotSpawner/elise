"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { ComposeIcon } from "@/components/elise/icons";
import type { ThreadRef } from "@/core/interaction";
import {
  activeThreadSnapshot,
  forgetThread,
  parseThread,
  subscribeActiveThread,
} from "@/lib/active-thread";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { draftAttachments } from "./draft-attachments";

/** The tab's active interaction (ADR-032); null on the server and in a fresh tab. */
export function useActiveThread(): ThreadRef | null {
  const raw = useSyncExternalStore(subscribeActiveThread, activeThreadSnapshot, () => null);
  return useMemo(() => parseThread(raw), [raw]);
}

/** What the composer holds right now (the dock writes it): New Chat never drops it silently. */
export const composerDraft = { text: "" };

export function hasUnsentDraft() {
  return composerDraft.text.trim() !== "" || draftAttachments.get().items.length > 0;
}

/**
 * Starts a fresh conversation: forgets the tab's active one (it stays in History, untouched),
 * discards the empty draft and opens a clean Home. Nothing is created until the first message.
 */
export function useStartNewChat() {
  const router = useRouter();
  return () => {
    forgetThread();
    draftAttachments.clear();
    composerDraft.text = "";
    // A distinct URL remounts Home even when it is already showing (the ?new mark is dropped on
    // arrival).
    router.push(`/?new=${Date.now().toString(36)}`);
  };
}

/**
 * Tapping Inicio while already on Home, in a conversation, starts a new one (the same as
 * "+ Nueva conversación"). With an unsent draft it just stays: a nav tap never discards text.
 */
export function useHomeNavClick(onHome: boolean) {
  const start = useStartNewChat();
  const active = useActiveThread();
  return (e: { preventDefault(): void }) => {
    if (!onHome || !active || hasUnsentDraft()) return;
    e.preventDefault();
    start();
  };
}

/**
 * "+ Nueva conversación": visible on Home whenever there is a conversation to leave. With an
 * unsent draft, the first press asks (inline, no modal) and the second one discards it.
 */
export function NewChatButton({ variant = "pill" }: { variant?: "pill" | "icon" }) {
  const { t } = useI18n();
  const start = useStartNewChat();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 5_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  const onClick = () => {
    if (!confirming && hasUnsentDraft()) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    start();
  };
  const label = confirming ? t.chat.discardDraftNew : t.chat.newChat;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={variant === "icon" ? label : undefined}
      title={label}
      className={cn(
        variant === "icon"
          ? "grid size-11 place-items-center text-muted"
          : "flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] backdrop-blur-xl transition-colors",
        variant === "pill" &&
          (confirming
            ? "border-approval-line bg-approval-bg text-approval-text"
            : "border-border bg-glass text-fg2 hover:border-accent-line hover:text-fg"),
        variant === "icon" && confirming && "text-approval-text",
      )}
    >
      {variant === "icon" ? <ComposeIcon /> : <Plus className="size-3.5" aria-hidden />}
      {variant === "pill" && <span aria-live="polite">{label}</span>}
    </button>
  );
}
