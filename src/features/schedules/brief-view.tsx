"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import Markdown from "react-markdown";

import { Button } from "@/components/ui/button";
import {
  briefIssues,
  sourceState,
  type BriefFollowUp,
  type BriefTask,
  type BriefWarning,
  type MorningBrief,
} from "@/core/briefs/morning-brief";
import { useInsightText } from "@/features/chat/finance-cards";
import { useMoney } from "@/features/finance/format";
import { WeatherView } from "@/features/workspace/canvas/weather";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { markResultReadAction } from "./actions";

const noop = () => () => undefined;

/** Reads the brief aloud with the browser's own speech engine (no audio leaves the device). */
export function ListenButton({ text }: { text: string }) {
  const { t, locale } = useI18n();
  const supported = useSyncExternalStore(
    noop,
    () => "speechSynthesis" in window,
    () => false,
  );
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  if (!supported || !text) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        if (speaking) {
          window.speechSynthesis.cancel();
          setSpeaking(false);
          return;
        }
        const u = new SpeechSynthesisUtterance(text.replace(/[*#_>`-]/g, " "));
        u.lang = locale === "es" ? "es-AR" : "en-US";
        u.onend = () => setSpeaking(false);
        window.speechSynthesis.speak(u);
        setSpeaking(true);
      }}
    >
      {speaking ? t.brief.stop : t.brief.listen}
    </Button>
  );
}

/** One line per source: what happened, in the user's terms — never "not connected" for a setup problem. */
export function warningText(w: BriefWarning, t: Dictionary): string {
  if (w.block === "summary") return t.brief.warnings.summary;
  const state = w.state ?? sourceState(w.code);
  if (state === "needs_topics") return t.brief.issues.needs_topics;
  const what = t.brief.sources[w.block] ?? w.block;
  const accounts = w.accounts?.length ? t.brief.issues.accounts(w.accounts.join(", ")) : "";
  return t.brief.issues[state](`${what}${accounts}`);
}

const RECONNECTABLE = new Set(["auth_expired", "permission_missing", "no_connection"]);

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <h2 className="type-label text-faint">{label}</h2>
      {children}
    </section>
  );
}

function Tasks({ tasks, overdue }: { tasks: BriefTask[]; overdue?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      {tasks.map((task) => (
        <li key={task.id} className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">{task.title}</span>
          <span className="shrink-0 text-[12.5px] text-faint">
            {overdue ? `${t.brief.overdue} · ${task.dueDate}` : task.source}
          </span>
        </li>
      ))}
    </>
  );
}

function FollowUps({ items }: { items: BriefFollowUp[] }) {
  return (
    <>
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
    </>
  );
}

/**
 * The Brief: the written summary first, the verified details underneath. Without a
 * `resultId` it is the Brief ELISE just assembled in a conversation (a Shortcut, "my brief").
 */
export function BriefView({
  resultId,
  brief,
  createdAt,
  unread,
  title,
}: {
  resultId?: string;
  brief: MorningBrief;
  createdAt: string;
  unread: boolean;
  /** The schedule's own name ("Weekly planning"); the Morning Brief when absent. */
  title?: string;
}) {
  const { t, locale } = useI18n();
  useEffect(() => {
    if (unread && resultId) void markResultReadAction(resultId);
  }, [resultId, unread]);

  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: brief.timezone,
  });
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: brief.timezone,
  });
  // Briefs stored before issues were deduplicated get the same one-line-per-source treatment.
  const issues = briefIssues(brief.warnings);
  const empty =
    !brief.today?.events.length &&
    !brief.attention.emails.length &&
    !brief.attention.tasks.length &&
    !brief.waitingOnYou.replies.length &&
    !brief.waitingOnYou.overdue.length &&
    !brief.waitingOnOthers.length;

  return (
    <article className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="type-label text-faint">{day.format(new Date(createdAt))}</p>
          <h1
            className={cn(
              "leading-[1.15] font-light tracking-[-0.025em]",
              resultId ? "text-[30px]" : "text-[20px]",
            )}
          >
            {title ?? t.brief.title}
          </h1>
        </div>
        <ListenButton text={brief.narrative ?? ""} />
      </header>

      {brief.narrative ? (
        <div className="prose-elise text-[15px] leading-[1.6]">
          <Markdown>{brief.narrative}</Markdown>
        </div>
      ) : (
        empty && <p className="text-muted">{t.brief.nothing}</p>
      )}

      {brief.focus && brief.focus.length > 0 && (
        <Section label={t.brief.focus}>
          <ul className="flex flex-col gap-2 text-[14px]">
            {brief.focus.map((f) => (
              <li key={f.name} className="flex flex-col gap-0.5">
                <span className="font-medium">{f.name}</span>
                <span className="flex flex-wrap gap-x-3 text-[13px] text-muted">
                  {f.meetings.map((m) => (
                    <span key={m.start + m.title}>
                      <span className="font-mono text-[12.5px]">
                        {time.format(new Date(m.start))}
                      </span>{" "}
                      {m.title}
                    </span>
                  ))}
                  {f.tasks > 0 && <span>{t.brief.focusTasks(f.tasks)}</span>}
                  {f.replies > 0 && <span>{t.brief.focusReplies(f.replies)}</span>}
                  {f.examDate && (
                    <span className="text-accent-text">{t.brief.focusExam(f.examDate)}</span>
                  )}
                  {f.review.length > 0 && (
                    <span>
                      {t.brief.focusReview}: {f.review.join(", ")}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {brief.today && (
        <Section
          label={
            !brief.period
              ? t.brief.today
              : brief.period.days > 1
                ? t.schedules.form.horizons.week
                : t.schedules.form.horizons.tomorrow
          }
        >
          {brief.today.events.length === 0 ? (
            <p className="text-[14px] text-muted">{t.brief.noEvents}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[14px]">
              {brief.today.events.map((e) => (
                <li
                  key={e.id}
                  className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-baseline gap-3"
                >
                  <span className="font-mono text-[12.5px] text-muted">
                    {e.allDay
                      ? "—"
                      : `${time.format(new Date(e.start))}–${time.format(new Date(e.end))}`}
                  </span>
                  <span className="min-w-0 truncate">{e.title}</span>
                  <span className="text-[12.5px] text-faint">{e.source}</span>
                </li>
              ))}
            </ul>
          )}
          {brief.today.conflicts.length > 0 && (
            <p className="text-[13px] text-approval-text">
              {t.brief.conflicts}: {brief.today.conflicts.map((c) => `${c.a} / ${c.b}`).join(" · ")}
            </p>
          )}
          {brief.today.gaps.length > 0 && (
            <p className="text-[13px] text-muted">
              {t.brief.freeTime}:{" "}
              {brief.today.gaps
                .map((g) => `${time.format(new Date(g.start))}–${time.format(new Date(g.end))}`)
                .join(" · ")}
            </p>
          )}
        </Section>
      )}

      {brief.weather && (
        <Section label={t.brief.weather}>
          <WeatherView p={brief.weather} compact />
        </Section>
      )}

      {(brief.attention.emails.length > 0 || brief.attention.tasks.length > 0) && (
        <Section label={t.brief.attention}>
          <ul className="flex flex-col gap-2 text-[14px]">
            {brief.attention.emails.map((m) => (
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
            <Tasks tasks={brief.attention.tasks} />
          </ul>
        </Section>
      )}

      {(brief.waitingOnYou.replies.length > 0 || brief.waitingOnYou.overdue.length > 0) && (
        <Section label={t.brief.waitingOnYou}>
          <ul className="flex flex-col gap-2 text-[14px]">
            <FollowUps items={brief.waitingOnYou.replies} />
            <Tasks tasks={brief.waitingOnYou.overdue} overdue />
          </ul>
        </Section>
      )}

      {brief.waitingOnOthers.length > 0 && (
        <Section label={t.brief.waitingOnOthers}>
          <ul className="flex flex-col gap-2 text-[14px]">
            <FollowUps items={brief.waitingOnOthers} />
          </ul>
        </Section>
      )}

      {brief.habits && brief.habits.length > 0 && (
        <Section label={t.brief.habits}>
          <ul className="flex flex-col gap-1.5 text-[14px]">
            {brief.habits.map((h) => (
              <li key={h.name} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{h.name}</span>
                <span
                  className={
                    h.atRisk
                      ? "shrink-0 text-[12.5px] text-approval-text"
                      : "shrink-0 text-[12.5px] text-faint"
                  }
                >
                  {h.week}
                  {h.atRisk ? ` · ${t.brief.atRisk}` : h.dueToday ? ` · ${t.brief.dueToday}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {brief.finance && (brief.finance.month.length > 0 || brief.finance.yesterday.length > 0) && (
        <FinanceSection finance={brief.finance} />
      )}

      {brief.news && brief.news.length > 0 && (
        <Section label={t.brief.news}>
          <ul className="flex flex-col gap-2.5 text-[14px]">
            {brief.news.map((n) => (
              <li key={n.sources[0]?.url ?? n.headline} className="flex flex-col gap-0.5">
                <span>{n.headline}</span>
                <span className="flex flex-wrap gap-x-2 text-[12.5px] text-faint">
                  <span>{n.topic}</span>
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
        </Section>
      )}

      {brief.knowledge && (
        <Section label={`${t.brief.knowledge} · ${brief.knowledge.scope}`}>
          {brief.knowledge.changes.length === 0 ? (
            <p className="text-[14px] text-muted">{t.brief.noKnowledgeChanges}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-[14px]">
              {brief.knowledge.changes.map((c) => (
                <li
                  key={`${c.title}:${c.at}`}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="min-w-0 truncate">{c.title}</span>
                  <span className="shrink-0 text-[12.5px] text-faint">
                    {t.brief.knowledgeChange[c.change]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {brief.goals && brief.goals.length > 0 && (
        <Section label={t.brief.goals}>
          <ul className="flex flex-col gap-1.5 text-[14px]">
            {brief.goals.map((g) => (
              <li key={g.title} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{g.title}</span>
                <span className="shrink-0 text-[12.5px] text-faint">
                  {g.progress}
                  {g.openTasks > 0 && ` · ${t.brief.openTasks(g.openTasks)}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {issues.length > 0 && (
        <section
          aria-label={t.brief.issues.title}
          className="flex flex-col gap-1 border-t border-border pt-4 text-[13px] text-muted"
        >
          <h2 className="type-label text-faint">{t.brief.issues.title}</h2>
          <ul className="flex flex-col gap-0.5">
            {issues.map((w) => (
              <li key={`${w.block}:${w.state ?? w.code}`}>{warningText(w, t)}</li>
            ))}
          </ul>
          {issues.some((w) => RECONNECTABLE.has(w.state ?? sourceState(w.code))) && (
            <Link href="/connections" className="w-fit text-[13px] underline">
              {t.brief.reconnect}
            </Link>
          )}
        </section>
      )}
    </article>
  );
}

/** Month so far per currency, yesterday's largest expenses, grounded observations. */
function FinanceSection({ finance }: { finance: NonNullable<MorningBrief["finance"]> }) {
  const { t } = useI18n();
  const money = useMoney();
  const insight = useInsightText();
  return (
    <Section label={t.brief.finance}>
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
    </Section>
  );
}
