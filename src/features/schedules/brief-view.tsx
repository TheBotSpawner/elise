"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import Markdown from "react-markdown";

import { Button } from "@/components/ui/button";
import type {
  BriefFollowUp,
  BriefTask,
  BriefWarning,
  MorningBrief,
} from "@/core/briefs/morning-brief";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

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

function warningText(w: BriefWarning, t: Dictionary): string {
  if (w.block === "summary") return t.brief.warnings.summary;
  const what = w.account ?? t.brief.sources[w.block] ?? w.block;
  if (w.code === "AUTH_EXPIRED" || w.code === "PERMISSION_DENIED")
    return t.brief.warnings.needsAttention(what);
  if (w.code === "CAPABILITY_UNAVAILABLE" || w.code === "NOT_FOUND")
    return t.brief.warnings.notConnected(what);
  return t.brief.warnings.failed(what);
}

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

/** The Brief: the written summary first, the verified details underneath. */
export function BriefView({
  resultId,
  brief,
  createdAt,
  unread,
}: {
  resultId: string;
  brief: MorningBrief;
  createdAt: string;
  unread: boolean;
}) {
  const { t, locale } = useI18n();
  useEffect(() => {
    if (unread) void markResultReadAction(resultId);
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
          <h1 className="text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            {t.brief.title}
          </h1>
        </div>
        <ListenButton text={brief.narrative ?? ""} />
      </header>

      {brief.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-2xl border border-approval-line bg-approval-bg px-4 py-3 text-[13.5px] text-approval-text">
          {brief.warnings.map((w, i) => (
            <li key={i}>{warningText(w, t)}</li>
          ))}
          {brief.warnings.some(
            (w) => w.code === "AUTH_EXPIRED" || w.code === "PERMISSION_DENIED",
          ) && (
            <li>
              <Link href="/connections" className="underline">
                {t.brief.reconnect}
              </Link>
            </li>
          )}
        </ul>
      )}

      {brief.narrative ? (
        <div className="prose-elise text-[15px] leading-[1.6]">
          <Markdown>{brief.narrative}</Markdown>
        </div>
      ) : (
        empty && <p className="text-muted">{t.brief.nothing}</p>
      )}

      {brief.today && (
        <Section label={t.brief.today}>
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
    </article>
  );
}
