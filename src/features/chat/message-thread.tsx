"use client";

import { ArrowUpRight, Mic } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";

import type { ToolDisplay } from "@/core/agents/tools";
import { activityLabel } from "@/features/workspace/activity-labels";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ApprovalCard, type ApprovalPhase } from "./approval-card";
import { SentAttachments } from "./attachments-ui";
import { DisplayCard } from "./result-cards";
import { ToolTrace } from "./trace";
import type { ChatMessage } from "./types";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface ThreadHandlers {
  onApprovalResolved: (
    approvalId: string,
    decision: "approved" | "rejected",
    display?: ToolDisplay,
  ) => void;
  onApprovalPhase: (phase: ApprovalPhase) => void;
  /** A result shown in the Live Workspace: bring it (back) into view. */
  onShowSurface?: (surfaceIds: string[], messageId: string | null, callId: string) => void;
}

/** Conversation thread (reference Chat): 720 px column, 15 / 1.6 body, mono labels. */
export function MessageThread({
  messages,
  timezone,
  handlers,
  column = false,
  after,
}: {
  messages: ChatMessage[];
  timezone: string;
  handlers: ThreadHandlers;
  /** Beside the Live Workspace: fills its column instead of the centered 720 px. */
  column?: boolean;
  /** Rendered after the last message (the workspace stack on small screens). */
  after?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
  const longDay = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  const today = day.format(new Date());

  return (
    <ol
      className={cn(
        "flex w-full flex-col gap-5 px-4 pt-5 md:gap-7 md:pt-6",
        column ? "pb-6 lg:px-0" : "mx-auto max-w-[720px] pb-32 md:px-0 md:pb-40",
      )}
    >
      {messages.map((m, i) => {
        const at = new Date(m.createdAt);
        const d = day.format(at);
        const showDivider = i === 0 || day.format(new Date(messages[i - 1]!.createdAt)) !== d;
        return (
          <li key={m.id} className="flex flex-col gap-5 md:gap-7">
            {showDivider && (
              <p className="text-center type-label text-faint">
                {d === today ? t.chat.today : longDay.format(at)} · {time.format(at)}
              </p>
            )}
            {m.role === "user" ? (
              <UserMessage
                content={m.content}
                attachments={m.attachments}
                animate={Boolean(m.fresh)}
                spoken={m.modality === "voice"}
              />
            ) : (
              <AssistantMessage
                message={m}
                time={time.format(at)}
                timezone={timezone}
                handlers={handlers}
              />
            )}
          </li>
        );
      })}
      {after && <li id="live-workspace">{after}</li>}
    </ol>
  );
}

function UserMessage({
  content,
  attachments,
  animate,
  spoken,
}: {
  content: string;
  attachments?: ChatMessage["attachments"];
  animate: boolean;
  spoken: boolean;
}) {
  const { t } = useI18n();
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex flex-col items-end gap-1"
    >
      {spoken && (
        <span className="flex items-center gap-1 type-label text-faint">
          <Mic className="size-3" aria-hidden />
          {t.voice.spoken}
        </span>
      )}
      <p className="max-w-[75%] rounded-[18px_18px_6px_18px] bg-surface-2 px-4 py-[11px] text-[15px] leading-[1.5] whitespace-pre-wrap md:max-w-[520px] md:px-[18px] md:py-3 md:leading-[1.55]">
        {content}
      </p>
      {attachments?.length ? <SentAttachments files={attachments} /> : null}
    </motion.div>
  );
}

function AssistantMessage({
  message,
  time,
  timezone,
  handlers,
}: {
  message: ChatMessage;
  time: string;
  timezone: string;
  handlers: ThreadHandlers;
}) {
  const { t } = useI18n();
  const running = Boolean(message.streaming);
  const thinking = running && !message.content && message.tools.length === 0;

  return (
    <article aria-label={t.chat.responseLabel} className="flex gap-4">
      <div
        aria-hidden
        className="mt-px hidden size-6 shrink-0 place-items-center rounded-full border border-accent-line md:grid"
      >
        <span className="size-1.5 rounded-full bg-accent" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3 md:gap-3.5">
        <p className="flex items-baseline gap-2.5 type-label text-faint">
          <span className="text-muted">ELISE</span>
          <span>{time}</span>
        </p>

        {thinking && (
          <p className="animate-pulse type-status text-[11px] text-faint">
            {t.home.status.thinking}
          </p>
        )}

        {message.content && (
          <div className="prose-elise">
            <Markdown
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-accent-text underline"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </Markdown>
          </div>
        )}

        <ToolTrace tools={message.tools} running={running} />

        <SurfaceChips message={message} handlers={handlers} />

        {message.tools.map((tool) => {
          const o = tool.outcome;
          // An email search that found nothing says nothing when the same turn found the mail
          // another way (a thread, another search): never "0 correos" next to the match.
          if (emptyEmailSearch(o) && message.tools.some((x) => foundEmail(x.outcome))) return null;
          // Shown in the Live Workspace (a chip above), or a step inside an orchestration.
          if (!o || tool.parentId || (tool.surfaceIds?.length && handlers.onShowSurface))
            return null;
          if (o.status === "approval_required") {
            return (
              <div key={tool.callId} className="flex flex-col gap-3 md:gap-3.5">
                <ApprovalCard
                  approvalId={o.approvalId}
                  summary={o.summary}
                  reason={o.reason}
                  tool={tool.name}
                  preview={o.preview}
                  timezone={timezone}
                  autoFocus={running}
                  initialResolution={tool.resolution?.decision ?? null}
                  onResolved={handlers.onApprovalResolved}
                  onPhase={handlers.onApprovalPhase}
                />
                {tool.resolution?.display && (
                  <DisplayCard display={tool.resolution.display} timezone={timezone} animate />
                )}
              </div>
            );
          }
          if (o.status === "succeeded" && o.display) {
            return (
              <DisplayCard
                key={tool.callId}
                display={o.display}
                timezone={timezone}
                animate={Boolean(message.fresh)}
              />
            );
          }
          return null;
        })}

        {message.error && (
          <p role="alert" className="text-[14px] text-danger-text">
            {message.error.code === "AI_NOT_CONFIGURED"
              ? t.chat.aiNotConfigured
              : t.errors.codes[message.error.code]}
            {message.error.referenceId && (
              <span className="ml-2 font-mono text-[11.5px] text-faint">{`${t.chat.reference}: ${message.error.referenceId}`}</span>
            )}
          </p>
        )}
      </div>
    </article>
  );
}

/** Retrieval: where an answer came from (ADR-071), grouped as one "Sources · N" chip. */
const EVIDENCE_TOOL =
  /^(knowledge\.search|history\.search|web\.(search|searchNews|research|open))$/;

type ShownTool = ChatMessage["tools"][number];

/** The documents behind the evidence, by name — never a generic "Knowledge" twice. */
export function evidenceSources(tools: ShownTool[]) {
  const docs = new Map<string, { title: string; space: string }>();
  const other: ShownTool[] = [];
  for (const tool of tools) {
    const d = tool.outcome?.status === "succeeded" ? tool.outcome.display : undefined;
    if (d?.kind === "knowledge_evidence")
      for (const e of d.evidence)
        if (!docs.has(e.itemId)) docs.set(e.itemId, { title: e.title, space: e.spaceName });
    if (d?.kind !== "knowledge_evidence") other.push(tool);
  }
  return { docs: [...docs], other };
}

/** Results presented as Surfaces: one quiet chip each, which brings the Surface into view. */
function SurfaceChips({ message, handlers }: { message: ChatMessage; handlers: ThreadHandlers }) {
  const { t } = useI18n();
  const shown = message.tools.filter((tool) => tool.surfaceIds?.length && tool.outcome);
  if (!shown.length || !handlers.onShowSurface) return null;
  const storedId = message.serverId ?? (message.fresh ? null : message.id);
  const show = (tool: ShownTool) =>
    handlers.onShowSurface?.(tool.surfaceIds ?? [], storedId, tool.callId);
  const evidence = shown.filter((tool) => EVIDENCE_TOOL.test(tool.name));
  const { docs, other } = evidenceSources(evidence);
  const chip =
    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors";
  return (
    <ul className="flex flex-wrap items-start gap-2">
      {evidence.length > 0 && (
        <li>
          <details className="group">
            <summary
              className={cn(
                chip,
                "cursor-pointer list-none border-border text-muted hover:border-accent-line hover:text-fg [&::-webkit-details-marker]:hidden",
              )}
            >
              {t.workspace.answer.sources(docs.length + other.length)}
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1 pl-3 text-[12.5px]">
              {docs.map(([id, d]) => (
                <li key={id}>
                  <a href={`/knowledge/items/${id}`} className="hover:text-accent-text">
                    {d.title}
                  </a>
                  <span className="text-faint"> · {d.space}</span>
                </li>
              ))}
              {other.map((tool) => (
                <li key={tool.callId}>
                  <button
                    type="button"
                    onClick={() => show(tool)}
                    className="hover:text-accent-text"
                  >
                    {activityLabel(t, tool.name, false)}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => show(evidence.at(-1)!)}
                  className="inline-flex items-center gap-1 text-faint hover:text-accent-text"
                >
                  {t.workspace.focus}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </button>
              </li>
            </ul>
          </details>
        </li>
      )}
      {shown
        .filter((tool) => !evidence.includes(tool))
        .map((tool) => {
          const waiting = tool.outcome?.status === "approval_required" && !tool.resolution;
          return (
            <li key={tool.callId}>
              <button
                type="button"
                onClick={() => show(tool)}
                className={cn(
                  chip,
                  waiting
                    ? "border-approval-line text-approval-text"
                    : "border-border text-muted hover:border-accent-line hover:text-fg",
                )}
              >
                {waiting ? t.workspace.approvalPending : activityLabel(t, tool.name, false)}
                <span className="text-faint">· {t.workspace.shown}</span>
                <ArrowUpRight className="size-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
    </ul>
  );
}

type Outcome = ChatMessage["tools"][number]["outcome"];
const emptyEmailSearch = (o: Outcome) =>
  o?.status === "succeeded" && o.display?.kind === "email_list" && !o.display.messages.length;
const foundEmail = (o: Outcome) =>
  o?.status === "succeeded" &&
  (o.display?.kind === "email_thread" ||
    (o.display?.kind === "email_list" && o.display.messages.length > 0));
