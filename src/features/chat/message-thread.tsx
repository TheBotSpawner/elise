"use client";

import { motion } from "motion/react";
import Markdown from "react-markdown";

import type { ToolDisplay } from "@/core/agents/tools";
import { useI18n } from "@/lib/i18n/client";

import { ApprovalCard, type ApprovalPhase } from "./approval-card";
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
}

/** Conversation thread (reference Chat): 720 px column, 15 / 1.6 body, mono labels. */
export function MessageThread({
  messages,
  timezone,
  handlers,
}: {
  messages: ChatMessage[];
  timezone: string;
  handlers: ThreadHandlers;
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
    <ol className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 pt-5 pb-32 md:gap-7 md:px-0 md:pt-6 md:pb-40">
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
              <UserMessage content={m.content} animate={Boolean(m.fresh)} />
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
    </ol>
  );
}

function UserMessage({ content, animate }: { content: string; animate: boolean }) {
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="flex justify-end"
    >
      <p className="max-w-[75%] rounded-[18px_18px_6px_18px] bg-surface-2 px-4 py-[11px] text-[15px] leading-[1.5] whitespace-pre-wrap md:max-w-[520px] md:px-[18px] md:py-3 md:leading-[1.55]">
        {content}
      </p>
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

        {message.tools.map((tool) => {
          const o = tool.outcome;
          if (!o) return null;
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
