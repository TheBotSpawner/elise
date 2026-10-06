"use client";

import { Volume2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import { useOrbPresence } from "@/components/elise/orb/orb-presence";
import { resolveOrbState, type OrbState } from "@/components/elise/orb/orb-states";
import { threadUrl, type ThreadRef } from "@/core/interaction";
import { WORKSPACE_LIMITS, type WorkspaceState } from "@/core/workspace/model";
import { ContextIndicator, type ContextOption } from "@/features/contexts/context-indicator";
import { SpaceGlyph } from "@/features/knowledge/appearance";
import { duckMusic, receiveMusic } from "@/features/music/controller";
import { useMusic } from "@/features/music/music-view";
import { receiveTimers } from "@/features/time/time-view";
import { useLiveVoice } from "@/features/voice/use-live-voice";
import { useVoice } from "@/features/voice/use-voice";
import type { DockCaption } from "@/features/workspace/canvas/dock";
import { LiveCanvas } from "@/features/workspace/canvas/live-canvas";
import { SurfaceView, type CanvasHandlers } from "@/features/workspace/canvas/surface-view";
import { useWorkspaceController } from "@/features/workspace/use-workspace";
import { useOnline } from "@/hooks/use-online";
import { forgetThread, homeArrival, readActiveThread, rememberThread } from "@/lib/active-thread";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { NewChatButton } from "./continuity";
import type { ChatMessage } from "./types";
import { useEliseChat } from "./use-elise-chat";

export interface HomeAmbient {
  dueToday: number;
  overdue: number;
  pendingApprovals: number;
  /** Today's scheduled result, shown as one quiet line — never a modal. */
  brief?: { id: string; read: boolean } | null;
  /** A Live Workspace still active from earlier: one quiet "Continue" line. */
  resume?: { thread: ThreadRef; description: string } | null;
}

/** Reads that gather (the Orb "searches"); anything else that runs is "executing". */
const GATHERING = /\.(search|list|get|find|read|prepare|brief|research|today|recall)/i;

/** Plain words for the dock caption: no markdown marks, no links, at most a few sentences. */
function plain(text: string): string {
  return text
    .replace(/<spoken>[\s\S]*?<\/spoken>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

/**
 * The center of ELISE: the Live Canvas (ADR-021). Voice or text in, a visual composition out;
 * the conversation stays available as a secondary transcript. Home and a reopened
 * conversation share it: a conversation without Surfaces simply reads as its thread.
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
  contexts = [],
  run,
  firstPrompts,
  gone = null,
  fresh = false,
  narration = null,
}: {
  /** A scheduled conversation's opening (ADR-041): ELISE says it on "Listen". */
  narration?: { text: string } | null;
  /** The tab's active interaction no longer exists (deleted, inaccessible): forget it. */
  gone?: string | null;
  /** Arrived from "Nueva conversación". */
  fresh?: boolean;
  /** Right after onboarding: first prompts built from what was set up (ADR-019). */
  firstPrompts?: string[] | null;
  /** "Run" from My Elise › Shortcuts: this Shortcut's phrase is sent once, as typed. */
  run?: string | null;
  /** The user's Context Profiles, for switching from the indicator (ADR-016). */
  contexts?: ContextOption[];
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
  const presence = useOrbPresence();
  const online = useOnline();
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
    failedDraft,
  } = useEliseChat({
    thread,
    messages: initialMessages,
    spaceId: space?.id,
    workspace: initialWorkspace,
  });
  // The tab's active interaction (ADR-032): an opened one becomes it; a bare Home visit in a
  // tab that has one opens it again (the pre-paint script kept the fresh Home hidden).
  const router = useRouter();
  const threadKind = thread?.kind;
  const threadId = thread?.id;
  useEffect(() => {
    const step = homeArrival({
      thread: threadKind && threadId ? { kind: threadKind, id: threadId } : null,
      gone,
      fresh,
      pointer: readActiveThread(),
      search: window.location.search,
    });
    if (step.remember) rememberThread(step.remember);
    if (step.forget) forgetThread(step.forget === "all" ? undefined : step.forget);
    if (step.cleanUrl) window.history.replaceState(null, "", "/");
    if (step.open) router.replace(step.open);
    else delete document.documentElement.dataset.resuming;
  }, [threadKind, threadId, gone, fresh, router]);
  const ranRef = useRef(false);
  // "?welcome=1" is a one-time landing: a reload shows the normal Home.
  useEffect(() => {
    if (firstPrompts) window.history.replaceState(null, "", "/");
  }, [firstPrompts]);
  useEffect(() => {
    if (!run || ranRef.current) return;
    ranRef.current = true;
    window.history.replaceState(null, "", "/");
    void send(run);
  }, [run, send]);
  // Voice is another way into the same ELISE (ADR-014): same send, same stream, same Surfaces.
  const legacyVoice = useVoice({ prefs: voice, send, stop, subscribe, level: presence.level });
  const liveVoice = useLiveVoice({
    prefs: voice,
    send,
    stop,
    getThread,
    subscribe,
    level: presence.level,
  });
  // GPT-Live when the deployment offers it (ADR-026); `?voice=legacy|live` compares both.
  const [runtime] = useState(() => {
    const asked =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("voice");
    return asked === "legacy" || asked === "live" ? asked : (voice.runtime ?? "legacy");
  });
  const voiceSession = runtime === "live" ? liveVoice : legacyVoice;
  // Music (ADR-042): results of music tools reach the page's one player state.
  useEffect(
    () =>
      subscribe((e) => {
        if (
          e.type === "tool_finished" &&
          e.outcome.status === "succeeded" &&
          e.outcome.display?.kind === "music"
        )
          void receiveMusic(e.outcome.display);
        // Native Time (ADR-045): a new or changed timer shows on every view at once.
        if (
          e.type === "tool_finished" &&
          e.outcome.status === "succeeded" &&
          (e.outcome.display?.kind === "timer" || e.outcome.display?.kind === "timers")
        )
          receiveTimers(e.outcome.display);
      }),
    [subscribe],
  );
  // Music lowers while ELISE speaks and comes back after (where the volume can be set).
  const speaking = voiceSession.state.phase === "speaking";
  useEffect(() => void duckMusic(speaking), [speaking]);
  // Music starting or stopping changes the room: voice re-measures it (never heard as speech).
  const musicPlaying = Boolean(useMusic().payload?.playing);
  const ambientRef = useRef(voiceSession.ambientChanged);
  useEffect(() => {
    ambientRef.current = voiceSession.ambientChanged;
  });
  useEffect(() => ambientRef.current(), [musicPlaying]);
  const voiceOn = voice.enabled && voiceSession.supported;
  const phase = voiceSession.state.phase;
  const last = messages.at(-1);
  const turnTools = last?.role === "assistant" ? last.tools : [];
  const runningTool = turnTools.findLast((x) => !x.outcome);
  const voiceOrb: OrbState[] =
    phase === "user_speaking"
      ? ["user_speaking"]
      : phase === "listening" || phase === "interrupted" || phase === "arming"
        ? ["listening"]
        : phase === "speaking"
          ? ["speaking"]
          : phase === "executing"
            ? ["executing"]
            : phase === "waiting_approval"
              ? ["waiting_approval"]
              : phase === "finalizing_input" || phase === "thinking"
                ? ["thinking"]
                : phase === "sleeping"
                  ? ["sleeping"]
                  : phase === "offline"
                    ? ["attention"]
                    : [];
  const chatOrb: OrbState =
    chatOrbState === "executing" && runningTool && GATHERING.test(runningTool.name)
      ? "searching"
      : chatOrbState;
  const orbState = resolveOrbState([...voiceOrb, chatOrb]);
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

  // A quick confirmation (a settings change) appears above the dock and leaves on its own.
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

  const {
    focus,
    pin,
    dismiss,
    runAction,
    approvalResolved,
    loadDetail,
    showFromThread,
    pending,
    calendar,
  } = controller;
  const handlers: CanvasHandlers = useMemo(
    () => ({
      onAction: (surface, action, itemId) => void runAction(surface, action, itemId),
      onPrompt: (text) => void send(text),
      onCalendar: (surface, change) => void calendar(surface, change),
      // Opening an item inside a Surface is focusing it (the same op as "open the second email").
      onExpand: (surface, itemId) => focus(surface.id, itemId),
      onFocus: (surface, item) => focus(surface.id, item ?? null),
      onUnfocus: () => focus(null),
      onPin: pin,
      onDismiss: dismiss,
      loadDetail,
      onApprovalResolved: approvalResolved,
      onApprovalPhase: trackApproval,
      pending,
      busy,
    }),
    [
      runAction,
      send,
      calendar,
      focus,
      pin,
      dismiss,
      loadDetail,
      approvalResolved,
      trackApproval,
      pending,
      busy,
    ],
  );
  const threadHandlers = useMemo(
    () => ({
      onApprovalResolved: approvalResolved,
      onApprovalPhase: trackApproval,
      onShowSurface: (ids: string[], messageId: string | null, callId: string) =>
        void showFromThread(ids, messageId, callId),
    }),
    [approvalResolved, trackApproval, showFromThread],
  );

  // One Orb: the Canvas owns it now (hero, centre or dock), so the nav keeps its brand dot.
  const { setState, setDocked, setReceded } = presence;
  useEffect(() => setState(orbState), [orbState, setState]);
  const working = messages.length > 0 && workspace.surfaces.some((s) => !s.transient);
  useEffect(() => setReceded(working), [working, setReceded]);
  useEffect(() => {
    setDocked(false);
    return () => {
      setState("idle");
      setReceded(false);
    };
  }, [setDocked, setState, setReceded]);

  // What the dock says: the words being heard, ELISE's latest reply, or a problem.
  const problem = voiceSession.state.problem ? t.voice.problems[voiceSession.state.problem] : null;
  const lastAssistant = messages.findLast((m) => m.role === "assistant");
  const lastUser = messages.findLast((m) => m.role === "user");
  const elise = lastAssistant ? plain(lastAssistant.content) : "";
  const caption: DockCaption = voiceSession.state.partial
    ? { who: "YOU", text: voiceSession.state.partial }
    : problem
      ? { who: "ELISE", text: problem, tone: "problem" }
      : orbState === "waiting_approval"
        ? { who: "ELISE", text: elise || t.canvas.approvalFirst, tone: "approval" }
        : busy && lastAssistant?.streaming && !elise
          ? { who: "YOU", text: lastUser?.content ?? "" }
          : elise
            ? { who: "ELISE", text: elise }
            : phase === "sleeping"
              ? { who: null, text: t.voice.asleep }
              : { who: null, text: "" };
  const heroText = voiceSession.state.partial
    ? { who: "YOU" as const, text: voiceSession.state.partial }
    : elise
      ? { who: "ELISE" as const, text: elise }
      : null;

  const notices = (
    <>
      {narration && voiceSession.narrate && (
        <button
          type="button"
          onClick={() => voiceSession.narrate(narration.text)}
          className="inline-flex h-8 items-center gap-2 rounded-full border border-accent-line bg-[var(--menu-bg)] px-3 text-[13px] text-accent-text backdrop-blur hover:bg-accent-soft"
        >
          <Volume2 aria-hidden className="size-3.5" />
          {t.schedules.conversation.listen}
        </button>
      )}
      {!online && (
        <span
          role="status"
          className="inline-flex h-8 items-center gap-2 rounded-full border border-border-strong bg-[var(--menu-bg)] px-3 text-[13px] text-muted backdrop-blur"
        >
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-warning" />
          {t.chat.offline}
        </span>
      )}
      {workspace.context && messages.length > 0 && (
        <ContextIndicator
          context={workspace.context}
          options={contexts}
          disabled={busy}
          onChange={controller.setContext}
        />
      )}
      <AnimatePresence initial={false}>
        {confirmations.map((s) => (
          <div key={s.id} className="w-[min(420px,calc(100vw-32px))]">
            <SurfaceView
              surface={s}
              size="medium"
              tier="secondary"
              timezone={timezone}
              handlers={handlers}
            />
          </div>
        ))}
      </AnimatePresence>
    </>
  );

  return (
    <main className="elise-home relative flex flex-1 flex-col">
      <LiveCanvas
        workspace={workspace}
        messages={messages}
        timezone={timezone}
        handlers={handlers}
        threadHandlers={threadHandlers}
        running={busy}
        activity={turnTools}
        orbState={orbState}
        level={presence.level}
        voice={voiceOn ? { state: voiceSession.state, handlers: voiceHandlers } : null}
        caption={caption}
        heroText={heroText}
        onSend={(text) => void send(text)}
        onStop={stop}
        onArrange={controller.arrange}
        offline={!online}
        failedDraft={failedDraft}
        notices={notices}
        newChat={thread || messages.length > 0 ? <NewChatButton /> : null}
        idle={{
          status: <HomeStatus state={orbState} userName={userName} timezone={timezone} />,
          context: space ? (
            <Link
              href={`/knowledge/spaces/${space.id}`}
              className="mt-4 flex h-8 items-center gap-2 rounded-full border border-accent-line px-3 text-[13px] text-accent-text"
            >
              <SpaceGlyph
                icon={space.icon}
                color={space.color}
                size="sm"
                className="rounded-full"
              />
              {space.path}
            </Link>
          ) : null,
          below: (
            <>
              {ambient && <Ambient ambient={ambient} />}
              {firstPrompts && firstPrompts.length > 0 && (
                <div className="mt-6 flex max-w-[720px] flex-col items-center gap-3">
                  <p className="type-label text-faint">{t.onboarding.firstPromptsTitle}</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {firstPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => void send(prompt)}
                        className="min-h-11 rounded-full border border-border-strong px-4 text-[14px] transition-colors hover:border-accent-line hover:bg-accent-soft"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                  {voiceOn && <p className="text-[13px] text-muted">{t.onboarding.voiceHint}</p>}
                </div>
              )}
            </>
          ),
        }}
      />
    </main>
  );
}

function HomeStatus({
  state,
  userName,
  timezone,
}: {
  state: OrbState;
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
        "flex h-7 items-center type-status text-[11px] md:text-[11.5px]",
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
    // One row model: every item is a 32px cell centred on the row; inside it, label and value
    // share a baseline (the small mono eyebrow sits on the text's line, not above or below it).
    <ul className="mt-6 flex flex-col items-center gap-1 text-[13px] leading-5 text-muted md:flex-row md:flex-wrap md:justify-center md:gap-x-10">
      {brief && (
        <li className="flex h-8 items-center">
          <span className="flex items-baseline gap-3">
            <span
              className={cn("flex items-baseline gap-2", brief.read ? "text-faint" : "text-fg")}
            >
              {!brief.read && (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 self-center rounded-full bg-accent"
                />
              )}
              {t.brief.ready}
            </span>
            <Link
              href={`/schedules/results/${brief.id}`}
              className="text-accent-text hover:underline"
            >
              {t.brief.view}
            </Link>
          </span>
        </li>
      )}
      {items.map((item) => (
        <li key={item.label} className="flex h-8 items-center">
          <Link href={item.href} className="flex items-baseline gap-2.5 hover:text-fg">
            <span className="font-mono text-[10.5px] tracking-[0.16em] text-faint uppercase">
              {item.label}
            </span>
            <span>{item.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
