"use client";

import { Mic, MicOff, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { VoiceState } from "@/core/voice/session";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface VoiceHandlers {
  start: () => void;
  end: () => void;
  interrupt: () => void;
  finishNow: () => void;
  toggleMute: () => void;
}

/**
 * The microphone in the composer. One button, one meaning at a time: start talking, end my
 * turn, interrupt ELISE, or unmute. Never opens the microphone without this tap.
 */
export function MicButton({ state, handlers }: { state: VoiceState; handlers: VoiceHandlers }) {
  const { t } = useI18n();
  const { phase } = state;
  const label =
    phase === "idle"
      ? t.voice.start
      : phase === "listening"
        ? t.voice.finish
        : phase === "muted"
          ? t.voice.unmute
          : phase === "speaking" || phase === "thinking"
            ? t.voice.interrupt
            : t.voice.transcribing;
  const onClick =
    phase === "idle"
      ? handlers.start
      : phase === "listening"
        ? handlers.finishNow
        : phase === "muted"
          ? handlers.toggleMute
          : phase === "speaking" || phase === "thinking"
            ? handlers.interrupt
            : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={label}
      title={label}
      aria-pressed={phase !== "idle"}
      className={cn(
        "relative grid size-11 shrink-0 place-items-center rounded-full transition-colors",
        phase === "idle" && "text-muted hover:bg-active hover:text-fg",
        phase === "listening" && "bg-accent text-accent-fg",
        phase === "muted" && "bg-surface-2 text-muted",
        (phase === "speaking" || phase === "thinking" || phase === "transcribing") &&
          "bg-accent-soft text-accent-text",
      )}
    >
      {phase === "listening" && (
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full bg-accent/30 motion-reduce:hidden"
        />
      )}
      {phase === "muted" ? (
        <MicOff className="relative size-[18px]" aria-hidden />
      ) : phase === "speaking" ? (
        <Square className="relative size-3.5 fill-current" aria-hidden />
      ) : (
        <Mic className="relative size-[18px]" aria-hidden />
      )}
    </button>
  );
}

/**
 * While a voice session is open: what ELISE is doing, the words as they are recognized, and
 * the few controls that matter. Always visible — the user always knows the mic is on.
 */
export function VoiceBar({ state, handlers }: { state: VoiceState; handlers: VoiceHandlers }) {
  const { t } = useI18n();
  const active = state.phase !== "idle";
  const problem = state.problem ? t.voice.problems[state.problem] : null;
  const status = t.voice.phases[state.phase];
  return (
    <AnimatePresence initial={false}>
      {(active || problem) && (
        <motion.div
          key="voice-bar"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6, transition: { duration: 0.14 } }}
          transition={{ duration: 0.2, ease: EASE }}
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-full border border-border-strong bg-[var(--menu-bg)] py-1 pr-1 pl-4 text-[13px] backdrop-blur"
        >
          {active && (
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                state.phase === "listening"
                  ? "animate-pulse bg-accent"
                  : state.phase === "muted"
                    ? "bg-faint"
                    : "bg-accent/60",
              )}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {active && <span className="type-status text-[11px] text-muted">{status}</span>}
            {state.partial && <span className="ml-2 text-muted italic">“{state.partial}”</span>}
            {problem && (
              <span className={cn(active && "ml-2", "text-approval-text")}>{problem}</span>
            )}
          </span>
          {active && (
            <>
              {(state.phase === "listening" || state.phase === "muted") && (
                <IconButton
                  label={state.phase === "muted" ? t.voice.unmute : t.voice.mute}
                  onClick={handlers.toggleMute}
                >
                  {state.phase === "muted" ? (
                    <Mic className="size-4" />
                  ) : (
                    <MicOff className="size-4" />
                  )}
                </IconButton>
              )}
              {state.phase === "speaking" && (
                <IconButton label={t.voice.stopSpeaking} onClick={handlers.interrupt}>
                  <Square className="size-3.5 fill-current" />
                </IconButton>
              )}
              <IconButton label={t.voice.end} onClick={handlers.end}>
                <X className="size-4" />
              </IconButton>
            </>
          )}
          {!active && (
            // A notice after the session (e.g. microphone blocked) can be dismissed.
            <IconButton label={t.common.close} onClick={handlers.end}>
              <X className="size-4" />
            </IconButton>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg [&>svg]:shrink-0"
    >
      {children}
    </button>
  );
}
