"use client";

import { motion } from "motion/react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { SendIcon, StopIcon } from "@/components/elise/icons";
import { AttachToKnowledge } from "@/features/knowledge/attach-dialog";
import { cn } from "@/lib/utils";

/**
 * Input dock (reference: 720 × 60 pill, radius 30; mobile 56 / 28). Shared between Home and the
 * conversation so it can glide from the hero to the bottom dock (layoutId, motion spec).
 * The microphone starts a voice session (ADR-014). Attaching asks what to do with the file.
 */
export function Composer({
  placeholder,
  label,
  busy,
  onSend,
  onStop,
  sendLabel,
  stopLabel,
  voice,
  className,
}: {
  placeholder: string;
  label: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  sendLabel: string;
  stopLabel: string;
  /** The microphone control, when voice is available. */
  voice?: ReactNode;
  className?: string;
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <motion.form
      layoutId="elise-composer"
      transition={{ duration: 0.48, ease: [0.22, 1, 0.36, 1] }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        "flex min-h-14 w-full items-end gap-0.5 rounded-[28px] border border-border-strong bg-[var(--input-bg)] py-1.5 pr-1.5 pl-1.5 backdrop-blur-lg md:min-h-15 md:gap-1 md:rounded-[30px] md:pr-2 md:pl-2",
        className,
      )}
    >
      <AttachToKnowledge />
      <label htmlFor="elise-ask" className="sr-only">
        {label}
      </label>
      <textarea
        id="elise-ask"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        maxLength={8000}
        autoComplete="off"
        placeholder={placeholder}
        className="[field-sizing:content] max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-base leading-[22px] caret-accent outline-none placeholder:text-muted"
      />
      {voice}
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          aria-label={stopLabel}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-fg text-bg"
        >
          <StopIcon />
        </button>
      ) : (
        <button
          type="submit"
          aria-label={sendLabel}
          disabled={!draft.trim()}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-fg text-bg"
        >
          <SendIcon />
        </button>
      )}
    </motion.form>
  );
}
