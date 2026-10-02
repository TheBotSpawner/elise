"use client";

import {
  CalendarDays,
  FileText,
  Globe,
  GraduationCap,
  History,
  Landmark,
  ListChecks,
  Mail,
  MapPin,
  Maximize2,
  Pin,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";

import type { SurfaceDetail } from "@/application/workspace-service";
import type { Surface } from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { DisplayCard } from "@/features/chat/result-cards";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  SELF_FRAMED,
  SURFACE_ICONS,
  SurfaceActions,
  SurfaceBody,
  type SurfaceHandlers,
} from "../surfaces";
import type { Tier, VisualSize } from "./composition";
import { surfaceMotion } from "./motion";

const PROVENANCE: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  email: Mail,
  web_search: Globe,
  location: MapPin,
  knowledge: FileText,
  history: History,
  tasks: ListChecks,
  finance: Landmark,
  study: GraduationCap,
};

export interface CanvasHandlers extends SurfaceHandlers {
  onFocus: (surface: Surface, item?: string | null) => void;
  onUnfocus: () => void;
  onPin: (surface: Surface, pinned: boolean) => void;
  onDismiss: (surface: Surface) => void;
  loadDetail: (surface: Surface, itemId: string | null) => Promise<SurfaceDetail | null>;
}

const PAD: Record<VisualSize, string> = {
  micro: "px-3.5 py-2.5",
  small: "px-3.5 py-3",
  medium: "px-[18px] py-4",
  large: "px-[22px] py-5",
  focus: "px-5 py-5 md:px-7 md:py-6",
};

/** Clicks on the card itself (not on a control inside it) open the Surface. */
const fromControl = (e: MouseEvent) =>
  Boolean(
    (e.target as HTMLElement).closest(
      "a,button,input,label,textarea,select,summary,[role=checkbox],iframe",
    ),
  );

/**
 * One Surface, at the size and tier the composition gave it. The shell is shared: eyebrow,
 * tags, actions and provenance look the same for every type; only the body differs. The same
 * element moves between zones (layoutId), so Spatial → Focus → back is one continuous object.
 */
export const SurfaceView = memo(function SurfaceView({
  surface,
  size,
  tier,
  focused = false,
  timezone,
  handlers,
  className,
}: {
  surface: Surface;
  size: VisualSize;
  tier: Tier;
  focused?: boolean;
  timezone: string;
  handlers: CanvasHandlers;
  className?: string;
}) {
  const { t } = useI18n();
  const reduced = Boolean(useReducedMotion());
  const Icon = SURFACE_ICONS[surface.type];
  const typeLabel = t.workspace.types[surface.type];
  const name = surface.title || typeLabel;
  const motionProps = surfaceMotion(reduced);
  const attention = surface.state === "attention";
  const isNew = tier === "arriving";

  if (size === "micro")
    return (
      <motion.article
        layoutId={surface.id}
        layout={reduced ? false : "position"}
        {...motionProps}
        aria-label={`${typeLabel}: ${name}`}
        data-tier={tier}
        data-size="micro"
        className={cn("sf group relative flex min-w-0 rounded-[14px]", className)}
      >
        <button
          type="button"
          onClick={() => handlers.onFocus(surface)}
          className="flex min-w-0 flex-1 flex-col gap-1 rounded-[14px] px-3.5 py-2.5 text-left"
        >
          <span className="flex items-center gap-1.5 truncate type-eyebrow text-faint">
            <Icon className="size-3 shrink-0" aria-hidden />
            {surface.pinned ? `${typeLabel} · ${t.canvas.pinned}` : typeLabel}
          </span>
          <span className="line-clamp-2 text-[13.5px] leading-[1.35] font-medium">{name}</span>
        </button>
      </motion.article>
    );

  // An approval is already a complete card (what, why, decide): no second frame around it.
  if (surface.type === "approval")
    return (
      <motion.article
        layoutId={surface.id}
        layout={reduced ? false : "position"}
        {...motionProps}
        aria-label={`${typeLabel}: ${name}`}
        data-tier={tier}
        className={cn(
          "relative min-w-0 rounded-2xl bg-[var(--overlay-bg)]",
          tier === "dim" && "opacity-30",
          className,
        )}
      >
        <SurfaceBody
          surface={surface}
          timezone={timezone}
          handlers={handlers}
          large={size !== "small"}
          size={size}
        />
      </motion.article>
    );

  const framed = !SELF_FRAMED.has(surface.type);
  const source = surface.source?.label;
  const Prov = PROVENANCE[surface.source?.capability ?? ""] ?? Sparkles;
  const confidence =
    surface.type === "visualization"
      ? (surface.payload as SurfacePayloads["visualization"]).spec.confidence
      : undefined;
  return (
    <motion.article
      layoutId={surface.id}
      layout={reduced ? false : "position"}
      {...motionProps}
      aria-label={`${typeLabel}: ${name}`}
      data-tier={tier}
      data-size={size}
      onClick={(e) => {
        if (!focused && !fromControl(e)) handlers.onFocus(surface);
      }}
      className={cn(
        "sf group relative flex min-w-0 flex-col gap-3 overflow-hidden",
        focused && size === "focus" && "min-h-[min(640px,calc(100dvh-300px))]",
        size === "small" ? "rounded-[14px]" : "rounded-[18px]",
        !focused && "cursor-pointer",
        PAD[size],
        className,
      )}
    >
      {isNew && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--accent),transparent)]"
        />
      )}
      <header className="flex min-h-5 items-center gap-2">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 truncate type-eyebrow",
            attention ? "text-approval-text" : "text-faint",
          )}
        >
          <Icon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {/* A chart is named by what it shows ("Cumulative spend"), not by "Chart". */}
            {surface.type === "visualization" && surface.title ? surface.title : typeLabel}
            {source && size !== "small" ? ` · ${source}` : ""}
          </span>
        </span>
        <span className="flex-1" />
        {(isNew || surface.pinned || (surface.state !== "ready" && !attention)) &&
          size !== "small" && (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 type-eyebrow text-[10px]",
                surface.state === "error" ? "text-danger-text" : "text-accent-text",
              )}
            >
              <span aria-hidden className="size-[5px] rounded-full bg-current" />
              {surface.pinned
                ? t.canvas.pinned
                : isNew
                  ? t.canvas.new
                  : t.workspace.states[surface.state]}
            </span>
          )}
        {!surface.transient && (
          <span
            className={cn(
              "-mr-2 flex shrink-0 items-center",
              // Glanceable cards stay quiet: their controls appear on hover or keyboard focus.
              size === "small" &&
                "opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            {size === "small" && surface.pinned && (
              <span className="sr-only">{t.canvas.pinned}</span>
            )}
            <IconButton
              label={`${surface.pinned ? t.canvas.unpin : t.canvas.pin}: ${name}`}
              pressed={Boolean(surface.pinned)}
              onClick={() => handlers.onPin(surface, !surface.pinned)}
            >
              <Pin
                className={cn("size-3.5", surface.pinned && "fill-current text-accent-text")}
                aria-hidden
              />
            </IconButton>
            {!focused && size !== "small" && (
              <IconButton
                label={`${t.canvas.open}: ${name}`}
                onClick={() => handlers.onFocus(surface)}
              >
                <Maximize2 className="size-3.5" aria-hidden />
              </IconButton>
            )}
            {!attention && (
              <IconButton
                label={`${t.workspace.dismiss}: ${name}`}
                onClick={() => handlers.onDismiss(surface)}
              >
                <X className="size-3.5" aria-hidden />
              </IconButton>
            )}
          </span>
        )}
      </header>
      <div className={cn("flex min-h-0 flex-col gap-3", !framed && "[&_.result-card]:border-0")}>
        <SurfaceBody
          surface={surface}
          timezone={timezone}
          handlers={handlers}
          large={size === "large" || size === "focus"}
          size={size}
        />
        {focused && <FocusDetail surface={surface} timezone={timezone} handlers={handlers} />}
      </div>
      {size !== "small" && <SurfaceActions surface={surface} handlers={handlers} />}
      {(source || confidence) && size !== "small" && (
        <footer className="mt-auto flex items-center gap-2 pt-1 text-[11.5px] text-faint">
          <Prov className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{source ?? surface.source?.capability}</span>
          <span className="flex-1" />
          {confidence && <Confidence level={confidence} />}
        </footer>
      )}
    </motion.article>
  );
});

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-active hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Confidence by shape, never colour alone: filled, outlined, dashed, dotted, sparse. */
export function Confidence({
  level,
}: {
  level: "confirmed" | "likely" | "uncertain" | "conflict" | "missing";
}) {
  const { t } = useI18n();
  const dash = {
    confirmed: undefined,
    likely: undefined,
    uncertain: "3 3",
    conflict: "1 3",
    missing: "1 5",
  }[level];
  const warn = level === "uncertain" || level === "conflict";
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1.5", warn ? "text-approval-text" : "text-fg2")}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r="8"
          fill={level === "confirmed" ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2.2"
          strokeDasharray={dash}
        />
      </svg>
      {t.canvas.confidence[level]}
    </span>
  );
}

/** Detail loaded only when a Surface is in focus (a thread, a conversation, a document). */
function FocusDetail({
  surface,
  timezone,
  handlers,
}: {
  surface: Surface;
  timezone: string;
  handlers: CanvasHandlers;
}) {
  const { t } = useI18n();
  const itemId = surface.focusItem ?? null;
  const wants =
    (surface.type === "email_list" && itemId) ||
    surface.type === "email_thread" ||
    surface.type === "recall" ||
    surface.type === "knowledge_source" ||
    surface.type === "document" ||
    surface.type === "web_source" ||
    (surface.type === "knowledge_result" && itemId);
  const [detail, setDetail] = useState<SurfaceDetail | null | "loading">(wants ? "loading" : null);
  const loader = useRef(handlers.loadDetail);
  useEffect(() => {
    loader.current = handlers.loadDetail;
  });
  useEffect(() => {
    if (!wants) return;
    let live = true;
    void loader.current(surface, itemId).then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
    // Reload only when the Surface or the item changes, not on every snapshot update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.id, itemId, wants]);
  if (detail === null) return null;
  if (detail === "loading")
    return <p className="animate-pulse text-[13px] text-faint">{t.workspace.loadingDetail}</p>;
  return <DetailView detail={detail} timezone={timezone} />;
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
        // Turn times arrive as the user's local wall-clock ("YYYY-MM-DDTHH:mm").
        timeZone: "UTC",
      });
      return detail.turns.length ? (
        <ol className="flex flex-col gap-3 border-l border-border pl-4">
          {detail.turns.map((turn, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <p className="flex items-baseline gap-2 type-label text-faint">
                <span className={turn.who === "ELISE" ? "text-accent-text" : "text-fg"}>
                  {turn.who === "ELISE" ? "ELISE" : t.workspace.you}
                </span>
                <span>{f.format(new Date(`${turn.at.slice(0, 16)}:00Z`))}</span>
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
        <div className="max-h-[56vh] overflow-y-auto rounded-[10px] border border-border bg-page p-5 text-[14.5px] leading-[1.65] whitespace-pre-wrap text-fg2 md:p-8">
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

/** A placeholder for a source still being read (reference "gathering"). */
export function SkeletonSurface({ label }: { label: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      {...surfaceMotion(Boolean(reduced))}
      aria-hidden
      className="sf-skeleton flex flex-col gap-2.5 rounded-[18px] px-[18px] py-4"
    >
      <span className="type-eyebrow text-faint">{label}</span>
      <span className="h-3 w-[70%] animate-pulse rounded bg-skel" />
      <span className="h-2.5 w-[92%] animate-pulse rounded bg-skel" />
      <span className="h-2.5 w-[58%] animate-pulse rounded bg-skel" />
    </motion.div>
  );
}

/** Where a focused Surface will return (reference ghost: "returns here"). */
export function GhostSlot({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      className="flex min-h-[72px] items-end rounded-2xl border border-dashed border-ghost p-3 font-mono text-[10px] tracking-[0.1em] text-faint uppercase"
    >
      {label}
    </div>
  );
}
