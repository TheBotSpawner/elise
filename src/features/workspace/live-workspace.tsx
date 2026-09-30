"use client";

import { ArrowLeft, Maximize2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type { ClientToolTrace } from "@/application/chat-protocol";
import type { SurfaceDetail } from "@/application/workspace-service";
import { AlertIcon, CheckIcon, RunningIcon } from "@/components/elise/icons";
import { Dialog } from "@/components/ui/dialog";
import { primarySurface, type Surface, type WorkspaceState } from "@/core/workspace/model";
import { DisplayCard } from "@/features/chat/result-cards";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { activityLabel, isPresentationTool } from "./activity-labels";
import {
  SELF_FRAMED,
  SURFACE_ICONS,
  SurfaceActions,
  SurfaceBody,
  type SurfaceHandlers,
} from "./surfaces";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface ExpandedRef {
  id: string;
  itemId: string | null;
}

/**
 * The Live Workspace (ADR-013): Surfaces ELISE assembled around the current intent. Generic —
 * it knows nothing about meetings; any orchestration that produces Surfaces renders here.
 * Sparse by design: one primary Surface, a few supporting ones, nothing to fill space.
 */
export function LiveWorkspace({
  state,
  timezone,
  handlers,
  activity,
  running,
  expanded,
  onCollapse,
  onDismiss,
  loadDetail,
  variant,
}: {
  state: WorkspaceState;
  timezone: string;
  handlers: SurfaceHandlers;
  /** The current turn's steps, for the compact activity line. */
  activity: ClientToolTrace[];
  running: boolean;
  expanded: ExpandedRef | null;
  onCollapse: () => void;
  onDismiss: (surface: Surface) => void;
  loadDetail: (surface: Surface, itemId: string | null) => Promise<SurfaceDetail | null>;
  variant: "pane" | "stack";
}) {
  const { t } = useI18n();
  const desktop = useIsDesktop();
  // Confirmations (settings changes) show by the composer, not here.
  const visible = { ...state, surfaces: state.surfaces.filter((s) => !s.transient) };
  const primary = primarySurface(visible);
  const supporting = visible.surfaces
    .filter((s) => s.id !== primary?.id)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const expandedSurface = expanded
    ? (state.surfaces.find((s) => s.id === expanded.id) ?? null)
    : null;
  // Expanded in place on wide screens and tablets; as a sheet on phones.
  const inPane = (variant === "pane" || desktop) && expandedSurface;

  if (!visible.surfaces.length && !running) return null;

  return (
    <section
      aria-label={t.workspace.label}
      className={cn("flex flex-col gap-4", variant === "pane" ? "pb-10" : "pt-2")}
    >
      <WorkspaceHeader state={state} activity={activity} running={running} />
      {inPane ? (
        <ExpandedSurface
          key={`${expandedSurface.id}:${expanded?.itemId ?? ""}`}
          surface={expandedSurface}
          itemId={expanded?.itemId ?? null}
          timezone={timezone}
          handlers={handlers}
          onClose={onCollapse}
          loadDetail={loadDetail}
        />
      ) : (
        <>
          <AnimatePresence initial={false} mode="popLayout">
            {primary && (
              <SurfaceCard
                key={primary.id}
                surface={primary}
                primary
                timezone={timezone}
                handlers={handlers}
                onDismiss={onDismiss}
              />
            )}
          </AnimatePresence>
          {supporting.length > 0 && (
            <div
              className={cn(
                variant === "pane"
                  ? "grid grid-cols-1 items-start gap-4 2xl:grid-cols-2"
                  : "-mx-4 flex snap-x snap-mandatory [scrollbar-width:none] gap-3 overflow-x-auto px-4 pb-2",
              )}
            >
              <AnimatePresence initial={false} mode="popLayout">
                {supporting.map((s) => (
                  <SurfaceCard
                    key={s.id}
                    surface={s}
                    timezone={timezone}
                    handlers={handlers}
                    onDismiss={onDismiss}
                    className={variant === "stack" ? "w-[86%] shrink-0 snap-start" : undefined}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </>
      )}
      {variant === "stack" && !desktop && (
        <Dialog
          open={Boolean(expandedSurface)}
          onClose={onCollapse}
          title={expandedSurface ? t.workspace.types[expandedSurface.type] : ""}
          description={expandedSurface?.title}
        >
          {expandedSurface && (
            <ExpandedContent
              surface={expandedSurface}
              itemId={expanded?.itemId ?? null}
              timezone={timezone}
              handlers={handlers}
              loadDetail={loadDetail}
            />
          )}
        </Dialog>
      )}
    </section>
  );
}

function WorkspaceHeader({
  state,
  activity,
  running,
}: {
  state: WorkspaceState;
  activity: ClientToolTrace[];
  running: boolean;
}) {
  const { t } = useI18n();
  const steps = activity.filter(
    (s) => !isPresentationTool(s.name) && (s.parentId || !s.name.startsWith("meeting.")),
  );
  const failed = steps.filter((s) => s.outcome?.status === "failed").length;
  return (
    <header className="flex flex-col gap-2">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 type-label text-accent-text">
          {state.intent ? t.workspace.intents[state.intent.kind] : t.workspace.label}
        </span>
        {state.intent && state.intent.kind !== "general" && (
          <span className="truncate text-[13px] text-muted">{state.intent.description}</span>
        )}
      </p>
      {steps.length > 0 && (running || failed > 0) && (
        <ul aria-live="polite" className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
          {steps.map((s) => {
            const status = !s.outcome
              ? "running"
              : s.outcome.status === "failed"
                ? "failed"
                : "done";
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
                <span className="flex size-3.5 items-center" aria-hidden>
                  {status === "done" && <CheckIcon />}
                  {status === "failed" && <AlertIcon />}
                  {status === "running" && (
                    <motion.span
                      className="flex text-accent"
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
                    >
                      <RunningIcon />
                    </motion.span>
                  )}
                </span>
                {status === "failed"
                  ? t.chat.activity.unavailable(activityLabel(t, s.name, false))
                  : activityLabel(t, s.name, status === "running")}
              </li>
            );
          })}
        </ul>
      )}
    </header>
  );
}

export function SurfaceCard({
  surface,
  primary = false,
  timezone,
  handlers,
  onDismiss,
  className,
}: {
  surface: Surface;
  primary?: boolean;
  timezone: string;
  handlers: SurfaceHandlers;
  onDismiss: (surface: Surface) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const Icon = SURFACE_ICONS[surface.type];
  const expandable = surface.actions.some((a) => a.kind === "expand");
  const attention = surface.state === "attention";
  const framed = !SELF_FRAMED.has(surface.type);
  const stateLabel = t.workspace.states[surface.state];
  return (
    <motion.article
      layout={reduced ? false : "position"}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985, transition: { duration: 0.16 } }}
      transition={{ duration: 0.28, ease: EASE }}
      aria-label={`${t.workspace.types[surface.type]}${surface.title ? `: ${surface.title}` : ""}`}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border bg-surface px-4 py-3.5 md:px-5 md:py-4",
        attention ? "border-approval-line" : primary ? "border-border-strong" : "border-border",
        surface.transient && "py-3",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn("size-3.5 shrink-0", attention ? "text-approval" : "text-faint")}
          aria-hidden
        />
        <span className={cn("type-label", attention ? "text-approval-text" : "text-faint")}>
          {t.workspace.types[surface.type]}
        </span>
        {surface.source?.label && (
          <span className="min-w-0 truncate text-[12px] text-faint">· {surface.source.label}</span>
        )}
        {stateLabel && surface.state !== "attention" && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11.5px]",
              surface.state === "error"
                ? "bg-surface-2 text-danger-text"
                : "bg-surface-2 text-muted",
            )}
          >
            {stateLabel}
          </span>
        )}
        <span className="ml-auto flex items-center">
          {expandable && (
            <button
              type="button"
              onClick={() => handlers.onExpand(surface, null)}
              aria-label={`${t.workspace.actions.expand}: ${surface.title || t.workspace.types[surface.type]}`}
              className="grid size-8 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg"
            >
              <Maximize2 className="size-3.5" aria-hidden />
            </button>
          )}
          {!attention && (
            <button
              type="button"
              onClick={() => onDismiss(surface)}
              aria-label={`${t.workspace.dismiss}: ${surface.title || t.workspace.types[surface.type]}`}
              className="grid size-8 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </span>
      </div>
      <div
        className={cn(
          !framed &&
            "-mx-4 -mb-3.5 md:-mx-5 md:-mb-4 [&>*]:rounded-t-none [&>*]:border-0 [&>*]:bg-transparent",
        )}
      >
        <SurfaceBody surface={surface} timezone={timezone} handlers={handlers} large={primary} />
      </div>
      <SurfaceActions surface={surface} handlers={handlers} />
    </motion.article>
  );
}

function ExpandedSurface({
  surface,
  itemId,
  timezone,
  handlers,
  onClose,
  loadDetail,
}: {
  surface: Surface;
  itemId: string | null;
  timezone: string;
  handlers: SurfaceHandlers;
  onClose: () => void;
  loadDetail: (surface: Surface, itemId: string | null) => Promise<SurfaceDetail | null>;
}) {
  const { t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE }}
      aria-labelledby={`${surface.id}-expanded`}
      className="flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface px-5 py-4 md:px-6 md:py-5"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-full px-2 text-[13px] text-muted hover:bg-active hover:text-fg"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {t.workspace.back}
        </button>
      </div>
      <h2
        id={`${surface.id}-expanded`}
        ref={heading}
        tabIndex={-1}
        className="flex flex-col gap-1 outline-none"
      >
        <span className="type-label text-faint">{t.workspace.types[surface.type]}</span>
        {surface.title && (
          <span className="text-xl font-light tracking-[-0.02em]">{surface.title}</span>
        )}
      </h2>
      <ExpandedContent
        surface={surface}
        itemId={itemId}
        timezone={timezone}
        handlers={handlers}
        loadDetail={loadDetail}
      />
    </motion.section>
  );
}

/** The Surface at full size, plus detail loaded only now (thread, conversation, document). */
function ExpandedContent({
  surface,
  itemId,
  timezone,
  handlers,
  loadDetail,
}: {
  surface: Surface;
  itemId: string | null;
  timezone: string;
  handlers: SurfaceHandlers;
  loadDetail: (surface: Surface, itemId: string | null) => Promise<SurfaceDetail | null>;
}) {
  const { t } = useI18n();
  const wantsDetail =
    (surface.type === "email_list" && itemId) ||
    surface.type === "email_thread" ||
    surface.type === "recall" ||
    surface.type === "knowledge_source" ||
    surface.type === "document" ||
    (surface.type === "knowledge_result" && itemId);
  const [detail, setDetail] = useState<SurfaceDetail | null | "loading">(
    wantsDetail ? "loading" : null,
  );
  const loader = useRef(loadDetail);
  useEffect(() => {
    loader.current = loadDetail;
  });
  useEffect(() => {
    if (!wantsDetail) return;
    let live = true;
    void loader.current(surface, itemId).then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [surface, itemId, wantsDetail]);

  return (
    <div className="flex flex-col gap-4">
      {!(surface.type === "email_list" && itemId) &&
        !(surface.type === "knowledge_result" && itemId) && (
          <SurfaceBody surface={surface} timezone={timezone} handlers={handlers} large />
        )}
      {detail === "loading" && (
        <p className="animate-pulse text-[13px] text-faint">{t.workspace.loadingDetail}</p>
      )}
      {detail && detail !== "loading" && <DetailView detail={detail} timezone={timezone} />}
      <SurfaceActions surface={surface} handlers={handlers} />
    </div>
  );
}

function DetailView({ detail, timezone }: { detail: SurfaceDetail; timezone: string }) {
  const { t, locale } = useI18n();
  switch (detail.kind) {
    case "display":
      return <DisplayCard display={detail.display} timezone={timezone} />;
    case "turns": {
      const f = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      });
      return detail.turns.length ? (
        <ol className="flex flex-col gap-3 border-l border-border pl-4">
          {detail.turns.map((turn, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <p className="flex items-baseline gap-2 type-label text-faint">
                <span className={turn.who === "ELISE" ? "text-accent-text" : "text-fg"}>
                  {turn.who === "ELISE" ? "ELISE" : "—"}
                </span>
                <span>{f.format(new Date(turn.at))}</span>
              </p>
              <p className="text-[14px] leading-[1.6] whitespace-pre-wrap">{turn.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[13px] text-faint">{t.workspace.noDetail}</p>
      );
    }
    case "text":
      return (
        <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-border bg-bg p-4 text-[14px] leading-[1.65] whitespace-pre-wrap">
          {detail.text}
        </div>
      );
    case "error":
      return (
        <p role="alert" className="text-[13.5px] text-danger-text">
          {t.errors.codes[detail.error.code]}
        </p>
      );
  }
}
