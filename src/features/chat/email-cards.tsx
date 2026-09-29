"use client";

import { motion, type MotionProps } from "motion/react";
import { useState, useTransition } from "react";

import { ExternalIcon } from "@/components/elise/icons";
import type { ToolDisplay } from "@/core/agents/tools";
import type { EmailAddress, EmailMessage } from "@/core/capabilities/email";
import { discardDraftAction, sendDraftAction } from "@/features/email/actions";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Display<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

const CARD =
  "flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]";

const name = (a: EmailAddress | null) => a?.name ?? a?.email ?? "?";

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
    return day.format(d) === today ? time.format(d) : day.format(d);
  };
}

function Header({
  label,
  href,
  linkLabel,
}: {
  label: string;
  href?: string | null;
  linkLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="type-label text-faint">{label}</span>
      {href && linkLabel && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-8 items-center gap-1.5 text-[13px] text-accent-text"
        >
          {linkLabel}
          <ExternalIcon />
        </a>
      )}
    </div>
  );
}

function Row({
  m,
  multiSource,
  when,
}: {
  m: EmailMessage;
  multiSource: boolean;
  when: (iso: string) => string;
}) {
  const { t } = useI18n();
  const noisy = m.bulk || (m.category !== null && m.category !== "primary");
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
      <a
        href={m.url ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 text-[14px] hover:text-accent-text"
      >
        <span className="flex items-baseline gap-2">
          {m.unread && (
            <span
              aria-label={t.email.unread}
              className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-accent"
            />
          )}
          <span className={cn("shrink-0", m.unread ? "font-medium" : "text-muted")}>
            {m.fromMe ? t.email.you : name(m.from)}
          </span>
          <span className={cn("min-w-0 truncate", m.unread && "font-medium")}>{m.subject}</span>
        </span>
        <span className="block truncate text-[13px] text-faint">
          {noisy && <span className="mr-2 text-muted">{t.email.likelyNoise}</span>}
          {m.snippet}
        </span>
      </a>
      <span className="flex shrink-0 flex-col items-end text-[12.5px] text-faint">
        <span className="font-mono">{when(m.date)}</span>
        {multiSource && <span>{m.provenance.source}</span>}
      </span>
    </li>
  );
}

export function EmailListCard({
  display,
  timezone,
  rise,
}: {
  display: Display<"email_list">;
  timezone: string;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  const multiSource = new Set(display.messages.map((m) => m.provenance.connectionId)).size > 1;
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <Header label={`${t.email.label} · ${t.email.results(display.messages.length)}`} />
      {display.messages.length === 0 ? (
        <p className="text-[14px] text-muted">{t.email.noResults}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {display.messages.slice(0, 10).map((m) => (
            <Row key={m.id} m={m} multiSource={multiSource} when={when} />
          ))}
        </ul>
      )}
      {display.unavailable?.length ? (
        <p role="status" className="text-[13px] text-approval-text">
          {t.email.unavailable(display.unavailable.join(", "))}
        </p>
      ) : null}
    </motion.section>
  );
}

export function EmailThreadCard({
  display,
  timezone,
  rise,
}: {
  display: Display<"email_thread">;
  timezone: string;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  const { thread } = display;
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <Header
        label={`${t.email.thread} · ${t.email.messages(thread.messages.length)} · ${thread.provenance.source}`}
        href={thread.url}
        linkLabel={t.email.openInGmail}
      />
      <p className="text-base font-medium tracking-[-0.01em] md:text-lg">{thread.subject}</p>
      <ol className="flex flex-col gap-2 border-l border-border pl-3">
        {thread.messages.slice(-6).map((m) => (
          <li key={m.id} className="text-[13.5px]">
            <p className="flex items-baseline justify-between gap-3">
              <span className={cn(m.fromMe ? "text-accent-text" : "font-medium")}>
                {m.fromMe ? t.email.you : name(m.from)}
              </span>
              <span className="font-mono text-[12px] text-faint">{when(m.date)}</span>
            </p>
            <p className="line-clamp-2 text-muted">{m.snippet}</p>
          </li>
        ))}
      </ol>
    </motion.section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 text-[13.5px]">
      <dt className="text-faint">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

const list = (a: EmailAddress[]) =>
  a.map((x) => (x.name ? `${x.name} <${x.email}>` : x.email)).join(", ");

/** The exact email: From, To, Subject, body and account. Send is pinned to this version. */
export function DraftCard({
  display,
  rise,
  embedded = false,
}: {
  display: Display<"email_draft">;
  rise: MotionProps;
  /** Inside an approval: the approval buttons decide, the card only shows the content. */
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState(display);
  const [error, setError] = useState<string | null>(null);
  const { draft, change } = state;
  const open = !embedded && (change === "created" || change === "updated");
  const done = change === "sent" || change === "discarded";

  function act(fn: () => ReturnType<typeof sendDraftAction>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) setError(t.errors.codes[result.error.code]);
      else if (result.display?.kind === "email_draft") setState(result.display);
    });
  }

  return (
    <motion.section
      {...rise}
      aria-label={t.chat.resultLabel}
      className={cn(
        embedded ? "flex flex-col gap-2 rounded-xl border border-border bg-surface p-3.5" : CARD,
      )}
    >
      <Header
        label={`${t.email.label} · ${t.email.changes[change]} · ${draft.provenance.source}`}
        href={open ? draft.url : null}
        linkLabel={t.email.edit}
      />
      <dl className={cn("flex flex-col gap-1", done && "text-muted")}>
        <Field
          label={t.email.from}
          value={
            draft.from ? `${draft.provenance.source} <${draft.from}>` : draft.provenance.source
          }
        />
        <Field label={t.email.to} value={list(draft.to)} />
        <Field label={t.email.cc} value={list(draft.cc)} />
        <Field label={t.email.bcc} value={list(draft.bcc)} />
      </dl>
      <p
        className={cn(
          "text-base font-medium tracking-[-0.01em]",
          change === "discarded" && "line-through",
        )}
      >
        {draft.subject}
      </p>
      <p
        className={cn(
          "max-h-56 overflow-y-auto rounded-xl bg-surface-2 px-3.5 py-3 text-[14px] leading-[1.55] whitespace-pre-wrap",
          done && "text-muted",
        )}
      >
        {draft.body}
      </p>
      {(state.external.length > 0 || state.addedByReplyAll?.length) && (
        <ul className="flex flex-col gap-0.5 text-[13px] text-approval-text">
          {state.external.length > 0 && (
            <li>
              {t.email.external(state.external.length)}: {state.external.join(", ")}
            </li>
          )}
          {state.addedByReplyAll?.length ? (
            <li>{t.email.replyAllAdds(state.addedByReplyAll.join(", "))}</li>
          ) : null}
        </ul>
      )}
      {open && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            disabled={pending || !state.version}
            onClick={() => act(() => sendDraftAction(draft.id, state.version ?? ""))}
            className="h-10 rounded-full bg-fg px-[18px] text-sm font-medium text-bg disabled:opacity-60"
          >
            {t.email.send}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t.email.discardConfirm)) act(() => discardDraftAction(draft.id));
            }}
            className="h-10 rounded-full px-4 text-sm text-muted hover:text-danger-text disabled:opacity-60"
          >
            {t.email.discard}
          </button>
          <span className="ml-auto text-[12.5px] text-faint">{t.email.notSent}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger-text">
          {error}
        </p>
      )}
    </motion.section>
  );
}

export function FollowUpsCard({
  display,
  timezone,
  rise,
}: {
  display: Display<"email_followups">;
  timezone: string;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  const when = useWhen(timezone);
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <Header
        label={`${display.followUp === "needs_reply" ? t.email.needsReply : t.email.waitingOn} · ${display.items.length}`}
      />
      {display.items.length === 0 ? (
        <p className="text-[14px] text-muted">{t.email.nothingPending}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {display.items.slice(0, 10).map((f) => (
            <li key={f.threadId} className="flex flex-col gap-0.5 py-2">
              <p className="flex items-baseline justify-between gap-3 text-[14px]">
                <span className="min-w-0 truncate font-medium">{f.subject}</span>
                <span className="shrink-0 font-mono text-[12.5px] text-faint">
                  {when(f.lastMessageAt)}
                </span>
              </p>
              <p className="truncate text-[13px] text-muted">
                {f.counterpart} · {f.source}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-faint">
                <span
                  className={cn(
                    "rounded-full border px-2 py-px",
                    f.confidence === "high"
                      ? "border-accent-line text-accent-text"
                      : "border-border",
                  )}
                >
                  {t.email.confidence[f.confidence]}
                </span>
                {f.reasons.join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

export function EmailChangedCard({
  display,
  rise,
}: {
  display: Display<"email_changed">;
  rise: MotionProps;
}) {
  const { t } = useI18n();
  return (
    <motion.section {...rise} aria-label={t.chat.resultLabel} className={CARD}>
      <Header label={t.email.label} />
      <p className="text-[14px]">
        {t.email.changed[display.change](display.count)} ·{" "}
        <span className="text-muted">{display.source}</span>
      </p>
    </motion.section>
  );
}
