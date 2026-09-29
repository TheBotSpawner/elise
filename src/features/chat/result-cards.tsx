"use client";

import { motion } from "motion/react";
import Link from "next/link";

import { ExternalIcon } from "@/components/elise/icons";
import type { ToolDisplay } from "@/core/agents/tools";
import type { Task } from "@/core/capabilities/tasks";
import { addDays, todayIn } from "@/core/time";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const RISE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
};

function useDueLabel(timezone: string) {
  const { t, locale } = useI18n();
  const today = todayIn(timezone);
  return (task: Task) => {
    if (!task.dueDate) return null;
    const open = task.status === "pending" || task.status === "in_progress";
    const label =
      task.dueDate === today
        ? t.tasks.today
        : task.dueDate === addDays(today, 1)
          ? t.tasks.tomorrow
          : new Intl.DateTimeFormat(locale, {
              weekday: "short",
              day: "numeric",
              month: "short",
              timeZone: "UTC",
            }).format(new Date(`${task.dueDate}T00:00:00Z`));
    return { label, overdue: open && task.dueDate < today };
  };
}

/** Result card (reference "Result"): mono category label, title 18 / 500, details 14. */
export function DisplayCard({
  display,
  timezone,
  animate = false,
}: {
  display: ToolDisplay;
  timezone: string;
  /** Rise in (240 ms) only when the result arrives live, not when history loads. */
  animate?: boolean;
}) {
  const rise = animate ? RISE : { initial: false as const };
  const { t } = useI18n();
  const due = useDueLabel(timezone);

  const header = (label: string) => (
    <div className="flex items-center justify-between gap-3">
      <span className="type-label text-faint">{label}</span>
      <Link
        href="/my-elise/tasks"
        className="flex h-8 items-center gap-1.5 text-[13px] text-accent-text"
      >
        {t.tasks.openInTasks}
        <ExternalIcon />
      </Link>
    </div>
  );

  if (display.kind === "task") {
    const { task, change } = display;
    const d = due(task);
    const struck = change === "completed" || change === "deleted";
    return (
      <motion.section
        {...rise}
        aria-label={t.chat.resultLabel}
        className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]"
      >
        {header(`${t.tasks.label} · ${t.tasks.changes[change]}`)}
        <p
          className={cn(
            "text-base font-medium tracking-[-0.01em] md:text-lg",
            struck && "text-muted line-through",
          )}
        >
          {task.title}
        </p>
        {(d || task.priority || task.category) && (
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] md:text-sm">
            {d && (
              <span className={cn(d.overdue && "text-danger-text")}>
                {d.overdue ? `${t.tasks.overdue} · ${d.label}` : d.label}
              </span>
            )}
            {task.priority && (
              <span className="text-muted">{t.tasks.priorities[task.priority]}</span>
            )}
            {task.category && <span className="text-muted">{task.category}</span>}
          </p>
        )}
      </motion.section>
    );
  }

  if (display.tasks.length === 0) return null;
  return (
    <motion.section
      {...rise}
      aria-label={t.chat.resultLabel}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]"
    >
      {header(`${t.tasks.label} · ${display.tasks.length}`)}
      <ul className="flex flex-col">
        {display.tasks.slice(0, 8).map((task) => {
          const d = due(task);
          return (
            <li
              key={task.id}
              className="flex items-baseline justify-between gap-4 py-1.5 text-[14px]"
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  task.status === "completed" && "text-muted line-through",
                )}
              >
                {task.title}
              </span>
              {d && (
                <span
                  className={cn(
                    "shrink-0 text-[13px]",
                    d.overdue ? "text-danger-text" : "text-muted",
                  )}
                >
                  {d.label}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
