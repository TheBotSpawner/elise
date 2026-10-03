"use client";

import {
  CalendarDays,
  Check,
  FileText,
  History,
  Link2,
  Mic,
  ListChecks,
  Mail,
  Settings2,
  ShieldCheck,
  Sparkles,
  User,
  Video,
  Globe,
  Newspaper,
  ShoppingBag,
  Telescope,
  Compass,
  FolderPlus,
  Handshake,
  Clock,
  GraduationCap,
  Sprout,
  NotebookPen,
  Zap,
  BarChart3,
  Image as ImageIcon,
  Map as MapIcon,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import type { ToolDisplay } from "@/core/agents/tools";
import type { CalendarChange } from "@/core/workspace/calendar";
import { isSafeHref, type ActionId, type Surface, type SurfaceType } from "@/core/workspace/model";
import { isOpen } from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { ApprovalCard, type ApprovalPhase } from "@/features/chat/approval-card";
import { DisplayCard } from "@/features/chat/result-cards";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { CalendarBody } from "./calendar-view";
import type { VisualSize } from "./canvas/composition";
import { MapBody, PlaceBody } from "./canvas/map";
import { MediaBody } from "./canvas/media";
import { Visualization } from "./viz/visualization";

/**
 * Renderers for the canonical Surface types (ADR-013). Each maps a validated payload to calm,
 * compact UI; existing chat cards are reused where they already exist. Retrieved text is shown
 * as text only — never as markup.
 */

export const SURFACE_ICONS: Record<SurfaceType, LucideIcon> = {
  meeting: Video,
  calendar_event: CalendarDays,
  calendar: CalendarDays,
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
  web_results: Globe,
  web_source: Globe,
  web_news: Newspaper,
  web_research: Telescope,
  web_collection: ShoppingBag,
  context_overview: Compass,
  context_proposal: FolderPlus,
  commitments: Handshake,
  timeline: Clock,
  study_question: GraduationCap,
  study_progress: Sprout,
  study_summary: NotebookPen,
  shortcut: Zap,
  visualization: BarChart3,
  media: ImageIcon,
  map: MapIcon,
  place: MapPin,
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
  /** The Calendar Surface's own controls (view, date, filter; ADR-033). */
  onCalendar?: (surface: Surface, change: CalendarChange) => void;
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

function ActionLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  const external = href.startsWith("https://");
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors",
        primary
          ? "h-9 bg-fg px-3.5 font-medium text-bg hover:opacity-90"
          : "border border-border text-fg hover:border-accent-line hover:text-accent-text",
      )}
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
        <ActionLink key={a.id} href={a.href} primary={a.id === "join"}>
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
                : a.id === "save"
                  ? t.workspace.prompts.saveSource(
                      (surface.payload as { url?: string }).url ?? title,
                    )
                  : a.id === "research"
                    ? t.workspace.prompts.research(title)
                    : a.id === "review_weak"
                      ? t.workspace.prompts.reviewWeak(title)
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
          disabled={handlers.pending !== null || handlers.busy}
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
  const initials = (a: (typeof people)[number]) =>
    (a.name ?? a.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  return (
    <div className="flex flex-col gap-3">
      <p
        className={cn(
          large
            ? "text-[20px] leading-[1.2] font-medium tracking-[-0.015em] md:text-[22px]"
            : TITLE,
        )}
      >
        {p.title}
      </p>
      {/* Reference meeting card: the time is the headline; the countdown says how soon. */}
      <p className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <span
          className={cn(
            "leading-none font-light tracking-[-0.025em]",
            large ? "text-[40px] md:text-[48px]" : "text-[26px]",
          )}
        >
          {p.allDay ? f.day(p.start) : f.time(p.start)}
        </span>
        {relative && (
          <span
            className={cn(
              "font-mono text-[12px] tracking-[0.08em] uppercase",
              until !== null && until <= 15 && now < end ? "text-accent-text" : "text-muted",
            )}
          >
            {relative}
          </span>
        )}
      </p>
      <p className="text-[12.5px] text-muted">
        {f.day(p.start)}
        {!p.allDay && ` · ${f.time(p.start)}–${f.time(p.end)} · ${minutes} min`}
        {p.location && !p.location.startsWith("https://") ? ` · ${p.location}` : ""}
      </p>
      {people.length > 0 && (
        <div
          className="flex items-center gap-2.5"
          title={people.map((a) => a.name ?? a.email).join(", ")}
        >
          <span className="flex" aria-hidden>
            {people.slice(0, 5).map((a) => (
              <span
                key={a.email}
                className="-mr-1.5 grid size-7 place-items-center rounded-full border-[1.5px] border-[var(--avatar-ring)] bg-avatar text-[10.5px] font-medium"
              >
                {initials(a)}
              </span>
            ))}
          </span>
          <span className="ml-1.5 min-w-0 truncate text-[13px] text-muted">
            {people
              .slice(0, large ? 4 : 2)
              .map(
                (a) =>
                  `${a.name ?? a.email}${a.organizer ? ` (${t.workspace.meeting.organizer})` : ""}${
                    a.response && a.response !== "accepted"
                      ? ` · ${t.workspace.meeting.responses[a.response]}`
                      : ""
                  }`,
              )
              .join(", ")}
            {people.length > (large ? 4 : 2) &&
              ` ${t.workspace.tasks.more(people.length - (large ? 4 : 2))}`}
          </span>
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
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {r.modality === "voice" && (
              <span className="flex shrink-0 items-center gap-1 text-[12px] text-faint">
                <Mic className="size-3" aria-hidden />
                {t.voice.historyItem} ·
              </span>
            )}
            <span className="font-mono text-[12px] text-accent-text">{f.date(r.date)}</span>
            <span className="min-w-0 basis-full truncate text-[14px] sm:basis-auto">{r.title}</span>
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
        disabled={!open || pending || handlers.pending !== null || handlers.busy}
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

const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

/** `[site](url)` in a summary item becomes a link when the URL is safe; text otherwise. */
function withLinks(item: string) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of item.matchAll(MD_LINK)) {
    parts.push(item.slice(last, m.index));
    parts.push(
      isSafeHref(m[2]!) ? (
        <a
          key={m.index}
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-accent-text underline underline-offset-2"
        >
          {m[1]}
        </a>
      ) : (
        m[1]
      ),
    );
    last = m.index + m[0].length;
  }
  parts.push(item.slice(last));
  return parts;
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
                <span>{withLinks(item)}</span>
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
  size,
}: {
  surface: Surface;
  timezone: string;
  handlers: SurfaceHandlers;
  large?: boolean;
  /** The canvas size, when the body adapts beyond large/compact (charts, media). */
  size?: VisualSize;
}) {
  const { t: dictionary } = useI18n();
  const p = surface.payload as never;
  switch (surface.type) {
    case "meeting":
    case "calendar_event":
      return <MeetingBody p={p} timezone={timezone} large={large || surface.type === "meeting"} />;
    case "calendar":
      return (
        <CalendarBody
          p={surface.payload as SurfacePayloads["calendar"]}
          loading={surface.state === "loading"}
          focus={size === "focus"}
          onChange={handlers.onCalendar ? (c) => handlers.onCalendar!(surface, c) : undefined}
        />
      );
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
    case "web_results":
      return <WebResultsBody p={p} timezone={timezone} large={large} />;
    case "web_source":
      return <WebSourceBody p={p} timezone={timezone} />;
    case "web_news":
      return <WebNewsBody p={p} timezone={timezone} large={large} />;
    case "web_research":
      return <WebResearchBody p={p} timezone={timezone} />;
    case "web_collection":
      return <WebCollectionBody p={p} timezone={timezone} large={large} />;
    case "context_overview":
      return <ContextOverviewBody p={p} timezone={timezone} />;
    case "context_proposal":
      return <ContextProposalBody surface={surface} p={p} handlers={handlers} />;
    case "commitments":
      return <CommitmentsBody surface={surface} p={p} timezone={timezone} handlers={handlers} />;
    case "timeline":
      return <TimelineBody p={p} timezone={timezone} large={large} />;
    case "study_question":
      return <StudyQuestionBody surface={surface} p={p} handlers={handlers} />;
    case "study_progress":
      return <StudyProgressBody p={p} timezone={timezone} />;
    case "study_summary":
      return <StudySummaryBody p={p} />;
    case "shortcut":
      return <ShortcutBody surface={surface} p={p} handlers={handlers} />;
    case "visualization": {
      const vp = surface.payload as SurfacePayloads["visualization"];
      const vs = size ?? (large ? "large" : "medium");
      return <Visualization spec={vp.spec} size={vs === "micro" ? "small" : vs} />;
    }
    case "media":
      return (
        <MediaBody
          p={surface.payload as SurfacePayloads["media"]}
          size={size ?? (large ? "large" : "medium")}
        />
      );
    case "map":
      return (
        <MapBody
          p={surface.payload as SurfacePayloads["map"]}
          size={size ?? (large ? "large" : "medium")}
          onPrompt={handlers.onPrompt}
        />
      );
    case "place":
      return (
        <PlaceBody
          p={surface.payload as SurfacePayloads["place"]}
          size={size ?? (large ? "large" : "medium")}
        />
      );
    case "result": {
      const rp = surface.payload as SurfacePayloads["result"];
      return <DisplayCard display={rp.display as unknown as ToolDisplay} timezone={timezone} />;
    }
  }
}

/** Types whose card already is the whole UI (approval, schedule proposal, generic results). */
export const SELF_FRAMED: ReadonlySet<SurfaceType> = new Set(["approval", "result", "schedule"]);

// ── Web (ADR-015): public evidence, always with its site and date ────────────

/** A source line: title (opens the page), site, date, and whether ELISE read the page. */
function SourceLine({
  title,
  url,
  domain,
  publishedAt,
  inspected,
  timezone,
}: {
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
  inspected?: boolean;
  timezone: string;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <span className="flex min-w-0 flex-col">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="min-w-0 truncate text-[14px] hover:text-accent-text hover:underline"
      >
        {title}
      </a>
      <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-faint">
        <Globe className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{domain}</span>
        {publishedAt && <span className="font-mono">· {f.date(publishedAt)}</span>}
        {inspected !== undefined && (
          <span>· {inspected ? t.workspace.web.read : t.workspace.web.snippet}</span>
        )}
      </span>
    </span>
  );
}

function RetrievedAt({ at, timezone }: { at: string; timezone: string }) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <p className="text-[11.5px] text-faint">
      {t.workspace.web.retrieved(`${f.date(at)} ${f.time(at)}`)}
    </p>
  );
}

function WebResultsBody({
  p,
  timezone,
  large,
}: {
  p: SurfacePayloads["web_results"];
  timezone: string;
  large: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2.5">
        {p.results.slice(0, large ? 8 : 5).map((r) => (
          <li key={r.url} className="flex flex-col gap-1">
            <SourceLine {...r} timezone={timezone} />
            {(r.passages[0] ?? r.snippet) && (
              <p className={cn(TEXT, "line-clamp-2 text-muted")}>{r.passages[0] ?? r.snippet}</p>
            )}
          </li>
        ))}
      </ol>
      <RetrievedAt at={p.retrievedAt} timezone={timezone} />
    </div>
  );
}

/**
 * Concrete items found on the web (ADR-028): each a card with its own link, price and the facts
 * the site states. Items known only from the search index say so. While reading continues, the
 * count updates in place; a limitation (the site blocks automated reading) is stated, never hidden.
 */
function WebCollectionBody({
  p,
  timezone,
  large,
}: {
  p: SurfacePayloads["web_collection"];
  timezone: string;
  large: boolean;
}) {
  const { t, locale } = useI18n();
  const c = t.workspace.web.collection;
  const money = (price: number, currency: string | null) =>
    currency
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(price)
      : price.toLocaleString(locale);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-muted" aria-live="polite">
        {p.searching
          ? c.searching(p.items.length, p.requested)
          : c.found(p.items.length, p.requested)}
      </p>
      {p.items.length > 0 && (
        <ol className={cn("grid gap-2", large && "sm:grid-cols-2")}>
          {p.items.slice(0, large ? 12 : 6).map((it) => (
            <li key={it.url}>
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                className="sf flex min-w-0 gap-3 rounded-xl p-2.5 transition-colors hover:border-accent-line"
              >
                {it.image && (
                  // eslint-disable-next-line @next/next/no-img-element -- remote listing photos; no optimizer for arbitrary hosts.
                  <img
                    src={it.image}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="size-16 shrink-0 rounded-lg bg-inner object-cover"
                  />
                )}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 text-[13.5px] leading-[1.35] font-medium">
                    {it.title}
                  </span>
                  {it.price !== null && (
                    <span className="font-mono text-[13px] text-fg">
                      {money(it.price, it.currency)}
                    </span>
                  )}
                  {it.attributes.length > 0 && (
                    <span className="truncate text-[11.5px] text-muted">
                      {it.attributes
                        .filter((a) => a.label !== "brand")
                        .map((a) => a.value)
                        .join(" · ")}
                    </span>
                  )}
                  <span className="truncate text-[11px] text-faint">
                    {it.domain}
                    {it.fromIndex ? ` · ${c.fromIndex}` : ""}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
      {p.limitations.length > 0 && (
        <ul className="flex flex-col gap-1 text-[12px] text-muted">
          {p.limitations.map((l) => (
            <li key={`${l.domain}:${l.reason}`}>
              <span className="text-fg2">{l.domain}</span> · {c.limits[l.reason]}
            </li>
          ))}
        </ul>
      )}
      <RetrievedAt at={p.retrievedAt} timezone={timezone} />
    </div>
  );
}

function WebSourceBody({ p, timezone }: { p: SurfacePayloads["web_source"]; timezone: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <SourceLine
        title={p.title}
        url={p.url}
        domain={p.siteName ?? p.domain}
        publishedAt={p.publishedAt}
        timezone={timezone}
      />
      {p.passages.map((passage, i) => (
        <blockquote key={i} className={cn(TEXT, "border-l border-accent-line pl-3 text-muted")}>
          {passage}
        </blockquote>
      ))}
      {p.truncated && <p className="text-[11.5px] text-faint">{t.workspace.web.truncated}</p>}
      <RetrievedAt at={p.retrievedAt} timezone={timezone} />
    </div>
  );
}

function WebNewsBody({
  p,
  timezone,
  large,
}: {
  p: SurfacePayloads["web_news"];
  timezone: string;
  large: boolean;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {p.events.slice(0, large ? 6 : 4).map((e) => (
          <li key={e.items[0]!.url} className="flex flex-col gap-1">
            <p className="flex items-baseline gap-2">
              {e.items[0]!.publishedAt && (
                <span className="shrink-0 font-mono text-[12px] text-accent-text">
                  {f.date(e.items[0]!.publishedAt)}
                </span>
              )}
              <a
                href={e.items[0]!.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="min-w-0 text-[14px] hover:text-accent-text hover:underline"
              >
                {e.headline}
              </a>
            </p>
            {e.items[0]!.snippet && (
              <p className={cn(TEXT, "line-clamp-2 text-muted")}>{e.items[0]!.snippet}</p>
            )}
            <p className="flex flex-wrap gap-x-2 text-[12px] text-faint">
              {e.items.map((it) => (
                <a
                  key={it.url}
                  href={it.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="hover:underline"
                >
                  {it.domain}
                </a>
              ))}
              {e.items.length > 1 && <span>· {t.workspace.web.outlets(e.items.length)}</span>}
            </p>
          </li>
        ))}
      </ol>
      <RetrievedAt at={p.retrievedAt} timezone={timezone} />
    </div>
  );
}

function WebResearchBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["web_research"];
  timezone: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {p.subquestions.map((s) => (
          <li key={s.question} className="flex flex-col gap-1.5">
            <p className="flex items-center gap-2 text-[14px]">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  s.status === "searching"
                    ? "animate-pulse bg-accent"
                    : s.status === "done"
                      ? "bg-accent/60"
                      : "bg-approval",
                )}
              />
              <span className="min-w-0">{s.question}</span>
              <span className="ml-auto shrink-0 text-[12px] text-faint">
                {t.workspace.web.status[s.status]}
              </span>
            </p>
            {s.sources.length > 0 && (
              <ul className="flex flex-col gap-1.5 pl-3.5">
                {s.sources.map((src) => (
                  <li key={src.url}>
                    <SourceLine {...src} timezone={timezone} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <RetrievedAt at={p.retrievedAt} timezone={timezone} />
    </div>
  );
}

// ── Contexts and Work (ADR-016): provenance stays visible, nothing is invented ──

function Chip({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "accent" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px]",
        tone === "accent" && "border-accent-line bg-accent-soft text-accent-text",
        tone === "warn" && "border-approval-line bg-approval-bg text-approval-text",
        tone === "plain" && "border-border text-muted",
      )}
    >
      {children}
    </span>
  );
}

function ContextOverviewBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["context_overview"];
  timezone: string;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const c = t.workspace.context;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2">
        {p.kind !== "custom" && <Chip tone="accent">{c.kinds[p.kind]}</Chip>}
        {p.baseline && (
          <span className="text-[13px] text-muted">
            {c.since(f.date(p.baseline.since))} · {c.basis[p.baseline.basis]}
          </span>
        )}
      </p>
      {p.description && <p className={cn(TEXT, "text-muted")}>{p.description}</p>}
      {p.sources.length > 0 && (
        <ul aria-label={c.links} className="flex flex-wrap gap-1.5">
          {p.sources.map((s) => (
            <li key={s.source}>
              <Chip tone={s.status === "unavailable" || s.status === "failed" ? "warn" : "plain"}>
                {c.sources[s.source] ?? s.source}
                {s.status === "ok" ? (
                  <span className="font-mono text-fg">{s.count}</span>
                ) : (
                  <span>· {c.sourceStatus[s.status]}</span>
                )}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <p className="type-label text-faint">{c.links}</p>
        {p.links.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {p.links
              .filter((l) => l.confirmed)
              .slice(0, 10)
              .map((l) => (
                <li key={`${l.type}:${l.label}`} className="text-[12.5px] text-muted">
                  <Chip>
                    <span className="text-faint">{c.linkTypes[l.type] ?? l.type}</span>
                    <span className="max-w-[200px] truncate text-fg">{l.label}</span>
                  </Chip>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-[13px] text-faint">{c.noLinks}</p>
        )}
      </div>
    </div>
  );
}

function ContextProposalBody({
  surface,
  p,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["context_proposal"];
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const c = t.workspace.context;
  // Likely links start selected; possible and uncertain ones only if the user ticks them.
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(p.suggestions.filter((x) => x.confidence === "high").map((x) => x.id)),
  );
  const pending = handlers.pending?.startsWith(`${surface.id}:`) ?? false;
  if (p.createdId)
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-[14px] text-success">
          <Check className="size-4" aria-hidden />
          {c.proposal.created}
        </p>
        <ActionLink href={`/my-elise/contexts/${p.createdId}`}>
          {t.workspace.actions.open}
        </ActionLink>
      </div>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2">
        {p.kind !== "custom" && <Chip tone="accent">{c.kinds[p.kind]}</Chip>}
        {p.space && (
          <span className="text-[13px]">
            {p.space.name} › {p.name}
          </span>
        )}
        {p.aliases.length > 0 && (
          <span className="text-[13px] text-muted">{p.aliases.join(", ")}</span>
        )}
      </p>
      <p className="text-[13px] text-muted">
        {p.suggestions.length ? c.proposal.intro : c.proposal.none}
      </p>
      {p.suggestions.length > 0 && (
        <ul className="flex flex-col">
          {p.suggestions.map((x) => {
            const on = chosen.has(x.id);
            return (
              <li key={x.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-xl px-1 py-1.5 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (next.has(x.id)) next.delete(x.id);
                        else next.add(x.id);
                        return next;
                      })
                    }
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px]">{x.label}</span>
                    <span className="block truncate text-[12px] text-faint">
                      {c.linkTypes[x.type] ?? x.type}
                      {x.detail &&
                      x.type !== "email_domain" &&
                      x.type !== "person" &&
                      x.type !== "calendar_keyword"
                        ? ` · ${x.detail}`
                        : ""}
                      {x.detail &&
                      (x.type === "email_domain" ||
                        x.type === "person" ||
                        x.type === "calendar_keyword")
                        ? ` · ${c.proposal.seen(x.detail)}`
                        : ""}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[12px]",
                      x.confidence === "high" ? "text-accent-text" : "text-faint",
                    )}
                  >
                    {c.proposal.confidence[x.confidence]}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex justify-end pt-1">
        <button
          type="button"
          disabled={pending || handlers.pending !== null || handlers.busy}
          onClick={() => handlers.onAction(surface, "create_context", [...chosen].join(",") || "")}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-4 text-[13.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending && <span className="size-1.5 animate-pulse rounded-full bg-bg" aria-hidden />}
          {t.workspace.actions.create_context}
        </button>
      </div>
    </div>
  );
}

/** A Shortcut ELISE proposes (Save) or just saved: its phrases and what it will do. */
function ShortcutBody({
  surface,
  p,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["shortcut"];
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const sc = t.shortcuts;
  const pending = handlers.pending?.startsWith(`${surface.id}:`) ?? false;
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap gap-1.5">
        {p.phrases.map((phrase) => (
          <Chip key={phrase} tone="accent">
            “{phrase}”
          </Chip>
        ))}
      </p>
      <ol className="flex flex-col gap-1 text-[13.5px]">
        {p.steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="w-4 shrink-0 text-faint tabular-nums">{i + 1}.</span>
            <span>{sc.steps[step.type as keyof typeof sc.steps] ?? step.type}</span>
          </li>
        ))}
      </ol>
      {(p.contextName || p.requiresConfirmation) && (
        <p className="text-[12.5px] text-muted">
          {[p.contextName && sc.forContext(p.contextName), p.requiresConfirmation && sc.asksFirst]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      {p.state === "saved" ? (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[14px] text-success">
            <Check className="size-4" aria-hidden />
            {sc.saved}
          </p>
          <ActionLink href="/my-elise/shortcuts">{t.workspace.actions.open}</ActionLink>
        </div>
      ) : (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            disabled={pending || handlers.pending !== null || handlers.busy}
            onClick={() => handlers.onAction(surface, "save_shortcut", null)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-fg px-4 text-[13.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending && <span className="size-1.5 animate-pulse rounded-full bg-bg" aria-hidden />}
            {t.workspace.actions.save_shortcut}
          </button>
        </div>
      )}
    </div>
  );
}

function CommitmentsBody({
  surface,
  p,
  timezone,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["commitments"];
  timezone: string;
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const c = t.workspace.context.commitments;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {p.items.map((item) => {
          const pending = handlers.pending === `${surface.id}:${item.id}`;
          return (
            <li key={item.id} className="flex flex-col gap-1">
              <p className="flex items-center gap-2">
                <Chip
                  tone={
                    item.direction === "theirs"
                      ? "accent"
                      : item.direction === "waiting"
                        ? "warn"
                        : "plain"
                  }
                >
                  {c[item.direction]}
                </Chip>
                {item.who && <span className="truncate text-[12.5px] text-muted">{item.who}</span>}
              </p>
              {/* Quoted from the source: untrusted text, shown as text. */}
              <blockquote className={cn(TEXT, "border-l-2 border-border pl-3")}>
                “{item.text}”
              </blockquote>
              <p className="flex flex-wrap items-center justify-between gap-2">
                <span className="truncate text-[12px] text-faint">
                  {item.source.label}
                  {item.source.date ? ` · ${f.date(item.source.date)}` : ""}
                </span>
                <ActionButton
                  disabled={pending || handlers.pending !== null || handlers.busy}
                  onClick={() => handlers.onAction(surface, "create_task", item.id)}
                >
                  {t.workspace.actions.create_task}
                </ActionButton>
              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-[11.5px] text-faint">{c.note}</p>
    </div>
  );
}

function TimelineBody({
  p,
  timezone,
  large,
}: {
  p: SurfacePayloads["timeline"];
  timezone: string;
  large: boolean;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const c = t.workspace.context.timeline;
  return (
    <ol className="flex flex-col">
      {p.entries.slice(0, large ? 12 : 7).map((e) => (
        <li
          key={`${e.kind}:${e.at}:${e.title}`}
          className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 border-l border-border py-1.5 pl-3"
        >
          <span
            className={cn("font-mono text-[12px]", e.upcoming ? "text-accent-text" : "text-faint")}
          >
            {f.date(e.at)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px]">{e.title}</span>
            <span className="block truncate text-[12px] text-faint">
              {e.upcoming ? `${c.upcoming} · ` : ""}
              {c.kinds[e.kind]}
              {e.detail ? ` · ${e.detail}` : ""}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Study (ADR-016): the question, never its answer, until the user answers ──

const ASSESSMENT_TONE = {
  strong: "border-success/40 text-success",
  partial: "border-accent-line text-accent-text",
  needs_review: "border-approval-line bg-approval-bg text-approval-text",
} as const;

function SourceExcerpts({ sources }: { sources: SurfacePayloads["study_question"]["sources"] }) {
  const { t } = useI18n();
  if (!sources.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="type-label text-faint">{t.workspace.study.sources}</p>
      <ul className="flex flex-col gap-2">
        {sources.map((s, i) => (
          <li key={`${s.itemId}:${i}`} className="flex flex-col gap-0.5">
            <Link
              href={`/knowledge/items/${s.itemId}`}
              className="truncate text-[12.5px] text-accent-text hover:underline"
            >
              {s.title}
              {s.section ? ` · ${s.section}` : ""}
              {s.page ? ` · p. ${s.page}` : ""}
            </Link>
            <p className={cn(TEXT, "line-clamp-4 text-muted")}>{s.excerpt}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeedbackLists({
  feedback,
}: {
  feedback: NonNullable<SurfacePayloads["study_question"]["feedback"]>;
}) {
  const { t } = useI18n();
  const s = t.workspace.study;
  const rows = [
    { label: s.correct, items: feedback.correct },
    { label: s.missing, items: feedback.missing },
    { label: s.incorrect, items: feedback.incorrect },
  ].filter((r) => r.items.length);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-0.5">
          <p className="type-label text-faint">{r.label}</p>
          <ul className="flex flex-col gap-0.5">
            {r.items.map((x) => (
              <li key={x} className={cn(TEXT, "flex gap-2")}>
                <span
                  aria-hidden
                  className="mt-[9px] size-1 shrink-0 rounded-full bg-border-strong"
                />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {feedback.explanation && <p className={cn(TEXT, "text-muted")}>{feedback.explanation}</p>}
    </div>
  );
}

function StudyQuestionBody({
  surface,
  p,
  handlers,
}: {
  surface: Surface;
  p: SurfacePayloads["study_question"];
  handlers: SurfaceHandlers;
}) {
  const { t } = useI18n();
  const s = t.workspace.study;
  const busy = handlers.pending !== null || handlers.busy;
  const act = (id: ActionId) => () => handlers.onAction(surface, id, null);
  const has = (id: ActionId) => surface.actions.some((a) => a.id === id);
  return (
    <div className="flex flex-col gap-4">
      {p.previous && (
        <section
          aria-label={s.previous}
          className="flex flex-col gap-2 rounded-2xl border border-border bg-surface-2/60 p-3"
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className="type-label text-faint">{s.previous}</span>
            {p.previous.assessment && (
              <span
                className={cn(
                  "inline-flex h-6 items-center rounded-full border px-2 text-[12px]",
                  ASSESSMENT_TONE[p.previous.assessment],
                )}
              >
                {s.assessment[p.previous.assessment]}
              </span>
            )}
          </p>
          <p className="line-clamp-2 text-[12.5px] text-faint">{p.previous.question}</p>
          <p className={cn(TEXT, "italic")}>“{p.previous.answer}”</p>
          {p.previous.feedback ? (
            <FeedbackLists feedback={p.previous.feedback} />
          ) : (
            <p className="text-[12.5px] text-faint">{s.feedbackAtEnd}</p>
          )}
          {p.previous.sources.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-[12.5px] text-accent-text">
                {s.sources}
              </summary>
              <div className="pt-2">
                <SourceExcerpts sources={p.previous.sources} />
              </div>
            </details>
          )}
        </section>
      )}
      <div className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-faint">
          <span className="font-mono text-accent-text">{s.question(p.number)}</span>
          <span aria-hidden>·</span>
          <span>{s.modes[p.mode]}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{p.scope}</span>
        </p>
        <p className="text-[22px] leading-[1.3] font-light tracking-[-0.02em] text-pretty md:text-[26px]">
          {p.question}
        </p>
        <p className="text-[12.5px] text-faint">
          {s.about} {p.conceptLabel}
        </p>
      </div>
      {p.options && (
        <ol className="flex flex-col gap-1.5">
          {p.options.map((o, i) => (
            <li
              key={o}
              className="flex gap-2 rounded-xl border border-border px-3 py-2 text-[14px]"
            >
              <span className="font-mono text-faint">{String.fromCharCode(97 + i)})</span>
              <span>{o}</span>
            </li>
          ))}
        </ol>
      )}
      {p.hints.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="type-label text-faint">{s.hints}</p>
          <ol className="flex flex-col gap-1">
            {p.hints.map((h, i) => (
              <li key={h} className={cn(TEXT, "flex gap-2 text-muted")}>
                <span className="font-mono text-faint">{i + 1}.</span>
                <span>{h}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {p.state === "answered" && p.feedback && <FeedbackLists feedback={p.feedback} />}
      {p.sources.length ? (
        <SourceExcerpts sources={p.sources} />
      ) : (
        p.state === "asking" && <p className="text-[12px] text-faint">{s.sourcesHidden}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {has("hint") && (
          <ActionButton disabled={busy} onClick={act("hint")}>
            {t.workspace.actions.hint}
          </ActionButton>
        )}
        {has("reveal") && (
          <ActionButton disabled={busy} onClick={act("reveal")}>
            {t.workspace.actions.reveal}
          </ActionButton>
        )}
        {has("next") && (
          <ActionButton disabled={busy} onClick={act("next")}>
            {t.workspace.actions.next}
          </ActionButton>
        )}
        {has("end_session") && (
          <ActionButton disabled={busy} onClick={act("end_session")}>
            {t.workspace.actions.end_session}
          </ActionButton>
        )}
      </div>
    </div>
  );
}

function StudyProgressBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["study_progress"];
  timezone: string;
}) {
  const { t } = useI18n();
  const f = useFormat(timezone);
  const s = t.workspace.study;
  const order = ["needs_review", "learning", "understood", "not_reviewed"] as const;
  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-2">
        {order.map((k) => (
          <li key={k} className="flex flex-col rounded-xl border border-border px-3 py-2">
            <span className="font-mono text-[15px]">{p.counts[k]}</span>
            <span className="text-[12px] text-faint">{s.status[k]}</span>
          </li>
        ))}
      </ul>
      {p.targetDate && <Chip tone="accent">{s.exam(f.date(p.targetDate))}</Chip>}
      {p.weak.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="type-label text-faint">{s.weak}</p>
          <p className={TEXT}>{p.weak.join(" · ")}</p>
        </div>
      )}
      {p.strong.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="type-label text-faint">{s.strong}</p>
          <p className={cn(TEXT, "text-muted")}>{p.strong.join(" · ")}</p>
        </div>
      )}
      {p.sessionQuestions > 0 && (
        <p className="text-[12px] text-faint">{s.thisSession(p.sessionQuestions)}</p>
      )}
    </div>
  );
}

function StudySummaryBody({ p }: { p: SurfacePayloads["study_summary"] }) {
  const { t } = useI18n();
  const s = t.workspace.study.summary;
  const sections = [
    { label: s.strong, items: p.strong, tone: "text-success" },
    { label: s.review, items: p.review, tone: "text-approval-text" },
    { label: s.mistakes, items: p.mistakes, tone: "text-fg" },
    { label: s.next, items: p.nextReview, tone: "text-accent-text" },
  ].filter((x) => x.items.length);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted">
        {s.questions(p.questions)}
        {p.covered.length ? ` · ${s.covered}: ${p.covered.join(", ")}` : ""}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {sections.map((x) => (
          <section key={x.label} className="flex flex-col gap-1.5">
            <h3 className={cn("type-label", x.tone)}>{x.label}</h3>
            <ul className="flex flex-col gap-1">
              {x.items.map((item) => (
                <li key={item} className={cn(TEXT, "flex gap-2")}>
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
    </div>
  );
}
