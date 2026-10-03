"use client";

import { ArrowLeft, Clock, LayoutGrid } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ClientToolTrace } from "@/application/chat-protocol";
import { AlertIcon, CheckIcon } from "@/components/elise/icons";
import { Orb } from "@/components/elise/orb/orb";
import { ORB_LAYOUT_ID } from "@/components/elise/orb/orb-presence";
import type { OrbState } from "@/components/elise/orb/orb-states";
import type { VoiceState } from "@/core/voice/session";
import type { Surface, WorkspaceState } from "@/core/workspace/model";
import { FileDropZone } from "@/features/chat/attachments-ui";
import { MessageThread, type ThreadHandlers } from "@/features/chat/message-thread";
import type { ChatMessage } from "@/features/chat/types";
import type { VoiceHandlers } from "@/features/voice/voice-controls";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { activityLabel, isPresentationTool } from "../activity-labels";
import {
  deviceFor,
  resolveComposition,
  temporalItems,
  type Composition,
  type Device,
  type Slot,
  type TemporalItem,
  type Zone,
} from "./composition";
import { Dock, type DockCaption } from "./dock";
import { EASE, ORB_MOVE } from "./motion";
import { GhostSlot, SkeletonSurface, SurfaceView, type CanvasHandlers } from "./surface-view";
import { TemporalView } from "./temporal-view";
import { TranscriptPanel } from "./transcript";

const TRANSCRIPT_KEY = "elise.canvas.transcript";

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
/** The viewport width, bucketed so the canvas only re-resolves when the device class changes. */
function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => Math.round(window.innerWidth / 16) * 16,
    () => 1440,
  );
}

function subscribeMinute(cb: () => void) {
  const id = window.setInterval(cb, 60_000);
  return () => window.clearInterval(id);
}
function useMinute(): number {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => 0,
  );
}

export interface LiveCanvasProps {
  workspace: WorkspaceState;
  messages: ChatMessage[];
  timezone: string;
  handlers: CanvasHandlers;
  threadHandlers: ThreadHandlers;
  running: boolean;
  /** The current turn's tool steps (activity row and skeletons). */
  activity: ClientToolTrace[];
  orbState: OrbState;
  level: { readonly current: number };
  voice: { state: VoiceState; handlers: VoiceHandlers } | null;
  caption: DockCaption;
  onSend: (text: string) => void;
  onStop: () => void;
  onArrange: (order: "time" | "relevance") => void;
  offline: boolean;
  failedDraft: { text: string; at: number } | null;
  /** Idle Home: greeting line and what sits under the headline (ambient, first prompts). */
  idle: { status: ReactNode; below: ReactNode; context: ReactNode };
  /** Above the dock: offline badge, transient confirmations, the active context. */
  notices: ReactNode;
  /** ELISE's latest words, for the centre of Spatial and the listening hero. */
  heroText: { who: "ELISE" | "YOU"; text: string } | null;
  /** "+ Nueva conversación" (desktop; phones have it in the header), when there is one to leave. */
  newChat?: ReactNode;
}

/**
 * The ELISE Live Canvas (ADR-021): one adaptive surface where voice or text becomes a visual
 * composition. The resolver picks the composition; this renders it. Surfaces keep their
 * identity (layoutId) across compositions, so focus and back are one continuous movement.
 */
export function LiveCanvas(props: LiveCanvasProps) {
  const { workspace, messages, timezone, handlers, running, activity } = props;
  const { t } = useI18n();
  const reduced = Boolean(useReducedMotion());
  const width = useViewportWidth();
  const now = useMinute();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  useEffect(() => {
    try {
      // A remembered preference, restored after mount (SSR renders it closed).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (window.localStorage.getItem(TRANSCRIPT_KEY) === "open") setTranscriptOpen(true);
    } catch {
      // Storage unavailable: the transcript starts closed.
    }
  }, []);
  const toggleTranscript = useCallback(() => {
    setTranscriptOpen((open) => {
      try {
        window.localStorage.setItem(TRANSCRIPT_KEY, open ? "closed" : "open");
      } catch {
        // Not remembered; still toggles.
      }
      return !open;
    });
  }, []);

  const steps = activity.filter(
    (s) => !isPresentationTool(s.name) && (s.parentId || !s.name.startsWith("meeting.")),
  );
  const runningSteps = running ? steps.filter((s) => !s.outcome) : [];
  const activeCount = runningSteps.length;
  const desktopDrawer = transcriptOpen && width >= 1280;
  const device: Device = deviceFor(desktopDrawer ? width - 400 : width);
  const mobile = device === "mobile";
  // The React Compiler memoizes these: they only change with the workspace or the screen.
  const composition = resolveComposition({
    state: workspace,
    device,
    hasMessages: messages.length > 0,
    running,
    activeSteps: activeCount,
    now: now || Date.parse(workspace.surfaces[0]?.updatedAt ?? "1970-01-01"),
  });
  const byId = new Map(workspace.surfaces.map((s) => [s.id, s]));
  const timelineScroll = useRef(0);
  const datedItems = temporalItems(
    workspace.surfaces.filter((s) => !s.transient),
    now || 0,
  );

  const kind = composition.kind;
  const canvasActive = kind !== "idle" && kind !== "conversation";
  const approval = composition.approvalId ? byId.get(composition.approvalId) : undefined;
  const transcriptAvailable = canvasActive && messages.length > 0;
  const showTranscript = transcriptOpen && transcriptAvailable;
  // Space is reserved only while the drawer is actually shown, not just remembered open.
  const drawerShown = desktopDrawer && transcriptAvailable;

  const shelf = composition.shelf.map((id) => byId.get(id)).filter((s): s is Surface => Boolean(s));
  const above = (
    <div className="flex w-full flex-col items-center gap-2">
      {props.notices}
      {runningSteps.length > 0 || (running && steps.length) ? (
        <ActivityRow steps={steps} />
      ) : shelf.length ? (
        <Shelf surfaces={shelf} onOpen={(s) => handlers.onFocus(s)} />
      ) : !running && steps.length > 1 && canvasActive ? (
        <p className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.06em] text-muted">
          <CheckIcon />
          {t.canvas.ready(steps.filter((s) => s.outcome?.status === "succeeded").length)}
        </p>
      ) : null}
    </div>
  );

  const idleInline = kind === "idle" && !mobile;
  const dockEl = (
    <Dock
      inline={idleInline}
      besideDrawer={drawerShown}
      orbState={props.orbState}
      level={props.level}
      showOrb={composition.orb === "dock" && !idleInline}
      controlsOnly={composition.orb === "center" && !mobile}
      caption={props.caption}
      mobile={mobile}
      voice={props.voice}
      busy={running}
      onSend={props.onSend}
      onStop={props.onStop}
      offline={props.offline}
      restore={props.failedDraft}
      transcript={
        transcriptAvailable
          ? { open: showTranscript, count: messages.length, onToggle: toggleTranscript }
          : null
      }
      above={above}
    />
  );

  const labelFor = (k: TemporalItem["kind"]) =>
    k === "recall"
      ? t.workspace.types.recall
      : k === "meeting" || k === "event"
        ? t.workspace.types.meeting
        : k === "email"
          ? t.workspace.types.email_thread
          : k === "task"
            ? t.workspace.types.task
            : k === "document"
              ? t.workspace.types.document
              : k === "news"
                ? t.workspace.types.web_news
                : t.workspace.types.timeline;

  return (
    <div
      className={cn(
        "relative flex min-h-[calc(100dvh-5rem)] flex-1 flex-col",
        drawerShown && "pr-[400px]",
      )}
    >
      <div
        aria-hidden
        className={cn(
          "elise-halo pointer-events-none fixed inset-0 -z-10",
          canvasActive && "opacity-60",
        )}
      />
      {(kind === "gathering" || (running && canvasActive && kind !== "focus")) && (
        <div aria-hidden className="canvas-dots pointer-events-none fixed inset-0 -z-10" />
      )}

      <LayoutGroup id="canvas">
        <section
          aria-label={t.canvas.label}
          // Behind a decision, the canvas stays visible but can't be used until it's decided.
          inert={approval ? true : undefined}
          className={cn(
            "flex flex-1 flex-col",
            mobile ? "px-4 pt-3 pb-44" : "px-6 pt-2 pb-48 lg:px-10",
          )}
        >
          {canvasActive && (
            <Trail
              composition={composition}
              workspace={workspace}
              surface={composition.primaryId ? byId.get(composition.primaryId) : undefined}
              canArrange={datedItems.length >= 3 && !mobile}
              onBack={handlers.onUnfocus}
              onArrange={props.onArrange}
              extra={mobile ? null : props.newChat}
            />
          )}
          {kind === "idle" && (
            <IdleHero
              orbState={props.orbState}
              level={props.level}
              mobile={mobile}
              status={props.idle.status}
              below={props.idle.below}
              context={props.idle.context}
              dock={idleInline ? dockEl : null}
              hearing={props.heroText?.who === "YOU" ? props.heroText.text : null}
              voice={props.voice}
            />
          )}
          {kind === "conversation" && props.newChat && !mobile && (
            <div className="mb-2 flex justify-end">{props.newChat}</div>
          )}
          {kind === "conversation" && (
            <MessageThread
              messages={messages}
              timezone={timezone}
              handlers={props.threadHandlers}
            />
          )}
          {canvasActive && (
            <Zones
              composition={composition}
              byId={byId}
              device={device}
              timezone={timezone}
              handlers={handlers}
              skeletons={runningSteps.slice(0, 3).map((s) => activityLabel(t, s.name, true))}
              orbState={props.orbState}
              level={props.level}
              heroText={props.heroText}
              timelineScroll={timelineScroll}
              labelFor={labelFor}
              reduced={reduced}
            />
          )}
        </section>

        {!idleInline && dockEl}
      </LayoutGroup>

      <AnimatePresence>
        {approval && (
          <ApprovalOverlay
            key={approval.id}
            surface={approval}
            timezone={timezone}
            handlers={handlers}
            mobile={mobile}
          />
        )}
      </AnimatePresence>

      {/* Desktop and tablets: files dropped anywhere join the draft (ADR-031). */}
      <FileDropZone />

      <TranscriptPanel
        open={showTranscript}
        onClose={toggleTranscript}
        messages={messages}
        timezone={timezone}
        handlers={props.threadHandlers}
        mobile={width < 1280}
      />
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function IdleHero({
  orbState,
  level,
  mobile,
  status,
  below,
  context,
  hearing,
  voice,
  dock,
}: {
  dock: ReactNode;
  orbState: OrbState;
  level: { readonly current: number };
  mobile: boolean;
  status: ReactNode;
  below: ReactNode;
  context: ReactNode;
  hearing: string | null;
  voice: { state: VoiceState; handlers: VoiceHandlers } | null;
}) {
  const { t } = useI18n();
  const size = mobile ? 260 : 380;
  const phase = voice?.state.phase ?? "idle";
  const orb = <Orb state={orbState} size={size} levelSource={level} />;
  return (
    <div className="flex flex-col items-center pt-6 md:pt-2">
      <motion.div
        layoutId={ORB_LAYOUT_ID}
        transition={ORB_MOVE}
        style={{ width: size, height: size }}
      >
        {voice ? (
          // The Orb is ELISE's voice presence: tap it to talk.
          <button
            type="button"
            onClick={
              phase === "idle" || phase === "sleeping"
                ? voice.handlers.start
                : phase === "listening" || phase === "user_speaking"
                  ? voice.handlers.finishNow
                  : voice.handlers.interrupt
            }
            aria-label={phase === "idle" ? t.voice.start : t.voice.finish}
            className="block rounded-full"
          >
            {orb}
          </button>
        ) : (
          orb
        )}
      </motion.div>
      {hearing ? (
        <div
          aria-live="polite"
          className="-mt-4 flex max-w-[900px] flex-col items-center gap-3 px-4 text-center"
        >
          <span className="font-mono text-[11px] tracking-[0.16em] text-fg2 uppercase">
            {t.canvas.you}
          </span>
          <p className="text-[24px] leading-[1.3] font-light tracking-[-0.02em] text-balance md:text-[34px]">
            {hearing}
          </p>
          <span className="text-[12.5px] text-faint">{t.canvas.listeningHint}</span>
        </div>
      ) : (
        <>
          <div className={cn(mobile ? "-mt-3" : "-mt-6")}>{status}</div>
          <h1 className="mt-3 text-center text-[28px] leading-[1.1] font-light tracking-[-0.025em] md:text-[46px]">
            {t.canvas.headline}
          </h1>
          {dock}
          {context}
          {below}
        </>
      )}
    </div>
  );
}

/** Where the work is: composition, the lead, Back from Focus, and the time-order switch. */
function Trail({
  composition,
  workspace,
  surface,
  canArrange,
  onBack,
  onArrange,
  extra,
}: {
  composition: Composition;
  workspace: WorkspaceState;
  surface: Surface | undefined;
  canArrange: boolean;
  extra?: ReactNode;
  onBack: () => void;
  onArrange: (order: "time" | "relevance") => void;
}) {
  const { t } = useI18n();
  const kind = composition.kind;
  const focused = kind === "focus" || kind === "comparison";
  const intent = workspace.intent;
  const crumbs = [
    intent && intent.kind !== "general" ? t.workspace.intents[intent.kind] : null,
    intent?.description &&
    intent.kind !== "general" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(intent.description)
      ? intent.description
      : null,
    focused ? surface?.title || (surface ? t.workspace.types[surface.type] : null) : null,
  ].filter((c): c is string => Boolean(c));
  const timeOrder = intent?.arrangement === "time";
  return (
    <nav
      aria-label={t.canvas.label}
      className="mb-4 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2"
    >
      {focused && (
        <button
          type="button"
          onClick={onBack}
          className="flex h-[30px] items-center gap-1.5 rounded-full border border-border-strong bg-glass pr-3 pl-2 text-[12.5px] text-fg2 hover:text-fg"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {t.canvas.back}
        </button>
      )}
      <ol className="flex min-w-0 items-center gap-2 font-mono text-[11px] tracking-[0.08em]">
        {crumbs.map((c, i) => (
          <li
            key={i}
            className={cn(
              "flex min-w-0 items-center gap-2",
              i === crumbs.length - 1 ? "text-fg" : "text-muted",
            )}
          >
            {i > 0 && (
              <span aria-hidden className="text-faint">
                /
              </span>
            )}
            <span className="max-w-[48ch] truncate" title={c}>
              {c}
            </span>
          </li>
        ))}
      </ol>
      {kind !== "gathering" && (
        <span className="flex h-[22px] items-center rounded-md bg-accent-soft px-2 font-mono text-[10px] tracking-[0.14em] text-accent-text uppercase">
          {t.canvas.compositions[kind as keyof typeof t.canvas.compositions]}
        </span>
      )}
      <span className="flex-1" />
      {(canArrange || timeOrder) && !focused && (
        <button
          type="button"
          onClick={() => onArrange(timeOrder ? "relevance" : "time")}
          className="flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] text-fg2 hover:border-accent-line hover:text-fg"
        >
          {timeOrder ? (
            <LayoutGrid className="size-3.5" aria-hidden />
          ) : (
            <Clock className="size-3.5" aria-hidden />
          )}
          {timeOrder ? t.canvas.arrangeRelevance : t.canvas.arrangeTime}
        </button>
      )}
      {extra}
    </nav>
  );
}

function ActivityRow({ steps }: { steps: ClientToolTrace[] }) {
  const { t } = useI18n();
  return (
    <ul
      role="status"
      aria-live="polite"
      aria-label={t.canvas.label}
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-2 font-mono text-[11px] tracking-[0.06em]"
    >
      {steps.slice(0, 8).map((s) => {
        const status = !s.outcome ? "running" : s.outcome.status === "failed" ? "failed" : "done";
        return (
          <li
            key={s.callId}
            className={cn(
              "flex items-center gap-1.5",
              status === "running"
                ? "text-fg"
                : status === "failed"
                  ? "text-danger-text"
                  : "text-muted",
            )}
          >
            {status === "done" && <CheckIcon />}
            {status === "failed" && <AlertIcon />}
            {status === "running" && (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
              />
            )}
            {status === "failed"
              ? t.chat.activity.unavailable(activityLabel(t, s.name, false))
              : activityLabel(t, s.name, status === "running")}
          </li>
        );
      })}
    </ul>
  );
}

/** Surfaces with no room on this screen: one chip each, in priority order. */
function Shelf({ surfaces, onOpen }: { surfaces: Surface[]; onOpen: (s: Surface) => void }) {
  const { t } = useI18n();
  const shown = surfaces.slice(0, 4);
  return (
    <ul
      aria-label={t.canvas.shelf}
      className="flex w-max max-w-full [scrollbar-width:none] items-center gap-1.5 overflow-x-auto px-2"
    >
      {shown.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => onOpen(s)}
            className="flex h-8 max-w-[220px] items-center gap-1.5 rounded-full border border-border bg-glass px-3 text-[12.5px] whitespace-nowrap text-fg2 backdrop-blur hover:border-accent-line"
          >
            <span className="truncate">{s.title || t.workspace.types[s.type]}</span>
          </button>
        </li>
      ))}
      {surfaces.length > shown.length && (
        <li className="px-1 font-mono text-[11px] text-faint">
          {t.canvas.more(surfaces.length - shown.length)}
        </li>
      )}
    </ul>
  );
}

function Zones({
  composition,
  byId,
  device,
  timezone,
  handlers,
  skeletons,
  orbState,
  level,
  heroText,
  timelineScroll,
  labelFor,
  reduced,
}: {
  composition: Composition;
  byId: Map<string, Surface>;
  device: Device;
  timezone: string;
  handlers: CanvasHandlers;
  skeletons: string[];
  orbState: OrbState;
  level: { readonly current: number };
  heroText: { who: "ELISE" | "YOU"; text: string } | null;
  timelineScroll: { current: number };
  labelFor: (k: TemporalItem["kind"]) => string;
  reduced: boolean;
}) {
  const { t } = useI18n();
  const mobile = device === "mobile";
  const kind = composition.kind;
  const zone = (z: Zone) => composition.slots.filter((s) => s.zone === z);
  const render = (slots: Slot[], className?: string) => (
    <AnimatePresence initial={false} mode="popLayout">
      {slots.map((s) => {
        const surface = byId.get(s.id);
        return surface ? (
          <SurfaceView
            key={s.id}
            surface={surface}
            size={s.size}
            tier={s.tier}
            focused={s.zone === "focus" || s.zone === "compare"}
            timezone={timezone}
            handlers={handlers}
            className={className}
          />
        ) : null;
      })}
    </AnimatePresence>
  );
  const skeletonEls = skeletons.map((label) => <SkeletonSurface key={label} label={label} />);

  if (kind === "gathering")
    return (
      <div className="grid gap-6 md:grid-cols-[minmax(0,700fr)_minmax(0,380fr)]">
        <div className="flex flex-col gap-6">{skeletonEls.slice(0, 1)}</div>
        <div className="flex flex-col gap-6">{skeletonEls.slice(1)}</div>
      </div>
    );

  if (kind === "temporal")
    return (
      <div
        className={cn(
          "grid gap-6",
          !mobile && zone("railRight").length && "lg:grid-cols-[minmax(0,1fr)_200px]",
        )}
      >
        <TemporalView
          items={composition.timeline}
          timezone={timezone}
          vertical={mobile}
          scroll={timelineScroll}
          labelFor={labelFor}
          onOpen={(it) => {
            const s = byId.get(it.surfaceId);
            if (s) handlers.onFocus(s, it.item);
          }}
        />
        {zone("railRight").length > 0 && (
          <div className="flex flex-col gap-4">{render(zone("railRight"))}</div>
        )}
      </div>
    );

  if (kind === "focus" || kind === "comparison") {
    const left = zone("railLeft");
    const right = zone("railRight");
    const center =
      kind === "comparison" ? (
        <div className="grid min-w-0 gap-6 md:grid-cols-2">{render(zone("compare"))}</div>
      ) : (
        <div className="min-w-0">{render(zone("focus"))}</div>
      );
    if (mobile) return center;
    return (
      <div
        className={cn(
          "grid items-start gap-6",
          device === "tablet"
            ? "grid-cols-[minmax(0,1fr)_200px]"
            : "grid-cols-[200px_minmax(0,1fr)_200px]",
        )}
      >
        {device !== "tablet" && (
          <div className="flex flex-col gap-4">
            <GhostSlot label={t.canvas.returnsHere} />
            {render(left)}
          </div>
        )}
        <div className="mx-auto w-full max-w-[1100px] min-w-0">{center}</div>
        <div className="flex flex-col gap-4">{render(right)}</div>
      </div>
    );
  }

  if (kind === "spatial") {
    if (mobile)
      return (
        <div className="flex flex-col gap-4">
          <SpatialPresence orbState={orbState} level={level} size={120} heroText={heroText} />
          <div className="-mx-4 flex snap-x snap-mandatory [scrollbar-width:none] gap-3 overflow-x-auto px-4 pb-1">
            {render(zone("carousel"), "w-[86%] shrink-0 snap-start")}
          </div>
          <div className="flex flex-col gap-2">{render(zone("list"))}</div>
        </div>
      );
    return (
      <div className="grid grid-cols-[minmax(0,390fr)_minmax(0,540fr)_minmax(0,390fr)] items-start gap-6">
        <div className="flex flex-col gap-5">{render(zone("left"))}</div>
        <div className="flex flex-col items-center gap-6 pt-6">
          <SpatialPresence orbState={orbState} level={level} size={240} heroText={heroText} />
          <div className="w-full max-w-[420px]">{render(zone("bottom"))}</div>
          {skeletonEls}
        </div>
        <div className="flex flex-col gap-5">{render(zone("right"))}</div>
      </div>
    );
  }

  if (kind === "simple") {
    const two = composition.slots.length > 1 && !mobile;
    return (
      <div
        className={cn(
          "mx-auto grid w-full items-start gap-6",
          // An explicit 0-min track: a long, truncated header must not widen the column.
          two
            ? "max-w-[1180px] grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
            : "max-w-[820px] grid-cols-[minmax(0,1fr)]",
        )}
      >
        <div className="flex flex-col gap-6">{render(zone("main"))}</div>
        {(two || mobile || skeletons.length > 0) && (
          <div className="flex flex-col gap-6">
            {render([...zone("side"), ...zone("stack")])}
            {skeletonEls}
          </div>
        )}
      </div>
    );
  }

  // Brief.
  if (mobile)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {render(zone("main"))}
        {render(zone("stack"))}
        {skeletonEls}
      </div>
    );
  const rail = zone("rail");
  const cols =
    device === "tablet"
      ? "grid-cols-[minmax(0,640fr)_minmax(0,468fr)]"
      : rail.length
        ? "grid-cols-[minmax(0,700fr)_minmax(0,380fr)_minmax(0,236fr)]"
        : "grid-cols-[minmax(0,3fr)_minmax(0,2fr)]";
  return (
    <motion.div
      layout={!reduced}
      transition={{ duration: 0.42, ease: EASE }}
      className={cn("grid items-start gap-6", cols)}
    >
      <div className="flex flex-col gap-6">{render(zone("main"))}</div>
      <div className="flex flex-col gap-5">
        {render(zone("side"))}
        {skeletonEls}
      </div>
      {rail.length > 0 && device !== "tablet" && (
        <div className="flex flex-col gap-5">{render(rail)}</div>
      )}
    </motion.div>
  );
}

/** ELISE at the centre of Spatial, with what she is saying. */
function SpatialPresence({
  orbState,
  level,
  size,
  heroText,
}: {
  orbState: OrbState;
  level: { readonly current: number };
  size: number;
  heroText: { who: "ELISE" | "YOU"; text: string } | null;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <motion.div
        layoutId={ORB_LAYOUT_ID}
        transition={ORB_MOVE}
        style={{ width: size, height: size }}
      >
        <Orb state={orbState} size={size} levelSource={level} />
      </motion.div>
      {heroText && (
        <div aria-live="polite" className="flex max-w-[540px] flex-col items-center gap-2 px-2">
          <span
            className={cn(
              "font-mono text-[11px] tracking-[0.16em] uppercase",
              heroText.who === "YOU" ? "text-fg2" : "text-accent-text",
            )}
          >
            {heroText.who === "YOU" ? t.canvas.you : "ELISE"}
          </span>
          <p
            className={cn(
              "leading-[1.4] font-light tracking-[-0.01em] text-balance",
              size > 200 ? "text-[17px]" : "text-[15px]",
            )}
          >
            {heroText.text}
          </p>
        </div>
      )}
    </div>
  );
}

/** A pending approval: first, centred, with the workspace still visible (and inert) behind. */
function ApprovalOverlay({
  surface,
  timezone,
  handlers,
  mobile,
}: {
  surface: Surface;
  timezone: string;
  handlers: CanvasHandlers;
  mobile: boolean;
}) {
  const { t } = useI18n();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[25] flex items-center justify-center overflow-y-auto bg-[var(--scrim)] px-4 pt-24 pb-44"
    >
      <section
        aria-label={t.canvas.approvalFirst}
        className={cn("w-full", mobile ? "max-w-full" : "max-w-[640px]")}
      >
        <SurfaceView
          surface={surface}
          size={mobile ? "medium" : "large"}
          tier="primary"
          timezone={timezone}
          handlers={handlers}
        />
      </section>
    </motion.div>
  );
}
