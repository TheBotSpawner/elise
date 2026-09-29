"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Orb } from "@/components/elise/orb/orb";
import { ORB_FLIGHT, ORB_LAYOUT_ID, useOrbPresence } from "@/components/elise/orb/orb-presence";
import type { ToolDisplay } from "@/core/agents/tools";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { Composer } from "./composer";
import { MessageThread } from "./message-thread";
import type { ChatMessage } from "./types";
import { useEliseChat } from "./use-elise-chat";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface HomeAmbient {
  dueToday: number;
  overdue: number;
  pendingApprovals: number;
  /** Today's scheduled result, shown as one quiet line — never a modal. */
  brief?: { id: string; read: boolean } | null;
}

/**
 * The center of ELISE. Empty: the Home hero (Orb 440/300, status, headline, input dock).
 * After the first send the hero Orb flies into the nav brand slot, the dock glides to the
 * bottom and the thread takes over (motion spec "Home → Chat").
 */
export function ChatSurface({
  conversationId,
  initialMessages = [],
  timezone,
  userName = "",
  ambient,
  space,
}: {
  conversationId?: string;
  initialMessages?: ChatMessage[];
  timezone: string;
  userName?: string;
  ambient?: HomeAmbient;
  /** "Ask ELISE" from a Knowledge Space: the new conversation searches it first. */
  space?: { id: string; path: string } | null;
}) {
  const { t } = useI18n();
  const desktop = useIsDesktop();
  const presence = useOrbPresence();
  const { messages, send, stop, busy, orbState, trackApproval, markApprovalResolved } =
    useEliseChat({
      conversationId,
      messages: initialMessages,
      spaceId: space?.id,
    });
  const empty = messages.length === 0;

  // Publish Elise's state to the shared Orb (nav brand slot + mobile header).
  const { setState, setDocked } = presence;
  useEffect(() => setState(orbState), [orbState, setState]);
  useEffect(() => setDocked(!empty), [empty, setDocked]);
  useEffect(
    () => () => {
      setDocked(false);
      setState("idle");
    },
    [setDocked, setState],
  );

  // Keep the view pinned to the bottom unless the user scrolled up; then offer "New reply".
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
      setPinned(atBottom);
      if (atBottom) setUnseen(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const lastContent = messages.at(-1);
  const signature = `${messages.length}:${lastContent?.content.length ?? 0}:${lastContent?.tools.length ?? 0}`;
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  useEffect(() => {
    if (empty) return;
    if (pinnedRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
    else setUnseen(true);
  }, [signature, empty]);

  const onApprovalResolved = useCallback(
    (approvalId: string, decision: "approved" | "rejected", display?: ToolDisplay) =>
      markApprovalResolved(approvalId, decision, display),
    [markApprovalResolved],
  );

  const composer = (
    <Composer
      placeholder={
        empty ? (desktop ? t.home.placeholder : t.home.placeholderMobile) : t.chat.replyPlaceholder
      }
      label={t.chat.placeholder}
      busy={busy}
      onSend={(text) => void send(text)}
      onStop={stop}
      sendLabel={t.chat.send}
      stopLabel={t.chat.stop}
    />
  );

  if (empty) {
    return (
      <main className="relative flex flex-1 flex-col items-center px-4 pb-32 md:px-0 md:pb-24">
        <div aria-hidden className="elise-halo pointer-events-none fixed inset-0 -z-10" />
        <motion.div
          layoutId={ORB_LAYOUT_ID}
          transition={ORB_FLIGHT}
          className="mt-11 shrink-0 md:-mt-2"
        >
          <Orb state={orbState} size="fill" className="size-[300px] md:size-[440px]" />
        </motion.div>
        <AnimatePresence>
          <motion.div
            key="hero-copy"
            exit={{ opacity: 0, y: -8, transition: { duration: 0.16 } }}
            className="flex flex-col items-center"
          >
            <HomeStatus state={orbState} userName={userName} timezone={timezone} />
            {space && (
              <Link
                href={`/knowledge/spaces/${space.id}`}
                className="mt-3 flex h-8 items-center gap-2 rounded-full border border-accent-line px-3 text-[13px] text-accent-text"
              >
                <span className="type-label text-faint">{t.knowledge.inSpace}</span>
                {space.path}
              </Link>
            )}
            <h1 className="mt-3 text-center text-[30px] leading-[1.15] font-light tracking-[-0.025em] md:text-[46px] md:leading-[1.1]">
              {t.chat.emptyTitle}
            </h1>
            {ambient && <Ambient ambient={ambient} />}
          </motion.div>
        </AnimatePresence>
        <div className="fixed inset-x-4 bottom-7 z-30 md:static md:mt-9 md:w-[720px]">
          {composer}
        </div>
      </main>
    );
  }

  return (
    <main className="relative flex flex-1 flex-col">
      <MessageThread
        messages={messages}
        timezone={timezone}
        handlers={{ onApprovalResolved, onApprovalPhase: trackApproval }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-30 bg-[linear-gradient(transparent,var(--bg)_55%)] md:h-33"
      />
      <div className="fixed inset-x-4 bottom-7 z-30 md:inset-x-0 md:bottom-9 md:mx-auto md:w-[720px]">
        <AnimatePresence>
          {unseen && (
            <motion.button
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE }}
              onClick={() =>
                window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
              }
              className="absolute -top-12 left-1/2 h-9 -translate-x-1/2 rounded-full border border-border-strong bg-[var(--menu-bg)] px-4 text-[13px] backdrop-blur"
            >
              {t.chat.newReply}
            </motion.button>
          )}
        </AnimatePresence>
        {composer}
      </div>
    </main>
  );
}

function HomeStatus({
  state,
  userName,
  timezone,
}: {
  state: ReturnType<typeof useEliseChat>["orbState"];
  userName: string;
  timezone: string;
}) {
  const { t } = useI18n();
  let text: string;
  if (state === "idle") {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: timezone,
      }).format(new Date()),
    );
    const g =
      hour < 12
        ? t.home.greeting.morning
        : hour < 20
          ? t.home.greeting.afternoon
          : t.home.greeting.evening;
    text = g(userName);
  } else {
    text = t.home.status[state];
  }
  return (
    <p
      aria-live="polite"
      className={cn(
        "-mt-[22px] flex h-7 items-center type-status text-[11px] md:-mt-9 md:text-[12px]",
        state === "waiting_approval"
          ? "text-approval-text"
          : state === "error"
            ? "text-danger-text"
            : "text-muted",
      )}
    >
      {text}
    </p>
  );
}

/** Real, quiet context under the input — never a dashboard (docs/product/05 §14). */
function Ambient({ ambient }: { ambient: HomeAmbient }) {
  const { t } = useI18n();
  const items = [
    ambient.dueToday > 0 && {
      label: t.home.today,
      text: t.home.tasksDue(ambient.dueToday),
      href: "/my-elise/tasks",
    },
    ambient.overdue > 0 && {
      label: t.tasks.overdue,
      text: t.home.overdue(ambient.overdue),
      href: "/my-elise/tasks",
    },
    ambient.pendingApprovals > 0 && {
      label: t.home.approvals,
      text: t.home.pending(ambient.pendingApprovals),
      href: "/approvals",
    },
  ].filter(Boolean) as { label: string; text: string; href: string }[];
  const brief = ambient.brief;
  if (items.length === 0 && !brief) return null;
  return (
    <ul className="mt-5 flex flex-col items-center gap-1 text-[13px] text-muted md:fixed md:inset-x-10 md:bottom-8 md:mt-0 md:flex-row md:justify-center md:gap-14">
      {brief && (
        <li className="flex h-8 items-center gap-3">
          <span className={cn("flex items-center gap-2", brief.read ? "text-faint" : "text-fg")}>
            {!brief.read && <span aria-hidden className="size-1.5 rounded-full bg-accent" />}
            {t.brief.ready}
          </span>
          <Link
            href={`/schedules/results/${brief.id}`}
            className="text-accent-text hover:underline"
          >
            {t.brief.view}
          </Link>
        </li>
      )}
      {items.map((item) => (
        <li key={item.label}>
          <Link href={item.href} className="flex h-8 items-baseline gap-2.5 hover:text-fg">
            <span className="type-label text-faint">{item.label}</span>
            <span>{item.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
