"use client";

import { Mic, MicOff, Square, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import {
  isHearing,
  isReplying,
  micCapturing,
  wakeListening,
  type VoiceState,
} from "@/core/voice/session";
import { WAKE_LABELS, type WakePhrase } from "@/core/voice/wake";
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
 * The microphone in the composer. One button, one meaning at a time: start talking (or wake a
 * sleeping session), end my turn, interrupt ELISE, or unmute. Never opens the microphone
 * without this tap — or the on-device wake phrase the user turned on.
 */
export function MicButton({ state, handlers }: { state: VoiceState; handlers: VoiceHandlers }) {
  const { t } = useI18n();
  const { phase } = state;
  const hearing = isHearing(state);
  const replying = isReplying(state);
  const startable = phase === "idle" || phase === "error" || phase === "sleeping";
  const label = startable
    ? t.voice.start
    : hearing
      ? t.voice.finish
      : phase === "muted"
        ? t.voice.unmute
        : replying
          ? t.voice.interrupt
          : t.voice.phases[phase] || t.voice.start;
  const onClick = startable
    ? handlers.start
    : hearing
      ? handlers.finishNow
      : phase === "muted"
        ? handlers.toggleMute
        : replying
          ? handlers.interrupt
          : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={label}
      title={label}
      aria-pressed={!startable}
      className={cn(
        "relative grid size-11 shrink-0 place-items-center rounded-full transition-colors",
        startable && "text-muted hover:bg-active hover:text-fg",
        hearing && "bg-accent text-accent-fg",
        phase === "muted" && "bg-surface-2 text-muted",
        (replying || phase === "finalizing_input" || phase === "arming") &&
          "bg-accent-soft text-accent-text",
      )}
    >
      {hearing && (
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full bg-accent/30 motion-reduce:hidden"
        />
      )}
      {phase === "muted" ? (
        <MicOff className="relative size-[18px]" aria-hidden />
      ) : replying ? (
        <Square className="relative size-3.5 fill-current" aria-hidden />
      ) : (
        <Mic className="relative size-[18px]" aria-hidden />
      )}
    </button>
  );
}

/**
 * While a voice session exists: what ELISE is doing, the words as they are recognized, and
 * the few controls that matter. Always visible — the dot says whether the microphone is
 * capturing for ELISE right now, and asleep it says what (if anything) is still listening.
 */
export function VoiceBar({
  state,
  handlers,
  wakePhrase,
}: {
  state: VoiceState;
  handlers: VoiceHandlers;
  wakePhrase: WakePhrase;
}) {
  const { t } = useI18n();
  const active = state.phase !== "idle" && state.phase !== "error";
  const problem = state.problem ? t.voice.problems[state.problem] : null;
  const capturing = micCapturing(state);
  const status =
    state.phase === "sleeping"
      ? wakeListening(state)
        ? t.voice.asleepWake(WAKE_LABELS[wakePhrase])
        : t.voice.asleep
      : t.voice.phases[state.phase];
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
              title={capturing ? t.voice.micOn : t.voice.micOff}
              className={cn(
                "size-2 shrink-0 rounded-full",
                capturing
                  ? "animate-pulse bg-accent"
                  : wakeListening(state)
                    ? "bg-accent/40"
                    : "bg-faint",
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
              {(isHearing(state) || state.phase === "muted") && (
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
              {isReplying(state) && (
                <IconButton label={t.voice.stopSpeaking} onClick={handlers.interrupt}>
                  <Square className="size-3.5 fill-current" />
                </IconButton>
              )}
              {state.phase === "sleeping" && (
                <IconButton label={t.voice.start} onClick={handlers.start}>
                  <Mic className="size-4" />
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
