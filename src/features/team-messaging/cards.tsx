"use client";

import { motion, type MotionProps } from "motion/react";

import { SlackIcon } from "@/components/elise/brand-icons";
import { ExternalIcon } from "@/components/elise/icons";
import type { ToolDisplay } from "@/core/agents/tools";
import { channelLabel, type TeamAccess } from "@/core/capabilities/team-messaging";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * Team Messaging (ADR-062): Slack results as calm cards — who, where, when, what, and the way back
 * to Slack. The same rows render in the conversation and on the Canvas. Message text is
 * third-party data, always rendered as plain text.
 */

type Display<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

const CARD =
  "flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

function useWhen(timezone: string) {
  const { locale } = useI18n();
  const day = new Intl.DateTimeFormat(locale, {
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
  const today = day.format(new Date());
  return (iso: string) => {
    const d = new Date(iso);
    return day.format(d) === today ? time.format(d) : `${day.format(d)} ${time.format(d)}`;
  };
}

function Initial({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-[12px] font-medium text-muted"
    >
      {name.replace(/^@/, "").charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function OpenLink({ href }: { href: string | null }) {
  const { t } = useI18n();
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t.teamMessaging.open}
      title={t.teamMessaging.open}
      className="grid size-7 shrink-0 place-items-center rounded-full text-faint hover:text-accent-text"
    >
      <ExternalIcon />
    </a>
  );
}

interface Row {
  key: string;
  author: string;
  channel: string;
  date: string;
  text: string;
  url: string | null;
  replyCount?: number | null;
  workspace?: string;
}

/** One message: avatar initial, author · channel · time, text, permalink. */
function MessageRow({
  m,
  when,
  showWorkspace,
}: {
  m: Row;
  when: (iso: string) => string;
  showWorkspace: boolean;
}) {
  const { t } = useI18n();
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 py-2">
      <Initial name={m.author} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
          <span className="font-medium">{m.author}</span>
          <span className="text-muted">{m.channel}</span>
          <span className="font-mono text-[11.5px] text-faint">{when(m.date)}</span>
          {showWorkspace && m.workspace && <span className="text-faint">· {m.workspace}</span>}
        </p>
        <p className="line-clamp-3 text-[13.5px] leading-[1.5] whitespace-pre-line text-fg2">
          {m.text}
        </p>
        {m.replyCount ? (
          <p className="text-[12px] text-accent-text">{t.teamMessaging.replies(m.replyCount)}</p>
        ) : null}
      </div>
      <OpenLink href={m.url} />
    </li>
  );
}

function NotSearched({ access }: { access: readonly TeamAccess[] }) {
  const { t } = useI18n();
  if (!access.length) return null;
  return (
    <p className="text-[12.5px] text-faint">
      {t.teamMessaging.notSearched(access.map((a) => t.teamMessaging.access[a]).join(", "))}
    </p>
  );
}

function Header({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <SlackIcon size={14} />
      <span className="type-label text-faint">{label}</span>
    </div>
  );
}

// ── Conversation cards ───────────────────────────────────────────────────────

export function TeamMessagesCard({
  display,
  timezone,
  rise,
}: {
  display: Display<"team_messages">;
  timezone: string;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  const multi = new Set(display.messages.map((m) => m.provenance.connectionId)).size > 1;
  // A stored turn keeps provenance only (ADR-062): show where it was, never an empty bubble.
  const rows: Row[] = display.messages.map((m) => ({
    key: m.id,
    author: m.author.name,
    channel: channelLabel(m.channel),
    date: m.date,
    text: m.text,
    url: m.url,
    replyCount: m.replyCount,
    workspace: m.provenance.source,
  }));
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <Header
        label={
          display.unread
            ? `${t.teamMessaging.label} · ${t.teamMessaging.unreadLabel}`
            : `${display.channel && !display.query ? t.teamMessaging.recentIn(display.channel) : t.teamMessaging.label} · ${t.teamMessaging.results(rows.length)}`
        }
      />
      {rows.length === 0 && display.files.length === 0 ? (
        <p className="text-[14px] text-muted">
          {display.unread ? t.teamMessaging.noUnread : t.teamMessaging.noResults}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.slice(0, 10).map((m) => (
            <MessageRow key={m.key} m={m} when={when} showWorkspace={multi} />
          ))}
        </ul>
      )}
      {display.files.length > 0 && <FileList files={display.files} when={when} />}
      <NotSearched access={display.notSearched} />
      {display.unavailable?.length ? (
        <p role="status" className="text-[13px] text-approval-text">
          {t.teamMessaging.unavailable(display.unavailable.join(", "))}
        </p>
      ) : null}
    </motion.section>
  );
}

function FileList({
  files,
  when,
}: {
  files: {
    title: string;
    fileType: string | null;
    url: string | null;
    date: string | null;
    author: string | null;
  }[];
  when: (iso: string) => string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="type-label text-faint">{t.teamMessaging.files}</span>
      <ul className="flex flex-col gap-1">
        {files.slice(0, 6).map((f, i) => (
          <li
            key={`${f.title}-${i}`}
            className="flex items-center justify-between gap-2 text-[13.5px]"
          >
            <span className="min-w-0 truncate">
              {f.title}
              <span className="text-faint">
                {f.fileType ? ` · ${f.fileType}` : ""}
                {f.author ? ` · ${f.author}` : ""}
                {f.date ? ` · ${when(f.date)}` : ""}
              </span>
            </span>
            <OpenLink href={f.url} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TeamThreadCard({
  display,
  timezone,
  rise,
}: {
  display: Display<"team_thread">;
  timezone: string;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  const { thread } = display;
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <div className="flex items-center justify-between gap-2">
        <Header
          label={`${t.teamMessaging.thread} · ${channelLabel(thread.channel)} · ${thread.provenance.source} · ${t.teamMessaging.messages(thread.messages.length)}`}
        />
        <OpenLink href={thread.url} />
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {thread.messages.slice(-8).map((m) => (
          <MessageRow
            key={m.id}
            m={{
              key: m.id,
              author: m.author.name,
              channel: "",
              date: m.date,
              text: m.text,
              url: m.url,
            }}
            when={when}
            showWorkspace={false}
          />
        ))}
      </ul>
      {thread.hasMore && <p className="text-[12.5px] text-faint">{t.teamMessaging.more}</p>}
    </motion.section>
  );
}

/** The exact message and destination: what the approval covers, or what was sent. */
export function TeamDraftCard({
  display,
  rise,
  embedded = false,
}: {
  display: Display<"team_draft">;
  rise: MotionProps;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const { draft, change, sent } = display;
  return (
    <motion.section
      {...rise}
      aria-label={t.chat.resultLabel}
      className={cn(
        embedded ? "flex flex-col gap-2 rounded-xl border border-border bg-surface p-3.5" : CARD,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Header
          label={`${t.teamMessaging.label} · ${t.teamMessaging.changes[change]} · ${draft.source}`}
        />
        {sent && <OpenLink href={sent.url} />}
      </div>
      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[13.5px]">
        <dt className="text-faint">
          {draft.threadId ? t.teamMessaging.inThread : t.teamMessaging.to}
        </dt>
        <dd className="min-w-0 font-medium break-words">
          {draft.toLabel} <span className="font-normal text-faint">· {draft.workspace}</span>
        </dd>
      </dl>
      <p
        className={cn(
          "max-h-56 overflow-y-auto rounded-xl bg-surface-2 px-3.5 py-3 text-[14px] leading-[1.55] whitespace-pre-wrap",
          change === "sent" && "text-muted",
        )}
      >
        {draft.text}
      </p>
    </motion.section>
  );
}

export function TeamReactionLine({ display }: { display: Display<"team_reaction"> }) {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted">
      <SlackIcon size={13} />
      {(display.on ? t.teamMessaging.reacted : t.teamMessaging.unreacted)(display.emoji)} ·{" "}
      {display.workspace}
    </p>
  );
}

// ── Canvas bodies ────────────────────────────────────────────────────────────

export function TeamMessagesBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["team_messages"];
  timezone: string;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  const multi = new Set(p.items.map((m) => m.workspace)).size > 1;
  return (
    <div className="flex flex-col gap-2">
      {p.items.length === 0 && p.files.length === 0 ? (
        <p className="text-[14px] text-muted">
          {p.unread ? t.teamMessaging.noUnread : t.teamMessaging.noResults}
        </p>
      ) : (
        <ul className="-my-1 flex flex-col divide-y divide-border">
          {p.items.map((m) => (
            <MessageRow
              key={m.messageId}
              m={{ ...m, key: m.messageId }}
              when={when}
              showWorkspace={multi}
            />
          ))}
        </ul>
      )}
      {p.files.length > 0 && <FileList files={p.files} when={when} />}
      <NotSearched access={p.notSearched} />
      {p.unavailable?.length ? (
        <p role="status" className="text-[13px] text-approval-text">
          {t.teamMessaging.unavailable(p.unavailable.join(", "))}
        </p>
      ) : null}
    </div>
  );
}

export function TeamThreadBody({
  p,
  timezone,
}: {
  p: SurfacePayloads["team_thread"];
  timezone: string;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12.5px] text-muted">
        {p.channel} · {p.workspace} · {t.teamMessaging.messages(p.total)}
      </p>
      <ol className="flex flex-col divide-y divide-border">
        {p.messages.map((m) => (
          <MessageRow
            key={m.messageId}
            m={{ ...m, key: m.messageId, channel: "" }}
            when={when}
            showWorkspace={false}
          />
        ))}
      </ol>
      {p.hasMore && <p className="text-[12.5px] text-faint">{t.teamMessaging.more}</p>}
    </div>
  );
}
