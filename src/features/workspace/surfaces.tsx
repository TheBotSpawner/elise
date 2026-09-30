"use client";

import {
  CalendarDays,
  Check,
  FileText,
  History,
  Link2,
  ListChecks,
  Mail,
  Settings2,
  ShieldCheck,
  Sparkles,
  User,
  Video,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";

import type { ToolDisplay } from "@/core/agents/tools";
import type { ActionId, Surface, SurfaceType } from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { isOpen } from "@/core/workspace/registry";
import { ApprovalCard, type ApprovalPhase } from "@/features/chat/approval-card";
import { DisplayCard } from "@/features/chat/result-cards";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * Renderers for the canonical Surface types (ADR-013). Each maps a validated payload to calm,
 * compact UI; existing chat cards are reused where they already exist. Retrieved text is shown
 * as text only — never as markup.
 */

export const SURFACE_ICONS: Record<SurfaceType, LucideIcon> = {
  meeting: Video,
  calendar_event: CalendarDays,
  email_thread: Mail,
  email_list: Mail,
  knowledge_source: FileText,
  knowledge_result: FileText,
  document: FileText,
  recall: History,
  task_list: ListChecks,
  task: ListChecks,
  person: User,
  links: Link2,
  schedule: CalendarDays,
  settings: Settings2,
  approval: ShieldCheck,
  summary: Sparkles,
  result: Sparkles,
};

export interface SurfaceHandlers {
  /** A direct action (e.g. complete a task); runs through the executor on the server. */
  onAction: (surface: Surface, action: ActionId, itemId: string | null) => void;
  /** A conversational action: sent as a normal message. */
  onPrompt: (text: string) => void;
  onExpand: (surface: Surface, itemId: string | null) => void;
  onApprovalResolved: (
    approvalId: string,
    decision: "approved" | "rejected",
    display?: ToolDisplay,
  ) => void;
  onApprovalPhase: (phase: ApprovalPhase) => void;
  /** "surfaceId:itemId" of the action running now. */
  pending: string | null;
  busy: boolean;
}

/** Minute clock (SSR-safe: 0 on the server, where relative times are hidden). */
const subscribeMinute = (cb: () => void) => {
  const id = window.setInterval(cb, 30_000);
  return () => window.clearInterval(id);
};
function useNow(): number {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 30_000) * 30_000,
    () => 0,
  );
}

function useFormat(timezone: string) {
  const { locale } = useI18n();
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
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  return {
    day: (iso: string) => day.format(new Date(iso)),
    time: (iso: string) => time.format(new Date(iso)),
    date: (iso: string) =>
      iso ? date.format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)) : "",
  };
}

const TITLE = "text-[15px] font-medium tracking-[-0.01em] md:text-base";
const TEXT = "text-[13.5px] leading-[1.55]";

function ActionLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("https://");
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] text-fg transition-colors hover:border-accent-line hover:text-accent-text"
    >
      {children}
    </Link>
  );
}

export function ActionButton({
  onClick,
  disabled,
  children,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] text-fg transition-colors hover:border-accent-line hover:text-accent-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** The link and conversational actions a Surface offers (direct/tool actions live in bodies). */
export function SurfaceActions({
  surface,
  handlers,
}: {
  surface: Surface;
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const title = surface.title;
  const items = surface.actions.flatMap((a) => {
    if (a.kind === "link" && a.href)
      return [
        <ActionLink key={a.id} href={a.href}>
          {a.id === "join" && <Video className="size-3.5" aria-hidden />}
          {t.workspace.actions[a.id]}
        </ActionLink>,
      ];
    if (a.kind === "prompt")
      return [
        <ActionButton
          key={a.id}
          disabled={handlers.busy}
          onClick={() =>
            handlers.onPrompt(
              a.id === "draft_reply"
                ? t.workspace.prompts.draftReply(title)
                : t.workspace.prompts.summarize(title),
            )
          }
        >
          {t.workspace.actions[a.id]}
        </ActionButton>,
      ];
    if (a.kind === "tool" && surface.type === "settings")
      return [
        <ActionButton
          key={a.id}
          disabled={handlers.pending !== null}
          onClick={() => handlers.onAction(surface, a.id, null)}
        >
          {t.workspace.actions[a.id]}
        </ActionButton>,
      ];
    return [];
  });
  if (!items.length) return null;
  return <div className="flex flex-wrap gap-2 pt-1">{items}</div>;
}

// ── Bodies ───────────────────────────────────────────────────────────────────

function MeetingBody({
  p,
  timezone,
  large,
}: {
  p: SurfacePayloads["meeting"];
  timezone: string;
  large: boolean;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const now = useNow();
  const start = Date.parse(p.start);
  const end = Date.parse(p.end);
  const minutes = Math.round((end - start) / 60_000);
  const until = now ? Math.round((start - now) / 60_000) : null;
  const relative =
    until === null
      ? null
      : now >= end
        ? t.workspace.meeting.ended
        : until <= 0
          ? t.workspace.meeting.now
          : until < 90
            ? t.workspace.meeting.startsIn(until)
            : until < 24 * 60
              ? t.workspace.meeting.startsInHours(Math.round(until / 60))
              : null;
  const people = p.attendees.filter((a) => !a.self);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <p className={cn(large ? "text-xl font-light tracking-[-0.02em] md:text-2xl" : TITLE)}>
          {p.title}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-[13.5px] text-muted">
          <span className="font-mono text-[12.5px] text-fg">
            {f.day(p.start)} · {f.time(p.start)}–{f.time(p.end)}
          </span>
          <span aria-hidden>·</span>
          <span>{minutes} min</span>
          {relative && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[12px]",
                until !== null && until <= 15 && now < end
                  ? "bg-accent-soft text-accent-text"
                  : "bg-surface-2 text-muted",
              )}
            >
              {relative}
            </span>
          )}
        </p>
        <p className="text-[12.5px] text-faint">
          {p.calendarName} · {p.account}
          {p.location && !p.location.startsWith("https://") ? ` · ${p.location}` : ""}
        </p>
      </div>
      {people.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="type-label text-faint">{t.workspace.meeting.participants(people.length)}</p>
          <ul className="flex flex-wrap gap-1.5">
            {people.slice(0, large ? 10 : 5).map((a) => (
              <li
                key={a.email}
                className="flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-[12.5px]"
                title={a.email}
              >
                <span className="max-w-[160px] truncate">{a.name ?? a.email}</span>
                {a.organizer && (
                  <span className="text-faint">· {t.workspace.meeting.organizer}</span>
                )}
                {a.response && a.response !== "accepted" && (
                  <span className="text-faint">· {t.workspace.meeting.responses[a.response]}</span>
                )}
              </li>
            ))}
            {people.length > (large ? 10 : 5) && (
              <li className="flex h-7 items-center px-1 text-[12.5px] text-faint">
                {t.workspace.tasks.more(people.length - (large ? 10 : 5))}
              </li>
            )}
          </ul>
        </div>
      )}
      {!p.meetingUrl && <p className="text-[12.5px] text-faint">{t.workspace.meeting.noLink}</p>}
    </div>
  );
}

function EmailListBody({
  surface,
  p,
  timezone,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["email_list"];
  timezone: string;
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <ol className="-mx-2 flex flex-col">
      {p.items.map((m, i) => (
        <li key={m.threadId}>
          <button
            type="button"
            onClick={() => handlers.onExpand(surface, m.threadId)}
            className="grid w-full grid-cols-[20px_minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-2"
          >
            <span className="font-mono text-[11.5px] text-faint">{i + 1}</span>
            <span className="min-w-0">
              <span className={cn("block truncate text-[14px]", m.unread && "font-medium")}>
                {m.subject}
              </span>
              <span className="block truncate text-[12.5px] text-muted">
                {m.from?.name ?? m.from?.email}
                {m.needsReply && (
                  <span className="text-approval-text"> · {t.workspace.email.needsReply}</span>
                )}
                {m.snippet && <span className="text-faint"> · {m.snippet}</span>}
              </span>
            </span>
            <span className="font-mono text-[11.5px] text-faint">{f.date(m.date)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function EmailThreadBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["email_thread"];
  timezone: string;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <div className="flex flex-col gap-2">
      <p className={TITLE}>{p.subject}</p>
      <p className="text-[12.5px] text-muted">
        {p.participants.slice(0, 4).join(", ")} · {t.workspace.email.messages(p.messageCount)}
      </p>
      {p.latest && (
        <div className="border-l border-border pl-3">
          <p className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="font-medium">{p.latest.from}</span>
            <span className="font-mono text-[11.5px] text-faint">{f.date(p.latest.date)}</span>
          </p>
          <p className={cn(TEXT, "line-clamp-3 text-muted")}>{p.latest.excerpt}</p>
        </div>
      )}
    </div>
  );
}

function KnowledgeSourceBody({ p }: { p: SurfacePayloads["knowledge_source"] }) {
  const { t } = useI18n();
  const first = p.passages[0];
  return (
    <div className="flex flex-col gap-2">
      <p className={TITLE}>{p.title}</p>
      <p className="text-[12.5px] text-muted">
        {p.spaceName} · {t.workspace.passages(p.passages.length)}
      </p>
      {first && (
        <blockquote className="border-l border-accent-line pl-3">
          {first.section && <p className="type-label text-faint">{first.section}</p>}
          <p className={cn(TEXT, "line-clamp-4 text-muted")}>{first.excerpt}</p>
        </blockquote>
      )}
    </div>
  );
}

function KnowledgeResultBody({
  surface,
  p,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["knowledge_result"];
  handlers: SurfaceHandlers;
}) {
  return (
    <ol className="-mx-2 flex flex-col">
      {p.sources.map((s) => (
        <li key={s.itemId}>
          <button
            type="button"
            onClick={() => handlers.onExpand(surface, s.itemId)}
            className="flex w-full flex-col rounded-xl px-2 py-2 text-left transition-colors hover:bg-surface-2"
          >
            <span className="truncate text-[14px]">{s.title}</span>
            <span className="line-clamp-2 text-[12.5px] text-muted">
              <span className="text-faint">{s.spaceName}</span>
              {s.passages[0]?.section ? ` · ${s.passages[0].section}` : ""} ·{" "}
              {s.passages[0]?.excerpt}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DocumentBody({ p, timezone }: { p: SurfacePayloads["document"]; timezone: string }) {
  const f = useFormat(timezone);
  return (
    <div className="flex flex-col gap-1">
      <p className={TITLE}>{p.title}</p>
      <p className="text-[12.5px] text-muted">
        {p.spaceName} · {p.sourceType} · {f.date(p.updatedAt)}
      </p>
    </div>
  );
}

function RecallBody({
  surface,
  p,
  timezone,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["recall"];
  timezone: string;
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <ol className="flex flex-col gap-3">
      {p.results.map((r) => (
        <li key={r.interactionId} className="flex flex-col gap-1">
          <p className="flex items-baseline gap-2">
            <span className="font-mono text-[12px] text-accent-text">{f.date(r.date)}</span>
            <span className="min-w-0 truncate text-[14px]">{r.title}</span>
          </p>
          {(r.summary ?? r.excerpts[0]?.text) && (
            <p className={cn(TEXT, "line-clamp-3 text-muted")}>
              {r.summary ?? `“${r.excerpts[0]?.text}”`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ActionButton onClick={() => handlers.onExpand(surface, r.interactionId)}>
              {t.workspace.actions.expand}
            </ActionButton>
            {r.url && <ActionLink href={r.url}>{t.workspace.actions.view_interaction}</ActionLink>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TaskRow({
  surface,
  task,
  handlers,
  timezone,
}: {
  surface: Surface;
  task: SurfacePayloads["task_list"]["items"][number];
  handlers: SurfaceHandlers;
  timezone: string;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const open = isOpen(task.status);
  const pending = handlers.pending === `${surface.id}:${task.id}`;
  return (
    <li className="flex items-center gap-3 py-1.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={!open}
        aria-label={`${t.workspace.actions.complete}: ${task.title}`}
        disabled={!open || pending || handlers.pending !== null}
        onClick={() => handlers.onAction(surface, "complete", task.id)}
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border transition-colors",
          open
            ? "border-border-strong hover:border-accent"
            : "border-accent bg-accent text-accent-fg",
          pending && "animate-pulse",
        )}
      >
        {!open && <Check className="size-3" strokeWidth={3} aria-hidden />}
      </button>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[14px]", !open && "text-faint line-through")}>
          {task.title}
        </span>
        <span className="block truncate text-[12px] text-faint">
          {task.listName ?? task.source}
          {task.dueDate ? ` · ${f.date(task.dueDate)}` : ""}
        </span>
      </span>
    </li>
  );
}

function TaskListBody({
  surface,
  p,
  timezone,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["task_list"];
  timezone: string;
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  return (
    <div>
      <ul className="flex flex-col">
        {p.items.map((task) => (
          <TaskRow
            key={task.id}
            surface={surface}
            task={task}
            handlers={handlers}
            timezone={timezone}
          />
        ))}
      </ul>
      {p.total > p.items.length && (
        <p className="pt-1 text-[12.5px] text-faint">
          {t.workspace.tasks.more(p.total - p.items.length)}
        </p>
      )}
    </div>
  );
}

function PersonBody({ p, timezone }: { p: SurfacePayloads["person"]; timezone: string }) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <div className="flex items-center gap-3">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full border border-border text-[13px] text-muted"
        aria-hidden
      >
        {(p.name ?? p.email).charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px]">{p.name ?? p.email}</span>
        <span className="block truncate text-[12.5px] text-muted">
          {p.email}
          {" · "}
          {p.lastEmailAt
            ? t.workspace.person.lastEmail(f.date(p.lastEmailAt))
            : t.workspace.person.noEmail}
          {p.threads ? ` · ${t.workspace.person.threads(p.threads)}` : ""}
        </span>
      </span>
    </div>
  );
}

function LinksBody({ p }: { p: SurfacePayloads["links"] }) {
  return (
    <ul className="flex flex-col gap-1">
      {p.links.map((l) => (
        <li key={l.url}>
          <Link
            href={l.url}
            {...(l.url.startsWith("https://")
              ? { target: "_blank", rel: "noopener noreferrer nofollow" }
              : {})}
            className="flex items-center gap-2 truncate rounded-lg py-1 text-[13.5px] text-accent-text hover:underline"
          >
            {l.kind === "document" ? (
              <FileText className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <Link2 className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="truncate">{l.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SettingsBody({ p }: { p: SurfacePayloads["settings"] }) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1">
      {p.changes.map((c) => (
        <li key={c.setting} className="flex flex-wrap items-center gap-x-2 text-[14px]">
          <span className="text-muted">{t.workspace.settingNames[c.setting]}</span>
          {c.subject && <span className="text-muted">· {c.subject}</span>}
          <span className="font-mono text-[12.5px]">
            {c.from ? `${c.from} → ` : ""}
            <span className="text-accent-text">{c.to}</span>
          </span>
          <span className="flex items-center gap-1 text-[12.5px] text-success">
            <Check className="size-3.5" aria-hidden />
            {t.workspace.applied}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SummaryBody({ p, large }: { p: SurfacePayloads["summary"]; large: boolean }) {
  const { t } = useI18n();
  return (
    <div className={cn("grid gap-4", large && "md:grid-cols-2")}>
      {p.sections.map((s, i) => (
        <section key={`${s.kind}-${i}`} className="flex flex-col gap-1.5">
          <h3
            className={cn(
              "type-label",
              s.kind === "suggestions"
                ? "text-accent-text"
                : s.kind === "facts"
                  ? "text-fg"
                  : "text-faint",
            )}
          >
            {s.heading || t.workspace.summaryKinds[s.kind]}
          </h3>
          <ul className="flex flex-col gap-1">
            {s.items.map((item, j) => (
              <li
                key={j}
                className={cn(TEXT, "flex gap-2", s.kind === "suggestions" && "text-muted italic")}
              >
                <span
                  aria-hidden
                  className="mt-[9px] size-1 shrink-0 rounded-full bg-border-strong"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Surface content by type. */
export function SurfaceBody({
  surface,
  timezone,
  handlers,
  large = false,
}: {
  surface: Surface;
  timezone: string;
  handlers: SurfaceHandlers;
  large?: boolean;
}) {
  const { t: dictionary } = useI18n();
  const p = surface.payload as never;
  switch (surface.type) {
    case "meeting":
    case "calendar_event":
      return <MeetingBody p={p} timezone={timezone} large={large || surface.type === "meeting"} />;
    case "email_list":
      return <EmailListBody surface={surface} p={p} timezone={timezone} handlers={handlers} />;
    case "email_thread":
      return <EmailThreadBody p={p} timezone={timezone} />;
    case "knowledge_source":
      return <KnowledgeSourceBody p={p} />;
    case "knowledge_result":
      return <KnowledgeResultBody surface={surface} p={p} handlers={handlers} />;
    case "document":
      return <DocumentBody p={p} timezone={timezone} />;
    case "recall":
      return <RecallBody surface={surface} p={p} timezone={timezone} handlers={handlers} />;
    case "task_list":
      return <TaskListBody surface={surface} p={p} timezone={timezone} handlers={handlers} />;
    case "task": {
      const tp = surface.payload as SurfacePayloads["task"];
      return (
        <ul>
          <TaskRow surface={surface} task={tp.task} handlers={handlers} timezone={timezone} />
        </ul>
      );
    }
    case "person":
      return <PersonBody p={p} timezone={timezone} />;
    case "links":
      return <LinksBody p={p} />;
    case "settings":
      return <SettingsBody p={p} />;
    case "summary":
      return <SummaryBody p={p} large={large} />;
    case "schedule": {
      const sp = surface.payload as SurfacePayloads["schedule"];
      const proposal = sp.proposal as ToolDisplay | undefined;
      return proposal && proposal.kind === "schedule_proposal" ? (
        <DisplayCard display={proposal} timezone={timezone} />
      ) : (
        <p className={TITLE}>{sp.name}</p>
      );
    }
    case "approval": {
      const ap = surface.payload as SurfacePayloads["approval"];
      const t = dictionary;
      return (
        <div className="flex flex-col gap-3">
          <ApprovalCard
            approvalId={ap.approvalId}
            summary={ap.summary}
            reason={ap.reason}
            tool={ap.tool}
            preview={ap.preview as ToolDisplay | undefined}
            timezone={timezone}
            autoFocus={handlers.busy}
            initialResolution={ap.decision}
            onResolved={handlers.onApprovalResolved}
            onPhase={handlers.onApprovalPhase}
          />
          {ap.background && (
            <p
              aria-live="polite"
              className={cn(
                "flex items-center gap-2 text-[13px]",
                ap.background === "failed"
                  ? "text-danger-text"
                  : ap.background === "done"
                    ? "text-success"
                    : "text-muted",
              )}
            >
              {ap.background === "running" && (
                <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
              )}
              {ap.background === "done" && <Check className="size-3.5" aria-hidden />}
              {t.workspace.background[ap.background]}
            </p>
          )}
          {Boolean(ap.display) && (
            <DisplayCard display={ap.display as ToolDisplay} timezone={timezone} embedded />
          )}
        </div>
      );
    }
    case "result": {
      const rp = surface.payload as SurfacePayloads["result"];
      return <DisplayCard display={rp.display as unknown as ToolDisplay} timezone={timezone} />;
    }
  }
}

/** Types whose card already is the whole UI (approval, schedule proposal, generic results). */
export const SELF_FRAMED: ReadonlySet<SurfaceType> = new Set(["approval", "result", "schedule"]);
