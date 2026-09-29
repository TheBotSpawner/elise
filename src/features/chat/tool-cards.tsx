"use client";

import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Loader2,
  ShieldQuestion,
} from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";

import type { ClientToolTrace } from "@/application/chat-protocol";
import type { ToolDisplay } from "@/core/agents/tools";
import { TaskMeta } from "@/features/tasks/task-meta";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ApprovalCard } from "./approval-card";

function toolLabel(t: ReturnType<typeof useI18n>["t"], name: string) {
  return ((t.tools as Record<string, unknown>)[name] as string | undefined) ?? name;
}

/** Execution trace: live while running, collapsed to "Used N tools" when done (docs/product/05 §15). */
export function ToolTrace({ tools, running }: { tools: ClientToolTrace[]; running: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  const expanded = running || open;

  return (
    <div className="text-xs text-muted">
      {!running && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md py-1 hover:text-fg"
        >
          <CircleCheck className="size-3.5 text-accent" aria-hidden />
          {t.tools.usedSources(tools.length)}
          <ChevronDown
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      )}
      {expanded && (
        <ul className="mt-1 space-y-1 border-l border-border pl-3">
          {tools.map((tool) => (
            <li key={tool.callId} className="flex items-center gap-2">
              {!tool.outcome ? (
                <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
              ) : tool.outcome.status === "succeeded" ? (
                <Check className="size-3.5 text-success" aria-hidden />
              ) : tool.outcome.status === "approval_required" ? (
                <ShieldQuestion className="size-3.5 text-warning" aria-hidden />
              ) : (
                <CircleAlert className="size-3.5 text-danger" aria-hidden />
              )}
              <span className="font-mono">{toolLabel(t, tool.name)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Rich results rendered inside the conversation. */
export function ToolResults({
  tools,
  timezone,
  onApprovalResolved,
}: {
  tools: ClientToolTrace[];
  timezone: string;
  onApprovalResolved: (approvalId: string, display?: ToolDisplay, rejected?: boolean) => void;
}) {
  return (
    <>
      {tools.map((tool) => {
        const outcome = tool.outcome;
        if (!outcome) return null;
        if (outcome.status === "approval_required") {
          return (
            <ApprovalCard
              key={tool.callId}
              approvalId={outcome.approvalId}
              summary={outcome.summary}
              reason={outcome.reason}
              onResolved={onApprovalResolved}
            />
          );
        }
        if (outcome.status === "failed")
          return (
            <ToolError
              key={tool.callId}
              code={outcome.error.code}
              reference={outcome.error.referenceId}
            />
          );
        if (outcome.status === "succeeded" && outcome.display) {
          return <DisplayCard key={tool.callId} display={outcome.display} timezone={timezone} />;
        }
        return null;
      })}
    </>
  );
}

export function DisplayCard({ display, timezone }: { display: ToolDisplay; timezone: string }) {
  const { t } = useI18n();
  if (display.kind === "task") {
    const { task, change } = display;
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-sm rounded-xl border border-border bg-surface p-3"
      >
        <div className="mb-1 flex items-center gap-1.5 text-xs text-accent">
          <CircleCheck className="size-3.5" aria-hidden />
          {t.tasks.changes[change]}
        </div>
        <p
          className={cn(
            "text-sm font-medium",
            change === "completed" && "text-muted line-through",
            change === "deleted" && "text-muted line-through",
          )}
        >
          {task.title}
        </p>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <TaskMeta task={task} timezone={timezone} />
          <Link href="/my-elise/tasks" className="shrink-0 text-xs text-muted hover:text-accent">
            {t.tasks.source}
          </Link>
        </div>
      </motion.div>
    );
  }
  if (display.tasks.length === 0) return null;
  return (
    <div className="max-w-md rounded-xl border border-border bg-surface p-2">
      <ul className="divide-y divide-border">
        {display.tasks.slice(0, 8).map((task) => (
          <li key={task.id} className="px-2 py-2">
            <p className={cn("text-sm", task.status === "completed" && "text-muted line-through")}>
              {task.title}
            </p>
            <TaskMeta task={task} timezone={timezone} />
          </li>
        ))}
      </ul>
      {display.tasks.length > 8 && (
        <Link
          href="/my-elise/tasks"
          className="block px-2 pt-2 text-xs text-muted hover:text-accent"
        >
          +{display.tasks.length - 8} · {t.tasks.title}
        </Link>
      )}
    </div>
  );
}

function ToolError({
  code,
  reference,
}: {
  code: keyof ReturnType<typeof useI18n>["t"]["errors"]["codes"];
  reference: string;
}) {
  const { t } = useI18n();
  return (
    <p className="flex items-start gap-2 text-xs text-danger">
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        {t.errors.codes[code]}
        {reference && (
          <span className="ml-1 font-mono text-muted">{`${t.chat.reference}: ${reference}`}</span>
        )}
      </span>
    </p>
  );
}
