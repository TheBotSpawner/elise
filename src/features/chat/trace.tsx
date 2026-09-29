"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import type { ClientToolTrace } from "@/application/chat-protocol";
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PauseIcon,
  RunningIcon,
} from "@/components/elise/icons";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

function formatSeconds(ms: number | undefined): string {
  return ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Tool execution trace (reference Chat). Live while running: rows enter with an 80 ms stagger,
 * the running icon turns once per 900 ms. Collapses to its summary 1.5 s after the final answer.
 */
export function ToolTrace({ tools, running }: { tools: ClientToolTrace[]; running: boolean }) {
  const { t } = useI18n();
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(running);
  const [wasRunning, setWasRunning] = useState(running);

  // Open while running; auto-collapse 1.5 s after the answer completes.
  if (running !== wasRunning) {
    setWasRunning(running);
    if (running) setOpen(true);
  }
  useEffect(() => {
    if (running || !wasRunning) return;
    const timer = setTimeout(() => setOpen(false), 1500);
    return () => clearTimeout(timer);
  }, [running, wasRunning]);

  if (tools.length === 0) return null;
  const waiting = tools.filter((s) => s.outcome?.status === "approval_required").length;
  const done = tools.length - waiting;
  const total = tools.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  return (
    <section
      aria-label={t.chat.traceLabel}
      className="overflow-hidden rounded-[14px] border border-border bg-surface"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-full items-center gap-2.5 px-4 text-left text-[13px] text-muted"
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        {desktop || waiting === 0 ? (
          <span className="text-fg">{t.chat.steps(tools.length)}</span>
        ) : (
          <>
            <span className="text-fg">{t.chat.stepsDone(done)}</span>
            <span aria-hidden>·</span>
            <span className="text-approval-text">{t.chat.waitingCount(waiting)}</span>
          </>
        )}
        {total > 0 && <span className="font-mono text-[11.5px]">{formatSeconds(total)}</span>}
        <span className="ml-auto text-[12.5px]">{open ? t.chat.hide : t.chat.show}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ol
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex flex-col pb-2"
          >
            {tools.map((step, i) => (
              <TraceRow key={step.callId} step={step} index={i} />
            ))}
          </motion.ol>
        )}
      </AnimatePresence>
    </section>
  );
}

function TraceRow({ step, index }: { step: ClientToolTrace; index: number }) {
  const { t } = useI18n();
  const o = step.outcome;
  const kind = !o
    ? "running"
    : o.status === "approval_required"
      ? "waiting"
      : o.status === "succeeded"
        ? "done"
        : "failed";

  let detail = "";
  if (!o) detail = "…";
  else if (o.status === "approval_required") detail = t.approvals.waitingDetail;
  else if (o.status === "failed") detail = t.errors.codes[o.error.code];
  else if (o.status === "rejected" || o.status === "clarification_required")
    detail = t.errors.codes.PERMISSION_DENIED;
  else if (o.display?.kind === "task") detail = o.display.task.title;
  else if (o.display?.kind === "task_list") detail = t.home.pending(o.display.tasks.length);
  else if (o.display?.kind === "event") detail = o.display.event.title;
  else if (o.display?.kind === "event_list")
    detail = `${t.calendar.agenda} · ${o.display.events.length}`;
  else if (o.display?.kind === "email_list") detail = t.email.results(o.display.messages.length);
  else if (o.display?.kind === "email_thread") detail = o.display.thread.subject;
  else if (o.display?.kind === "email_draft") detail = o.display.draft.subject;
  else if (o.display?.kind === "email_followups") detail = String(o.display.items.length);
  else if (o.display?.kind === "availability")
    detail = `${t.calendar.free} · ${o.display.free.length}`;

  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE, delay: index * 0.08 }}
      className="grid h-9 grid-cols-[22px_minmax(0,auto)_minmax(0,1fr)_48px] items-center gap-x-2.5 px-4 text-[13px] md:grid-cols-[22px_200px_minmax(0,1fr)_64px]"
    >
      <span className="relative flex size-[15px] items-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={kind}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className={cn(
              "absolute inset-0 flex items-center",
              kind === "done" && "text-muted",
              kind === "waiting" && "text-approval",
              kind === "running" && "text-accent",
              kind === "failed" && "text-danger",
            )}
          >
            {kind === "done" && <CheckIcon />}
            {kind === "waiting" && <PauseIcon />}
            {kind === "failed" && <AlertIcon />}
            {kind === "running" && (
              <motion.span
                className="flex"
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
              >
                <RunningIcon />
              </motion.span>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="truncate font-mono text-[12.5px]">{step.name}</span>
      <span className={cn("truncate", kind === "waiting" ? "text-approval-text" : "text-muted")}>
        {detail}
      </span>
      <span className="text-right font-mono text-[11.5px] text-faint">
        {kind === "waiting" ? "—" : formatSeconds(step.durationMs)}
      </span>
    </motion.li>
  );
}
