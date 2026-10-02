"use client";

import { Keyboard, ListCollapse, MicOff, Mic, Square, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { SendIcon } from "@/components/elise/icons";
import { Orb } from "@/components/elise/orb/orb";
import { ORB_LAYOUT_ID } from "@/components/elise/orb/orb-presence";
import type { OrbState } from "@/components/elise/orb/orb-states";
import { isHearing, type VoiceState } from "@/core/voice/session";
import { AttachToKnowledge } from "@/features/knowledge/attach-dialog";
import { MicButton, type VoiceHandlers } from "@/features/voice/voice-controls";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ORB_MOVE } from "./motion";

export interface DockCaption {
  who: "ELISE" | "YOU" | null;
  text: string;
  tone?: "plain" | "approval" | "problem";
}

/**
 * The presence dock (reference "presence bar"): ELISE's Orb, what is being said, and the few
 * controls that matter. Voice-first — the microphone is the main control — with typing one tap
 * away (and the default when voice is off). Never a chat composer.
 */
export function Dock({
  orbState,
  level,
  showOrb,
  controlsOnly,
  caption,
  mobile,
  voice,
  busy,
  onSend,
  onStop,
  offline,
  restore,
  transcript,
  above,
  inline = false,
  besideDrawer = false,
}: {
  orbState: OrbState;
  level: { readonly current: number };
  showOrb: boolean;
  /** Spatial: ELISE's presence sits in the canvas; the dock keeps only its controls. */
  controlsOnly: boolean;
  caption: DockCaption;
  mobile: boolean;
  voice: { state: VoiceState; handlers: VoiceHandlers } | null;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  offline: boolean;
  restore: { text: string; at: number } | null;
  transcript: { open: boolean; count: number; onToggle: () => void } | null;
  /** Activity steps or the shelf of Surfaces with no room on this screen. */
  above?: ReactNode;
  /** Idle Home on larger screens: the input sits under the headline, not at the bottom. */
  inline?: boolean;
  /** The desktop transcript drawer is open: centre in the space left of it. */
  besideDrawer?: boolean;
}) {
  const { t } = useI18n();
  const [typing, setTyping] = useState(!voice);
  const [draft, setDraft] = useState("");
  const [restoredAt, setRestoredAt] = useState(restore?.at ?? 0);
  const input = useRef<HTMLTextAreaElement>(null);
  if (restore && restore.at !== restoredAt) {
    setRestoredAt(restore.at);
    if (!draft.trim()) setDraft(restore.text);
    if (!typing) setTyping(true);
  }
  // Without voice, typing is the only way in.
  const typingMode = typing || !voice;
  useEffect(() => {
    if (typing && voice) input.current?.focus();
  }, [typing, voice]);

  const submit = () => {
    if (!draft.trim() || busy || offline) return;
    onSend(draft);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape" && voice) setTyping(false);
  };
  const session = voice && voice.state.phase !== "idle" && voice.state.phase !== "error";
  const hearing = voice ? isHearing(voice.state) : false;
  const orbSize = mobile ? 56 : 72;

  return (
    <div
      className={cn(
        "pointer-events-none z-30 flex flex-col items-center gap-2.5",
        inline
          ? "relative mt-9 w-full"
          : cn("fixed inset-x-3 md:inset-x-0", besideDrawer && "md:right-[400px]"),
        !inline && (mobile ? "bottom-[max(14px,env(safe-area-inset-bottom))]" : "bottom-6"),
      )}
    >
      {above && (
        <div className="pointer-events-auto flex w-full max-w-[min(960px,100%)] justify-center">
          {above}
        </div>
      )}
      <motion.form
        layout
        transition={ORB_MOVE}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        aria-label={t.canvas.label}
        className={cn(
          "pointer-events-auto flex w-full items-center border border-border-strong bg-[var(--dock-bg)] shadow-[var(--dock-shadow)] backdrop-blur-xl focus-within:border-accent-line",
          mobile
            ? "min-h-16 gap-2 rounded-[32px] py-1 pr-2.5 pl-1"
            : "min-h-[72px] gap-2.5 rounded-[36px] pr-3.5 pl-1",
          controlsOnly && !typingMode
            ? "max-w-[360px] pl-3"
            : inline
              ? "min-h-14 rounded-[28px] pl-5 md:w-[620px]"
              : "md:w-[760px] md:max-w-[calc(100vw-48px)]",
          !showOrb && !controlsOnly && "pl-5",
        )}
      >
        {showOrb && !controlsOnly && (
          <motion.div
            layoutId={ORB_LAYOUT_ID}
            transition={ORB_MOVE}
            className="shrink-0"
            style={{ width: orbSize, height: orbSize }}
          >
            <Orb state={orbState} size={orbSize} levelSource={level} />
          </motion.div>
        )}
        {typingMode ? (
          <>
            <label htmlFor="elise-ask" className="sr-only">
              {t.chat.placeholder}
            </label>
            <textarea
              id="elise-ask"
              ref={input}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              maxLength={8000}
              autoComplete="off"
              placeholder={mobile ? t.home.placeholderMobile : t.chat.replyPlaceholder}
              className="[field-sizing:content] max-h-40 min-h-11 min-w-0 flex-1 resize-none bg-transparent py-[11px] text-[15.5px] leading-[22px] caret-accent outline-none placeholder:text-faint focus-visible:shadow-none"
            />
          </>
        ) : controlsOnly ? (
          <span className="flex-1 truncate font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
            {caption.text || t.canvas.ask}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setTyping(true)}
            aria-live="polite"
            className="flex min-w-0 flex-1 flex-col gap-[3px] py-2 text-left"
          >
            {caption.who && (
              <span
                className={cn(
                  "font-mono text-[10px] tracking-[0.16em] uppercase",
                  caption.tone === "approval"
                    ? "text-approval-text"
                    : caption.who === "YOU"
                      ? "text-fg2"
                      : "text-accent-text",
                )}
              >
                {caption.who === "YOU" ? t.canvas.you : "ELISE"}
              </span>
            )}
            <span
              className={cn(
                "line-clamp-2 leading-[1.38]",
                mobile ? "text-[13.5px]" : "text-[15px]",
                caption.tone === "problem"
                  ? "text-approval-text"
                  : caption.who
                    ? "text-fg"
                    : "text-faint",
              )}
            >
              {caption.text || (mobile ? t.canvas.askMobile : t.canvas.ask)}
            </span>
          </button>
        )}
        <span className="flex shrink-0 items-center gap-1">
          {!mobile && <AttachToKnowledge />}
          {voice && (
            <button
              type="button"
              aria-label={t.canvas.typeInstead}
              aria-pressed={typingMode}
              title={t.canvas.typeInstead}
              onClick={() => setTyping((v) => !v)}
              className={cn(
                "grid size-10 place-items-center rounded-full text-muted hover:text-fg",
                typingMode && "bg-accent-soft text-accent-text",
              )}
            >
              <Keyboard className="size-[18px]" aria-hidden />
            </button>
          )}
          {session && hearing && (
            <button
              type="button"
              aria-label={voice.state.phase === "muted" ? t.voice.unmute : t.voice.mute}
              title={voice.state.phase === "muted" ? t.voice.unmute : t.voice.mute}
              onClick={voice.handlers.toggleMute}
              className="hidden size-10 place-items-center rounded-full text-muted hover:text-fg sm:grid"
            >
              <MicOff className="size-4" aria-hidden />
            </button>
          )}
          {busy && (
            <button
              type="button"
              onClick={onStop}
              aria-label={t.canvas.stop}
              title={t.canvas.stop}
              className="grid size-10 place-items-center rounded-full border border-border text-fg"
            >
              <Square className="size-3 fill-current" aria-hidden />
            </button>
          )}
          {typingMode && !busy && (
            <button
              type="submit"
              aria-label={t.canvas.send}
              disabled={!draft.trim() || offline}
              title={offline ? t.chat.offline : t.canvas.send}
              className="grid size-10 place-items-center rounded-full bg-fg text-bg disabled:opacity-40"
            >
              <SendIcon />
            </button>
          )}
          {voice && <MicButton state={voice.state} handlers={voice.handlers} />}
          {!voice && !typingMode && (
            <span className="grid size-11 place-items-center text-faint">
              <Mic className="size-[18px]" aria-hidden />
            </span>
          )}
          {session && (
            <button
              type="button"
              aria-label={t.voice.end}
              title={t.voice.end}
              onClick={voice.handlers.end}
              className="grid size-9 place-items-center rounded-full text-muted hover:bg-active hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
          {transcript && !mobile && (
            <button
              type="button"
              aria-label={transcript.open ? t.canvas.closeTranscript : t.canvas.openTranscript}
              aria-expanded={transcript.open}
              onClick={transcript.onToggle}
              className={cn(
                "flex h-10 items-center gap-2 rounded-full border px-3 text-[12.5px] text-fg2",
                transcript.open ? "border-accent-line bg-accent-soft" : "border-border",
              )}
            >
              <ListCollapse className="size-[15px]" aria-hidden />
              <span className="font-mono text-[11px]">{transcript.count}</span>
            </button>
          )}
        </span>
      </motion.form>
      {transcript && mobile && (
        <button
          type="button"
          onClick={transcript.onToggle}
          aria-expanded={transcript.open}
          className="pointer-events-auto -mt-1 flex h-7 items-center gap-1.5 rounded-full px-3 font-mono text-[10.5px] tracking-[0.12em] text-muted uppercase"
        >
          <ListCollapse className="size-3.5" aria-hidden />
          {t.canvas.transcript} · {transcript.count}
        </button>
      )}
    </div>
  );
}
