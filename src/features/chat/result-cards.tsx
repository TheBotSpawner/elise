"use client";

import { motion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";

import { ExternalIcon } from "@/components/elise/icons";
import type { ToolDisplay } from "@/core/agents/tools";
import type { CalendarEvent } from "@/core/capabilities/calendar";
import type { Task } from "@/core/capabilities/tasks";
import { addDays, todayIn } from "@/core/time";
import { ScheduleProposalCard } from "@/features/schedules/proposal-card";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  DraftCard,
  EmailChangedCard,
  EmailListCard,
  EmailThreadCard,
  FollowUpsCard,
} from "./email-cards";
import { KnowledgeSourcesCard } from "./knowledge-cards";

const RISE = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const },
};

const CARD =
  "flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

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

function useEventTime(timezone: string) {
  const { t, locale } = useI18n();
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  return {
    when(e: Pick<CalendarEvent, "start" | "end" | "allDay">) {
      if (e.allDay) {
        return `${new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${e.start}T00:00:00Z`))} · ${t.calendar.allDay}`;
      }
      const s = new Date(e.start);
      return `${day.format(s)} · ${time.format(s)} – ${time.format(new Date(e.end))}`;
    },
    time: (iso: string) => time.format(new Date(iso)),
    day: (iso: string) => day.format(new Date(iso)),
  };
}

function Header({
  label,
  href,
  linkLabel,
  external,
}: {
  label: string;
  href?: string | null;
  linkLabel?: string;
  external?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="type-label text-faint">{label}</span>
      {href && linkLabel && (
        <Link
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="flex h-8 items-center gap-1.5 text-[13px] text-accent-text"
        >
          {linkLabel}
          <ExternalIcon />
        </Link>
      )}
    </div>
  );
}

function Source({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-[12.5px] text-faint">{children}</span>;
}

/** Result cards (reference "Result"): mono category label, title 18 / 500, details 14. */
export function DisplayCard({
  display,
  timezone,
  animate = false,
  embedded = false,
}: {
  display: ToolDisplay;
  timezone: string;
  /** Rise in (240 ms) only when the result arrives live, not when history loads. */
  animate?: boolean;
  /** Shown inside an approval: content only, no actions of its own. */
  embedded?: boolean;
}) {
  const rise = animate ? RISE : { initial: false as const };
  const { t } = useI18n();
  const due = useDueLabel(timezone);
  const fmt = useEventTime(timezone);

  switch (display.kind) {
    case "task": {
      const { task, change } = display;
      const d = due(task);
      const struck = change === "completed" || change === "deleted";
      return (
        <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
          <Header
            label={`${t.tasks.label} · ${t.tasks.changes[change]}`}
            href={
              task.provenance.providerKey === "elise_native"
                ? "/my-elise/tasks"
                : (task.provenance.url ?? null)
            }
            linkLabel={
              task.provenance.providerKey === "elise_native"
                ? t.tasks.openInTasks
                : task.provenance.source
            }
            external={task.provenance.providerKey !== "elise_native"}
          />
          <p
            className={cn(
              "text-base font-medium tracking-[-0.01em] md:text-lg",
              struck && "text-muted line-through",
            )}
          >
            {task.title}
          </p>
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
            <span className="text-muted">{task.provenance.listName ?? task.provenance.source}</span>
          </p>
        </motion.section>
      );
    }

    case "task_list": {
      if (display.tasks.length === 0) return null;
      const multiSource = new Set(display.tasks.map((x) => x.provenance.connectionId)).size > 1;
      return (
        <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
          <Header
            label={`${t.tasks.label} · ${display.tasks.length}`}
            href="/my-elise/tasks"
            linkLabel={t.tasks.openInTasks}
          />
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
                  <span className="flex shrink-0 items-baseline gap-3">
                    {d && (
                      <span
                        className={cn("text-[13px]", d.overdue ? "text-danger-text" : "text-muted")}
                      >
                        {d.label}
                      </span>
                    )}
                    {multiSource && <Source>{task.provenance.source}</Source>}
                  </span>
                </li>
              );
            })}
          </ul>
        </motion.section>
      );
    }

    case "task_lists":
      return null;

    case "calendars":
      return null;

    case "event": {
      const { event, change } = display;
      const others = event.attendees.filter((a) => !a.self);
      return (
        <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
          <Header
            label={`${t.calendar.label} · ${t.calendar.changes[change]}`}
            href={change === "deleted" ? null : event.url}
            linkLabel={t.calendar.openInCalendar}
            external
          />
          <p
            className={cn(
              "text-base font-medium tracking-[-0.01em] md:text-lg",
              change === "deleted" && "text-muted line-through",
            )}
          >
            {event.title}
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] md:text-sm">
            <span>{fmt.when(event)}</span>
            {others.length > 0 && (
              <span className="text-muted">
                {t.calendar.with} {others.map((a) => a.name ?? a.email).join(", ")}
              </span>
            )}
            <span className="text-muted">
              {event.calendarName} · {event.provenance.source}
            </span>
          </p>
        </motion.section>
      );
    }

    case "event_list": {
      const multiSource = new Set(display.events.map((e) => e.provenance.connectionId)).size > 1;
      return (
        <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
          <Header label={`${t.calendar.agenda} · ${fmt.day(display.from)}`} />
          {display.events.length === 0 ? (
            <p className="text-[14px] text-muted">{t.calendar.noEvents}</p>
          ) : (
            <ul className="flex flex-col">
              {display.events.slice(0, 12).map((e) => (
                <li
                  key={e.id}
                  className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5 text-[14px]"
                >
                  <span className="font-mono text-[12.5px] text-muted">
                    {e.allDay ? t.calendar.allDay : `${fmt.time(e.start)}–${fmt.time(e.end)}`}
                  </span>
                  <span className="min-w-0 truncate">{e.title}</span>
                  {multiSource ? <Source>{e.provenance.source}</Source> : <span />}
                </li>
              ))}
            </ul>
          )}
        </motion.section>
      );
    }

    case "email_list":
      return <EmailListCard display={display} timezone={timezone} rise={rise} />;
    case "email_thread":
      return <EmailThreadCard display={display} timezone={timezone} rise={rise} />;
    case "email_draft":
      return <DraftCard display={display} rise={rise} embedded={embedded} />;
    case "email_followups":
      return <FollowUpsCard display={display} timezone={timezone} rise={rise} />;
    case "email_changed":
      return <EmailChangedCard display={display} rise={rise} />;
    case "knowledge_evidence":
      return <KnowledgeSourcesCard display={display} rise={rise} />;
    case "schedule_proposal":
      return <ScheduleProposalCard display={display} rise={rise} />;

    case "availability":
      return (
        <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
          <Header label={`${t.calendar.availability} · ${fmt.day(display.from)}`} />
          {display.free.length === 0 ? (
            <p className="text-[14px] text-muted">{t.calendar.noFree}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {display.free.map((s) => (
                <li
                  key={s.start}
                  className="rounded-full border border-accent-line px-3 py-1 font-mono text-[12.5px] text-accent-text"
                >
                  {fmt.time(s.start)}–{fmt.time(s.end)}
                </li>
              ))}
            </ul>
          )}
        </motion.section>
      );
  }
}
