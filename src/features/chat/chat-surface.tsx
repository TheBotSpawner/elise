"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import { Orb } from "@/components/elise/orb/orb";
import { ORB_FLIGHT, ORB_LAYOUT_ID, useOrbPresence } from "@/components/elise/orb/orb-presence";
import { resolveOrbState, type OrbState } from "@/components/elise/orb/orb-states";
import { threadUrl, type ThreadRef } from "@/core/interaction";
import { WORKSPACE_LIMITS, type WorkspaceState } from "@/core/workspace/model";
import { SpaceGlyph } from "@/features/knowledge/appearance";
import { useVoice } from "@/features/voice/use-voice";
import { MicButton, VoiceBar } from "@/features/voice/voice-controls";
import { LiveWorkspace, SurfaceCard } from "@/features/workspace/live-workspace";
import type { SurfaceHandlers } from "@/features/workspace/surfaces";
import { useWorkspaceController } from "@/features/workspace/use-workspace";
import { useIsDesktop, useIsWide } from "@/hooks/use-is-desktop";
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
  /** A Live Workspace still active from earlier: one quiet "Continue" line. */
  resume?: { thread: ThreadRef; description: string } | null;
}

/**
 * The center of ELISE. Empty: the Home hero (Orb 440/300, status, headline, input dock).
 * After the first send the hero Orb flies into the nav brand slot, the dock glides to the
 * bottom and the thread takes over (motion spec "Home → Chat").
 */
export function ChatSurface({
  thread,
  voice,
  initialMessages = [],
  timezone,
  userName = "",
  ambient,
  space,
  workspaceId,
  initialWorkspace,
}: {
  /** For Realtime updates of this conversation's Live Workspace. */
  workspaceId: string;
  initialWorkspace?: WorkspaceState;
  /** The interaction being continued: a History conversation or a voice session. */
  thread?: ThreadRef;
  /** The user's voice preferences (ADR-014). */
  voice: VoicePreferences;
  initialMessages?: ChatMessage[];
  timezone: string;
  userName?: string;
  ambient?: HomeAmbient;
  /** "Ask ELISE" from a Knowledge Space: the new conversation searches it first. */
  space?: { id: string; path: string; icon: string; color: string } | null;
}) {
  const { t } = useI18n();
  const desktop = useIsDesktop();
  const wide = useIsWide();
  const presence = useOrbPresence();
  const {
    messages,
    send,
    stop,
    busy,
    orbState: chatOrbState,
    subscribe,
    trackApproval,
    markApprovalResolved,
    workspace,
    setWorkspace,
    outOfSync,
    clearOutOfSync,
    getThread,
  } = useEliseChat({
    thread,
    messages: initialMessages,
    spaceId: space?.id,
    workspace: initialWorkspace,
  });
  const empty = messages.length === 0;
  // Voice is another way into the same ELISE (ADR-014): same send, same stream, same Surfaces.
  const voiceSession = useVoice({ prefs: voice, send, subscribe, level: presence.level });
  const voiceOn = voice.enabled && voiceSession.supported;
  const phase = voiceSession.state.phase;
  const voiceOrb: OrbState[] =
    phase === "listening"
      ? ["listening"]
      : phase === "speaking"
        ? ["speaking"]
        : phase === "transcribing"
          ? ["thinking"]
          : [];
  const orbState = resolveOrbState([...voiceOrb, chatOrbState]);
  const voiceHandlers = {
    start: voiceSession.start,
    end: voiceSession.end,
    interrupt: voiceSession.interrupt,
    finishNow: voiceSession.finishNow,
    toggleMute: voiceSession.toggleMute,
  };
  const controller = useWorkspaceController({
    workspace,
    setWorkspace,
    getThread,
    busy,
    workspaceId,
    outOfSync,
    clearOutOfSync,
    onApprovalResolved: markApprovalResolved,
  });
  const last = messages.at(-1);
  const turnTools = last?.role === "assistant" ? last.tools : [];
  // Home becomes a workspace only while an intent has something worth showing; a quick
  // confirmation (a settings change) appears by the composer and leaves on its own.
  const active = !empty && workspace.surfaces.some((s) => !s.transient);
  const confirmations = workspace.surfaces.filter((s) => s.transient);
  const confirmationKey = confirmations.map((s) => `${s.id}:${s.updatedAt}`).join(",");
  const dismissRef = useRef(controller.dismiss);
  useEffect(() => {
    dismissRef.current = controller.dismiss;
  });
  const confirmationsRef = useRef(confirmations);
  useEffect(() => {
    confirmationsRef.current = confirmations;
  });
  useEffect(() => {
    if (!confirmationKey) return;
    const timer = window.setTimeout(() => {
      for (const s of confirmationsRef.current) dismissRef.current(s);
    }, WORKSPACE_LIMITS.transientMs);
    return () => window.clearTimeout(timer);
  }, [confirmationKey]);
  const surfaceHandlers: SurfaceHandlers = {
    onAction: (surface, action, itemId) => void controller.runAction(surface, action, itemId),
    onPrompt: (text) => void send(text),
    onExpand: controller.expand,
    onApprovalResolved: controller.approvalResolved,
    onApprovalPhase: trackApproval,
    pending: controller.pending,
    busy,
  };

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
  const signature = `${messages.length}:${lastContent?.content.length ?? 0}:${lastContent?.tools.length ?? 0}:${wide ? 0 : workspace.surfaces.length}`;
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);
  useEffect(() => {
    if (empty) return;
    if (pinnedRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
    else setUnseen(true);
  }, [signature, empty]);

  const confirmationSlot = (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute inset-x-0 flex flex-col gap-2",
        // On the idle Home the headline sits above the input: show it below on larger screens.
        empty ? "bottom-full mb-3 md:top-full md:bottom-auto md:mt-3 md:mb-0" : "bottom-full mb-3",
      )}
    >
      {voiceOn && <VoiceBar state={voiceSession.state} handlers={voiceHandlers} />}
      <AnimatePresence initial={false}>
        {confirmations.map((s) => (
          <div key={s.id} className="pointer-events-auto">
            <SurfaceCard
              surface={s}
              timezone={timezone}
              handlers={surfaceHandlers}
              onDismiss={controller.dismiss}
              className="bg-[var(--menu-bg)] backdrop-blur"
            />
          </div>
        ))}
      </AnimatePresence>
    </div>
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
      voice={voiceOn ? <MicButton state={voiceSession.state} handlers={voiceHandlers} /> : null}
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
          {voiceOn ? (
            // The Orb is ELISE's voice presence: tap it to talk.
            <button
              type="button"
              onClick={
                phase === "idle"
                  ? voiceHandlers.start
                  : phase === "listening"
                    ? voiceHandlers.finishNow
                    : voiceHandlers.interrupt
              }
              aria-label={
                phase === "idle"
                  ? t.voice.start
                  : phase === "listening"
                    ? t.voice.finish
                    : t.voice.interrupt
              }
              className="block rounded-full focus-visible:outline-none"
            >
              <Orb
                state={orbState}
                size="fill"
                levelSource={presence.level}
                className="size-[300px] md:size-[440px]"
              />
            </button>
          ) : (
            <Orb state={orbState} size="fill" className="size-[300px] md:size-[440px]" />
          )}
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
                <SpaceGlyph
                  icon={space.icon}
                  color={space.color}
                  size="sm"
                  className="rounded-full"
                />
                {space.path}
              </Link>
            )}
            <h1 className="mt-3 text-center text-[30px] leading-[1.15] font-light tracking-[-0.025em] md:text-[46px] md:leading-[1.1]">
              {t.chat.emptyTitle}
            </h1>
            {ambient && <Ambient ambient={ambient} />}
          </motion.div>
        </AnimatePresence>
        <div className="fixed inset-x-4 bottom-7 z-30 md:relative md:inset-auto md:mt-9 md:w-[720px]">
          {confirmationSlot}
          {composer}
        </div>
      </main>
    );
  }

  const workspaceView = (variant: "pane" | "stack") => (
    <LiveWorkspace
      state={workspace}
      timezone={timezone}
      handlers={surfaceHandlers}
      activity={turnTools}
      running={busy}
      expanded={controller.expanded}
      onCollapse={controller.collapse}
      onDismiss={controller.dismiss}
      loadDetail={controller.loadDetail}
      variant={variant}
    />
  );
  const split = active && wide;

  return (
    <main
      className={cn(
        "relative flex flex-1 flex-col",
        split &&
          "mx-auto w-full max-w-[1480px] lg:grid lg:grid-cols-[minmax(360px,500px)_minmax(0,1fr)] lg:gap-10 lg:px-8 xl:grid-cols-[minmax(400px,540px)_minmax(0,1fr)]",
      )}
    >
      <div className={cn("flex min-w-0 flex-col", split && "min-h-[calc(100dvh-5rem)]")}>
        <MessageThread
          messages={messages}
          timezone={timezone}
          column={split}
          handlers={{
            onApprovalResolved: controller.approvalResolved,
            onApprovalPhase: trackApproval,
            onShowSurface: (ids, messageId, callId) =>
              void controller.showFromThread(ids, messageId, callId),
          }}
          after={active && !wide ? workspaceView("stack") : undefined}
        />
        {!split && voiceOn && phase !== "idle" && (
          // Room for the voice bar above the dock, so it never covers the last Surface.
          <div aria-hidden className="h-16 shrink-0" />
        )}
        {split && <div className="flex-1" />}
        {split && (
          <div className="sticky bottom-0 z-30 bg-[linear-gradient(transparent,var(--bg)_28%)] pt-8 pb-9">
            <div className="relative">
              {confirmationSlot}
              {composer}
            </div>
          </div>
        )}
      </div>
      {split && (
        <aside
          id="live-workspace"
          className="sticky top-20 h-[calc(100dvh-5rem)] [scrollbar-width:thin] overflow-y-auto overscroll-contain pt-6"
        >
          {workspaceView("pane")}
        </aside>
      )}
      {!split && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 z-20 h-30 bg-[linear-gradient(transparent,var(--bg)_55%)] md:h-33"
        />
      )}
      <div
        className={cn(
          "fixed inset-x-4 bottom-7 z-30 md:inset-x-0 md:bottom-9 md:mx-auto md:w-[720px]",
          split && "hidden",
        )}
      >
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
        {!split && confirmationSlot}
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
      href: "/my-elise/tasks?view=today",
    },
    ambient.overdue > 0 && {
      label: t.tasks.overdue,
      text: t.home.overdue(ambient.overdue),
      href: "/my-elise/tasks?view=overdue",
    },
    ambient.pendingApprovals > 0 && {
      label: t.home.approvals,
      text: t.home.pending(ambient.pendingApprovals),
      href: "/approvals",
    },
  ].filter(Boolean) as { label: string; text: string; href: string }[];
  const brief = ambient.brief;
  const resume = ambient.resume;
  if (resume)
    items.unshift({
      label: t.workspace.resumeLabel,
      text: t.workspace.resume(resume.description),
      href: threadUrl(resume.thread),
    });
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
