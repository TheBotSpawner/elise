"use client";

import { Pause, Play } from "lucide-react";
import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import Markdown from "react-markdown";

import { sourceState, type BriefFollowUp, type BriefTask } from "@/core/briefs/morning-brief";
import {
  spokenScript,
  type ExperienceBlock,
  type ExperienceSegment,
  type ScheduledExperience,
} from "@/core/schedules/experience";
import { useInsightText } from "@/features/chat/finance-cards";
import { useMoney } from "@/features/finance/format";
import { WeatherView } from "@/features/workspace/canvas/weather";
import { Visualization } from "@/features/workspace/viz/visualization";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useNarration } from "./use-narration";

/**
 * A scheduled run as a short ELISE session (ADR-039): each segment is what she says plus the
 * cards it's about, in order. "Escuchar" plays the script in ELISE's voice and follows along —
 * the segment being said is highlighted and kept in view, and the user can scroll freely.
 * The same view renders every scheduled experience; a text-only run is one text card.
 */
export function ExperienceView({
  experience,
  title,
  eyebrow,
  narrate = true,
}: {
  experience: ScheduledExperience;
  title: string;
  eyebrow: string;
  /** False inside a chat reply: the conversation already speaks; show only the cards. */
  narrate?: boolean;
}) {
  const { t, locale } = useI18n();
  const lines = useMemo(() => spokenScript(experience), [experience]);
  const { active, playing, play, stop } = useNarration(lines, locale);
  const reduced = useReducedMotion();
  const refs = useRef(new Map<string, HTMLElement>());
  // Following stops once the user scrolls on their own; a new Play follows again.
  const follow = useRef(true);

  useEffect(() => {
    if (!active || !follow.current) return;
    refs.current
      .get(active)
      ?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }, [active, reduced]);

  useEffect(() => {
    if (!playing) return;
    const off = () => (follow.current = false);
    window.addEventListener("wheel", off, { passive: true });
    window.addEventListener("touchmove", off, { passive: true });
    return () => {
      window.removeEventListener("wheel", off);
      window.removeEventListener("touchmove", off);
    };
  }, [playing]);

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="type-label text-faint">{eyebrow}</p>
          <h1 className="text-[26px] leading-[1.15] font-light tracking-[-0.025em]">{title}</h1>
        </div>
        {narrate && lines.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (playing) return stop();
              follow.current = true;
              play();
            }}
            aria-pressed={playing}
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-[14px] font-medium text-white shadow-sm transition-opacity hover:opacity-90"
          >
            {playing ? (
              <Pause className="size-4" aria-hidden />
            ) : (
              <Play className="size-4" aria-hidden />
            )}
            {playing ? t.brief.stop : t.brief.listen}
          </button>
        )}
      </header>

      <ol className="flex flex-col gap-7">
        {experience.segments.map((s) => (
          <Segment
            key={s.id}
            segment={s}
            narrate={narrate}
            speaking={active === s.id}
            dim={playing && active !== s.id}
            timezone={experience.timezone}
            onPlay={
              narrate && s.say
                ? () => {
                    follow.current = true;
                    play(lines.findIndex((l) => l.segment === s.id));
                  }
                : undefined
            }
            ref={(el) => {
              if (el) refs.current.set(s.id, el);
              else refs.current.delete(s.id);
            }}
          />
        ))}
      </ol>

      {narrate && (lines.length > 0 || experience.transcript) && (
        <details className="border-t border-border pt-4 text-[13.5px] text-muted">
          <summary className="cursor-pointer type-label text-faint">{t.brief.transcript}</summary>
          <div className="mt-3 flex flex-col gap-2 leading-[1.6]">
            {experience.transcript ? (
              <div className="prose-elise text-[14px]">
                <Markdown>{experience.transcript}</Markdown>
              </div>
            ) : (
              lines.map((l) => <p key={l.segment}>{l.text}</p>)
            )}
          </div>
        </details>
      )}
    </article>
  );
}

function Segment({
  segment,
  narrate,
  speaking,
  dim,
  timezone,
  onPlay,
  ref,
}: {
  segment: ExperienceSegment;
  narrate: boolean;
  speaking: boolean;
  dim: boolean;
  timezone: string;
  onPlay?: () => void;
  ref: (el: HTMLElement | null) => void;
}) {
  const { t } = useI18n();
  return (
    <li
      ref={ref}
      aria-current={speaking ? "step" : undefined}
      className={cn("flex flex-col gap-3 transition-opacity duration-300", dim && "opacity-55")}
    >
      {narrate && segment.say && (
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={cn(
              "mt-2 size-2.5 shrink-0 rounded-full bg-[var(--accent)]",
              speaking && "animate-pulse ring-4 ring-[var(--accent)]/20",
            )}
          />
          <p
            className={cn(
              "text-[17px] leading-[1.5] font-light",
              speaking ? "text-fg" : "text-fg2",
            )}
          >
            {segment.say}
          </p>
          {onPlay && (
            <button
              type="button"
              onClick={onPlay}
              aria-label={`${t.brief.listen}: ${segment.label ?? segment.say.slice(0, 40)}`}
              className="mt-1 ml-auto shrink-0 rounded-full p-1.5 text-faint hover:bg-[var(--track)] hover:text-fg"
            >
              <Play className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
      {segment.blocks.length > 0 && (
        <div className={cn("flex flex-col gap-3", narrate && segment.say && "sm:pl-5.5")}>
          {segment.blocks.map((b, i) => (
            <Card key={i} label={i === 0 ? segment.label : null} quiet={b.kind === "issues"}>
              <Block block={b} timezone={timezone} />
            </Card>
          ))}
        </div>
      )}
    </li>
  );
}

function Card({
  label,
  quiet,
  children,
}: {
  label: string | null;
  quiet?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2.5 rounded-2xl px-4 py-3.5",
        quiet ? "border border-dashed border-border" : "border border-border bg-surface",
      )}
    >
      {label && <h2 className="type-label text-faint">{label}</h2>}
      {children}
    </section>
  );
}

/** One block → ELISE's own component for it. Unknown kinds (a newer run) render nothing. */
export function Block({ block, timezone }: { block: ExperienceBlock; timezone: string }) {
  switch (block.kind) {
    case "text":
      return (
        <div className="prose-elise text-[15px] leading-[1.6]">
          <Markdown>{block.markdown}</Markdown>
        </div>
      );
    case "chart":
      return <Visualization spec={block.spec} size="small" />;
    case "weather":
      return <WeatherView p={block.weather} compact />;
    case "agenda":
      return <AgendaBlock block={block} timezone={timezone} />;
    case "tasks":
      return <TasksBlock due={block.due} overdue={block.overdue} />;
    case "emails":
      return <EmailsBlock block={block} />;
    case "followups":
      return <FollowUpsBlock block={block} />;
    case "habits":
      return <HabitsBlock block={block} />;
    case "goals":
      return <GoalsBlock block={block} />;
    case "finance":
      return <FinanceBlock finance={block.finance} />;
    case "news":
      return <NewsBlock block={block} />;
    case "knowledge":
      return <KnowledgeBlock block={block} />;
    case "focus":
      return <FocusBlock block={block} timezone={timezone} />;
    case "issues":
      return <IssuesBlock block={block} />;
    default:
      return null;
  }
}

type Of<K extends ExperienceBlock["kind"]> = Extract<ExperienceBlock, { kind: K }>;

function useTime(timezone: string) {
  const { locale } = useI18n();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: timezone });
  return {
    time: (iso: string) => time.format(new Date(iso)),
    day: (iso: string) => day.format(new Date(iso)),
  };
}

/** A number and what it counts, side by side: the shape of a section before its rows. */
function Metric({ n, label, warn }: { n: number; label: string; warn?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={cn(
          "font-mono text-[22px] leading-none",
          warn ? "text-approval-text" : "text-fg",
        )}
      >
        {n}
      </span>
      <span className="text-[12.5px] text-muted">{label}</span>
    </span>
  );
}

function AgendaBlock({ block, timezone }: { block: Of<"agenda">; timezone: string }) {
  const { t } = useI18n();
  const f = useTime(timezone);
  const week = block.span === "week";
  if (!block.events.length)
    return <p className="text-[14px] text-muted">{t.brief.noEventsIn[block.span]}</p>;
  return (
    <>
      <ul className="flex flex-col gap-1.5 text-[14px]">
        {block.events.map((e) => (
          <li
            key={e.id}
            className={cn(
              "grid items-baseline gap-3",
              week ? "grid-cols-[44px_96px_minmax(0,1fr)]" : "grid-cols-[96px_minmax(0,1fr)_auto]",
            )}
          >
            {week && <span className="text-[12.5px] text-faint capitalize">{f.day(e.start)}</span>}
            <span className="font-mono text-[12.5px] text-muted">
              {e.allDay ? "—" : `${f.time(e.start)}–${f.time(e.end)}`}
            </span>
            {e.url ? (
              <a
                href={e.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 truncate hover:text-accent-text"
              >
                {e.title}
              </a>
            ) : (
              <span className="min-w-0 truncate">{e.title}</span>
            )}
            {!week && <span className="text-[12.5px] text-faint">{e.source}</span>}
          </li>
        ))}
      </ul>
      {block.conflicts.length > 0 && (
        <p className="text-[13px] text-approval-text">
          {t.brief.conflicts}: {block.conflicts.map((c) => `${c.a} / ${c.b}`).join(" · ")}
        </p>
      )}
      {block.gaps.length > 0 && (
        <p className="flex flex-wrap gap-1.5 text-[12.5px] text-muted">
          <span>{t.brief.freeTime}:</span>
          {block.gaps.map((g) => (
            <span key={g.start} className="rounded-full bg-[var(--track)] px-2 font-mono">
              {f.time(g.start)}–{f.time(g.end)}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function TaskRows({ tasks, overdue }: { tasks: BriefTask[]; overdue?: boolean }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1 text-[14px]">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                overdue
                  ? "bg-approval"
                  : task.priority === "high"
                    ? "bg-[var(--accent)]"
                    : "bg-[var(--track)]",
              )}
            />
            <span className="truncate">{task.title}</span>
          </span>
          <span className="shrink-0 text-[12.5px] text-faint">
            {overdue ? `${t.brief.overdue} · ${task.dueDate}` : task.source}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TasksBlock({ due, overdue }: { due: BriefTask[]; overdue: BriefTask[] }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-wrap gap-5">
        {due.length > 0 && <Metric n={due.length} label={t.brief.dueToday} />}
        {overdue.length > 0 && <Metric n={overdue.length} label={t.brief.overdue} warn />}
      </div>
      {due.length > 0 && <TaskRows tasks={due} />}
      {overdue.length > 0 && <TaskRows tasks={overdue} overdue />}
    </>
  );
}

function EmailsBlock({ block }: { block: Of<"emails"> }) {
  return (
    <ul className="flex flex-col gap-2.5 text-[14px]">
      {block.emails.map((m) => (
        <li key={m.id} className="flex flex-col">
          <a
            href={m.url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-baseline justify-between gap-3 hover:text-accent-text"
          >
            <span className="min-w-0 truncate">
              <span className="font-medium">{m.from}</span> · {m.subject}
            </span>
            <span className="shrink-0 text-[12.5px] text-faint">{m.source}</span>
          </a>
          <span className="truncate text-[13px] text-muted">{m.snippet}</span>
        </li>
      ))}
    </ul>
  );
}

function FollowUpRows({ items }: { items: BriefFollowUp[] }) {
  return (
    <ul className="flex flex-col gap-2 text-[14px]">
      {items.map((f) => (
        <li key={f.threadId} className="flex flex-col">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate">{f.subject}</span>
            <span className="shrink-0 text-[12.5px] text-faint">{f.source}</span>
          </span>
          <span className="truncate text-[13px] text-muted">
            {f.with} · {f.reasons.slice(0, 2).join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FollowUpsBlock({ block }: { block: Of<"followups"> }) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {block.waitingOnYou.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Metric n={block.waitingOnYou.length} label={t.brief.waitingOnYou} warn />
          <FollowUpRows items={block.waitingOnYou} />
        </div>
      )}
      {block.waitingOnOthers.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Metric n={block.waitingOnOthers.length} label={t.brief.waitingOnOthers} />
          <FollowUpRows items={block.waitingOnOthers} />
        </div>
      )}
    </div>
  );
}

function HabitsBlock({ block }: { block: Of<"habits"> }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1.5 text-[14px]">
      {block.habits.map((h) => (
        <li key={h.name} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{h.name}</span>
          <span
            className={cn("shrink-0 text-[12.5px]", h.atRisk ? "text-approval-text" : "text-faint")}
          >
            {h.week}
            {h.atRisk ? ` · ${t.brief.atRisk}` : h.dueToday ? ` · ${t.brief.dueToday}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GoalsBlock({ block }: { block: Of<"goals"> }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1.5 text-[14px]">
      {block.goals.map((g) => (
        <li key={g.title} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{g.title}</span>
          <span className="shrink-0 text-[12.5px] text-faint">
            {g.progress}
            {g.openTasks > 0 && ` · ${t.brief.openTasks(g.openTasks)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NewsBlock({ block }: { block: Of<"news"> }) {
  return (
    <ul className="grid gap-2.5 sm:grid-cols-2">
      {block.news.map((n) => (
        <li
          key={n.sources[0]?.url ?? n.headline}
          className="flex flex-col gap-1 rounded-xl bg-[var(--track)]/50 px-3 py-2.5 text-[14px]"
        >
          <span className="text-[11.5px] text-faint uppercase">{n.topic}</span>
          <span className="leading-snug">{n.headline}</span>
          <span className="flex flex-wrap gap-x-2 text-[12.5px]">
            {n.sources.map((src) => (
              <a
                key={src.url}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-accent-text hover:underline"
              >
                {src.domain}
              </a>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function KnowledgeBlock({ block }: { block: Of<"knowledge"> }) {
  const { t } = useI18n();
  const k = block.knowledge;
  return (
    <>
      <p className="text-[12.5px] text-faint">{k.scope}</p>
      {k.changes.length === 0 ? (
        <p className="text-[14px] text-muted">{t.brief.noKnowledgeChanges}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[14px]">
          {k.changes.map((c) => (
            <li key={`${c.title}:${c.at}`} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate">{c.title}</span>
              <span className="shrink-0 text-[12.5px] text-faint">
                {t.brief.knowledgeChange[c.change]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FocusBlock({ block, timezone }: { block: Of<"focus">; timezone: string }) {
  const { t } = useI18n();
  const f = useTime(timezone);
  return (
    <ul className="flex flex-col gap-2 text-[14px]">
      {block.focus.map((c) => (
        <li key={c.name} className="flex flex-col gap-0.5">
          <span className="font-medium">{c.name}</span>
          <span className="flex flex-wrap gap-x-3 text-[13px] text-muted">
            {c.meetings.map((m) => (
              <span key={m.start + m.title}>
                <span className="font-mono text-[12.5px]">{f.time(m.start)}</span> {m.title}
              </span>
            ))}
            {c.tasks > 0 && <span>{t.brief.focusTasks(c.tasks)}</span>}
            {c.replies > 0 && <span>{t.brief.focusReplies(c.replies)}</span>}
            {c.examDate && (
              <span className="text-accent-text">{t.brief.focusExam(c.examDate)}</span>
            )}
            {c.review.length > 0 && (
              <span>
                {t.brief.focusReview}: {c.review.join(", ")}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FinanceBlock({ finance }: { finance: Of<"finance">["finance"] }) {
  const { t } = useI18n();
  const money = useMoney();
  const insight = useInsightText();
  return (
    <div className="flex flex-col gap-3 text-[14px]">
      {finance.month.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] text-faint">{t.brief.monthSoFar}</span>
          <ul className="flex flex-col gap-1">
            {finance.month.map((c) => (
              <li
                key={c.currency}
                className="flex flex-wrap items-baseline justify-between gap-x-3"
              >
                <span className="font-medium">{c.currency}</span>
                <span className="font-mono text-[13px] text-muted">
                  <span className="text-success">+{money(c.income, c.currency)}</span>
                  {" · "}−{money(c.expense, c.currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {finance.yesterday.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[12.5px] text-faint">{t.brief.yesterdaySpending}</span>
          <ul className="flex flex-col gap-1">
            {finance.yesterday.map((y, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{y.label}</span>
                <span className="shrink-0 font-mono text-[13px] text-muted">
                  {money(y.amount, y.currency)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {finance.insights.length > 0 && (
        <ul className="flex flex-col gap-1 text-[13.5px] text-muted">
          {finance.insights.map((i, n) => (
            <li key={n}>{insight(i)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const RECONNECTABLE = new Set(["auth_expired", "permission_missing", "no_connection"]);

/** One line per source: what happened, in the user's terms — never "not connected" for a setup problem. */
export function warningText(w: Of<"issues">["warnings"][number], t: Dictionary): string {
  if (w.block === "summary") return t.brief.warnings.summary;
  const state = w.state ?? sourceState(w.code);
  if (state === "needs_topics") return t.brief.issues.needs_topics;
  const what = t.brief.sources[w.block] ?? w.block;
  const accounts = w.accounts?.length ? t.brief.issues.accounts(w.accounts.join(", ")) : "";
  return t.brief.issues[state](`${what}${accounts}`);
}

function IssuesBlock({ block }: { block: Of<"issues"> }) {
  const { t } = useI18n();
  return (
    <div
      aria-label={t.brief.issues.title}
      role="region"
      className="flex flex-col gap-1 text-[13px] text-muted"
    >
      <p className="text-faint">{t.brief.issues.title}</p>
      <ul className="flex flex-col gap-0.5">
        {block.warnings.map((w) => (
          <li key={`${w.block}:${w.state ?? w.code}`}>{warningText(w, t)}</li>
        ))}
      </ul>
      {block.warnings.some((w) => RECONNECTABLE.has(w.state ?? sourceState(w.code))) && (
        <Link href="/connections" className="w-fit underline">
          {t.brief.reconnect}
        </Link>
      )}
    </div>
  );
}
