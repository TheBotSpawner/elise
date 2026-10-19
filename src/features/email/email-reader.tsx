"use client";

import { ExternalLink, Paperclip, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Dialog } from "@/components/ui/dialog";
import type { EmailAddress, EmailMessage, EmailThread } from "@/core/capabilities/email";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * ELISE's email reader (ADR-098): the real conversation, fetched when it opens, inside ELISE —
 * never an embedded Gmail or Outlook. Bodies are the provider's plain text rendered as text:
 * no markup, no remote images or tracking pixels, and only https: links become links (opened
 * outside, without a referrer). The provider's own page stays one tap away.
 */

type Load =
  | { status: "loading" }
  | { status: "ready"; thread: EmailThread }
  | { status: "error"; kind: "failed" | "reconnect" | "notFound" };

const loaders = new Map<string, Promise<Load>>();

/** One fetch per thread while it's open in several places; a failure is retried next time. */
function load(threadId: string): Promise<Load> {
  const known = loaders.get(threadId);
  if (known) return known;
  const p = fetch(`/api/email/thread?id=${encodeURIComponent(threadId)}`, { cache: "no-store" })
    .then(async (r): Promise<Load> => {
      if (r.ok)
        return { status: "ready", thread: ((await r.json()) as { thread: EmailThread }).thread };
      return {
        status: "error",
        kind: r.status === 404 ? "notFound" : r.status === 409 ? "reconnect" : "failed",
      };
    })
    .catch((): Load => ({ status: "error", kind: "failed" }));
  loaders.set(threadId, p);
  void p.then((l) => l.status === "error" && loaders.delete(threadId));
  return p;
}

function useThread(threadId: string) {
  const [state, setState] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void load(threadId).then((l) => live && setState(l));
    return () => {
      live = false;
    };
  }, [threadId, attempt]);
  const retry = useCallback(() => {
    loaders.delete(threadId);
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  }, [threadId]);
  return { state, retry };
}

const who = (a: EmailAddress | null) => (a ? a.name || a.email : "—");
const list = (as: EmailAddress[]) => as.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));

/** https: URLs in plain text become links; everything else stays text. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https:\/\/[^\s<>"')\]]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="break-all text-accent-text underline underline-offset-2"
          >
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function MessageView({ m, timezone }: { m: EmailMessage; timezone: string }) {
  const { t, locale } = useI18n();
  const r = t.workspace.email.reader;
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(m.date));
  return (
    <article className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <header className="flex flex-col gap-0.5 text-[12.5px]">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-[14px] font-medium">
            {m.fromMe ? t.email.you : who(m.from)}
            {m.from && !m.fromMe && m.from.name && (
              <span className="ml-1.5 font-normal text-faint">{m.from.email}</span>
            )}
          </span>
          <time dateTime={m.date} className="font-mono text-[11.5px] text-faint">
            {date}
          </time>
        </p>
        {m.to.length > 0 && (
          <p className="text-muted">
            {r.to}: {list(m.to).join(", ")}
          </p>
        )}
        {m.cc.length > 0 && (
          <p className="text-muted">
            {r.cc}: {list(m.cc).join(", ")}
          </p>
        )}
      </header>
      {m.body?.trim() ? (
        <div className="text-[14px] leading-[1.6] break-words whitespace-pre-wrap">
          <Linked text={m.body.trim()} />
        </div>
      ) : (
        <p className="text-[13px] text-faint">{m.snippet || r.noBody}</p>
      )}
      {m.attachments.length > 0 && (
        <ul aria-label={r.attachments(m.attachments.length)} className="flex flex-wrap gap-1.5">
          {m.attachments.map((a, i) => (
            <li
              key={i}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted"
            >
              <Paperclip className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{a.filename}</span>
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {Math.max(1, Math.round(a.size / 1024))} KB
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** The conversation itself: the latest messages open, older ones one tap away. */
export function EmailThreadReader({
  threadId,
  timezone,
  heading = true,
}: {
  threadId: string;
  timezone: string;
  heading?: boolean;
}) {
  const { t } = useI18n();
  const r = t.workspace.email.reader;
  const { state, retry } = useThread(threadId);
  const [all, setAll] = useState(false);
  if (state.status === "loading")
    return (
      <p role="status" className="text-[13px] text-muted">
        {r.loading}
      </p>
    );
  if (state.status === "error")
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-[13px]">
        <p className="text-danger-text">{r[state.kind === "failed" ? "failed" : state.kind]}</p>
        {state.kind !== "notFound" && (
          <button
            type="button"
            onClick={retry}
            className="rounded-full border border-border px-3 py-1 text-[12.5px] hover:border-accent-line hover:text-accent-text"
          >
            {r.retry}
          </button>
        )}
      </div>
    );
  const { thread } = state;
  const hidden = all ? 0 : Math.max(0, thread.messages.length - 2);
  const provider = thread.provenance.providerKey === "microsoft" ? "Outlook" : "Gmail";
  return (
    <div className="flex flex-col gap-3">
      {heading && (
        <p className="text-[15px] font-medium tracking-[-0.01em] md:text-base">{thread.subject}</p>
      )}
      <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-faint">
        <span>{thread.provenance.source}</span>
        <span aria-hidden>·</span>
        <span>{t.workspace.email.messages(thread.messages.length)}</span>
        {thread.url && /^https:\/\//.test(thread.url) && (
          <a
            href={thread.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-accent-text hover:underline"
          >
            {r.openIn(provider)}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </p>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="self-start rounded-full px-2 py-1 text-[12.5px] text-accent-text hover:bg-surface-2"
        >
          {r.earlier(hidden)}
        </button>
      )}
      {thread.messages.slice(hidden).map((m) => (
        <MessageView key={m.id} m={m} timezone={timezone} />
      ))}
      <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        {r.privacy}
      </p>
    </div>
  );
}

/** The reader as a dialog (a bottom sheet on phones), opened from an email in a list. */
export function EmailReaderDialog({
  threadId,
  subject,
  timezone,
  onClose,
}: {
  threadId: string | null;
  subject: string;
  timezone: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={threadId !== null}
      onClose={onClose}
      title={subject || t.workspace.email.reader.title}
      className="sm:max-w-2xl"
    >
      {threadId && (
        <ScrollArea>
          <EmailThreadReader threadId={threadId} timezone={timezone} heading={false} />
        </ScrollArea>
      )}
    </Dialog>
  );
}

function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("max-h-[70dvh] overflow-y-auto overscroll-contain pr-1", className)}>
      {children}
    </div>
  );
}
