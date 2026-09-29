"use client";

import { CalendarDays, Flag } from "lucide-react";

import type { Task } from "@/core/capabilities/tasks";
import { todayIn, addDays } from "@/core/time";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** Due date + priority chips. Relative labels are computed deterministically. */
export function TaskMeta({ task, timezone }: { task: Task; timezone: string }) {
  const { t, locale } = useI18n();
  const today = todayIn(timezone);
  const open = task.status !== "completed" && task.status !== "cancelled";

  let dueLabel: string | null = null;
  let overdue = false;
  if (task.dueDate) {
    if (task.dueDate === today) dueLabel = t.tasks.today;
    else if (task.dueDate === addDays(today, 1)) dueLabel = t.tasks.tomorrow;
    else
      dueLabel = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(`${task.dueDate}T00:00:00Z`));
    overdue = open && task.dueDate < today;
  }

  if (!dueLabel && !task.priority && !task.category) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {dueLabel && (
        <span className={cn("inline-flex items-center gap-1", overdue && "text-danger")}>
          <CalendarDays className="size-3.5" aria-hidden />
          {overdue ? `${t.tasks.overdue} · ${dueLabel}` : dueLabel}
        </span>
      )}
      {task.priority && (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            task.priority === "high" && "text-warning",
          )}
        >
          <Flag className="size-3.5" aria-hidden />
          {t.tasks.priorities[task.priority]}
        </span>
      )}
      {task.category && (
        <span className="rounded-md bg-surface-2 px-1.5 py-0.5">{task.category}</span>
      )}
    </div>
  );
}
