"use client";

import { motion, type MotionProps } from "motion/react";
import Link from "next/link";

import type { ToolDisplay } from "@/core/agents/tools";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type D<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

const CARD =
  "flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

function Header({ label, href }: { label: string; href: string }) {
  return (
    <Link href={href} className="type-label text-faint hover:text-accent-text">
      {label}
    </Link>
  );
}

/** Habits with this week's Mon–Sun dots and done / target — numbers from ELISE, not the model. */
export function HabitsCard({ display, rise }: { display: D<"habits">; rise: MotionProps }) {
  const { t } = useI18n();
  if (!display.progress.length) return null;
  return (
    <motion.section {...rise} aria-label={t.native.habits.title} className={CARD}>
      <Header label={t.native.habits.title} href="/my-elise/habits" />
      <ul className="flex flex-col gap-2">
        {display.progress.slice(0, 8).map((p) => (
          <li
            key={p.habitId}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 text-[14px]"
          >
            <span className="truncate">{p.name}</span>
            <span className="flex gap-1" aria-hidden>
              {p.week.days.map((d) => (
                <span
                  key={d.date}
                  className={cn(
                    "size-2 rounded-full",
                    d.met
                      ? "bg-accent"
                      : d.value > 0
                        ? "bg-accent-line"
                        : d.scheduled
                          ? "bg-border-strong"
                          : "bg-border",
                  )}
                />
              ))}
            </span>
            <span
              className={cn(
                "font-mono text-[12.5px]",
                p.week.atRisk ? "text-approval-text" : "text-muted",
              )}
            >
              {p.week.done}/{p.week.goal}
            </span>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

export function GoalsCard({ display, rise }: { display: D<"goals">; rise: MotionProps }) {
  const { t } = useI18n();
  if (!display.goals.length) return null;
  return (
    <motion.section {...rise} aria-label={t.native.goals.title} className={CARD}>
      <Header label={t.native.goals.title} href="/my-elise/goals" />
      <ul className="flex flex-col gap-2.5">
        {display.goals.slice(0, 6).map(({ goal, progress, openTasks }) => (
          <li key={goal.id} className="flex flex-col gap-1">
            <p className="flex items-baseline justify-between gap-3 text-[14px]">
              <span className="truncate">{goal.title}</span>
              <span className="shrink-0 font-mono text-[12.5px] text-muted">
                {progress.percent === null
                  ? t.native.goals.status[goal.status]
                  : `${progress.percent}%`}
              </span>
            </p>
            {progress.percent !== null && (
              <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${progress.percent}%` }}
                />
              </span>
            )}
            {(goal.links.length > 0 || openTasks > 0) && (
              <span className="truncate text-[12.5px] text-faint">
                {goal.links
                  .map((l) => l.title)
                  .filter(Boolean)
                  .join(" · ")}
                {openTasks > 0 && ` · ${t.native.goals.openTasks(openTasks)}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

export function ListCard({ display, rise }: { display: D<"native_list">; rise: MotionProps }) {
  const { t } = useI18n();
  const { list } = display;
  const open = list.items.filter((i) => !i.checked).length;
  return (
    <motion.section {...rise} aria-label={list.name} className={CARD}>
      <Header
        label={`${t.native.lists.title} · ${t.native.lists.remaining(open, list.items.length)}`}
        href={`/my-elise/lists/${list.id}`}
      />
      <p className="text-base font-medium">{list.name}</p>
      <ul className="flex flex-col gap-1 text-[14px]">
        {list.items.slice(0, 12).map((i) => (
          <li
            key={i.id}
            className={cn("flex items-center gap-2", i.checked && "text-muted line-through")}
          >
            <span
              aria-hidden
              className={cn(
                "size-3.5 rounded border",
                i.checked ? "border-accent bg-accent" : "border-border-strong",
              )}
            />
            {i.content}
          </li>
        ))}
      </ul>
    </motion.section>
  );
}

export function NoteCard({
  display,
  rise,
}: {
  display: D<"note"> | D<"notes">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const notes = display.kind === "note" ? [display.note] : display.notes;
  if (!notes.length) return null;
  return (
    <motion.section {...rise} aria-label={t.native.notes.title} className={CARD}>
      <Header label={t.native.notes.title} href="/my-elise/notes" />
      <ul className="flex flex-col gap-2">
        {notes.slice(0, 6).map((n) => (
          <li key={n.id}>
            <Link href={`/my-elise/notes?note=${n.id}`} className="block hover:text-accent-text">
              <span
                className={cn(
                  "block truncate text-[14.5px] font-medium",
                  display.kind === "note" &&
                    display.change === "archived" &&
                    "text-muted line-through",
                )}
              >
                {n.title}
              </span>
              <span className="block truncate text-[12.5px] text-faint">
                {n.spaceName ? t.native.notes.inSpace(n.spaceName) : t.native.notes.noSpace} ·{" "}
                {n.content.slice(0, 120)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </motion.section>
  );
}
