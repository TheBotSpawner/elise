"use client";

import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  Eye,
  PauseCircle,
  Repeat,
  TrendingUp,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import type { GoalCard, HealthState } from "@/core/goals/analytics";
import { dayLabel, durationLabel, rangeLabel } from "@/core/goals/periods";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { IconTile } from "./native-ui";

/**
 * Goal presentation shared by My Elise → Goals and the Live Canvas Surfaces (ADR-055). Every
 * number arrives computed (GoalCard); this only formats it. Status is never color alone.
 */

export function useGoalFormat() {
  const { t, locale } = useI18n();
  const g = t.native.goals;
  const loc = locale === "es" ? "es-AR" : "en-US";
  const number = (n: number) => new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(n);
  const amount = (n: number | null, c: Pick<GoalCard, "currency" | "unit">) => {
    if (n === null) return "—";
    if (c.currency)
      return new Intl.NumberFormat(loc, {
        style: "currency",
        currency: c.currency,
        maximumFractionDigits: 0,
      }).format(n);
    return number(n);
  };
  return {
    locale,
    number,
    amount,
    day: (d: string) => dayLabel(d, locale),
    /** "14 oct → 13 ene 2027 · 3 meses" — the range and its duration, never a preset name. */
    period: (from: string | null, to: string | null) =>
      from && to ? `${rangeLabel(from, to, locale)} · ${durationLabel(from, to, locale)}` : null,
    /** "7 / 12 clientes", "38 → 30 min", "68%". */
    value(c: GoalCard) {
      const unit = c.currency
        ? ""
        : c.unit && c.unit !== "%"
          ? ` ${c.unit}`
          : c.unit === "%"
            ? "%"
            : "";
      if (c.progressType === "binary") return c.status === "completed" ? "✓" : "";
      if (c.progressType === "percentage") return c.value === null ? "—" : `${number(c.value)}%`;
      if (c.direction === "decrease")
        return `${amount(c.value, c)}${unit} → ${amount(c.target, c)}${unit}`;
      return `${amount(c.value ?? 0, c)} / ${amount(c.target, c)}${unit}`;
    },
    reason(c: Pick<GoalCard, "reason">) {
      const r = c.reason;
      if (!r) return null;
      if (r.kind === "pace")
        return g.reasons.pace(
          Math.round((1 - (r.elapsed ?? 0)) * 100),
          Math.round((r.progress ?? 0) * 100),
        );
      return r.kind === "overdue"
        ? g.reasons.overdue(dayLabel(r.date!, locale))
        : g.reasons.starts(dayLabel(r.date!, locale));
    },
  };
}

/** The Vision icon, everywhere a Vision appears (button, cards, Canvas). */
export const VisionIcon = Eye;

const HEALTH: Record<HealthState, { icon: LucideIcon; tone: string }> = {
  at_risk: { icon: AlertTriangle, tone: "text-approval-text bg-approval-bg" },
  on_track: { icon: TrendingUp, tone: "text-accent-text bg-accent-soft" },
  in_progress: { icon: CircleDot, tone: "text-muted bg-surface-2" },
  not_started: { icon: CircleDashed, tone: "text-muted bg-surface-2" },
  completed: { icon: CheckCircle2, tone: "text-success bg-success/12" },
  paused: { icon: PauseCircle, tone: "text-muted bg-surface-2" },
  cancelled: { icon: XCircle, tone: "text-faint bg-surface-2" },
  archived: { icon: Archive, tone: "text-faint bg-surface-2" },
};

export function HealthBadge({ state, reached }: { state: HealthState; reached?: boolean }) {
  const { t } = useI18n();
  const g = t.native.goals;
  const h =
    reached && state === "on_track"
      ? { icon: CheckCircle2, tone: HEALTH.completed.tone }
      : HEALTH[state];
  const Icon = h.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium",
        h.tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {reached && state === "on_track" ? g.reached : g.health[state]}
    </span>
  );
}

/** A done / not-done goal entered by hand has no bar to show until it is done. */
export const shownPercent = (c: GoalCard) =>
  c.progressType === "binary" && c.basis === "manual" ? null : c.percent;

/** The progress bar with its numbers for assistive tech (status is in the text, not the color). */
export function GoalBar({ card, className }: { card: GoalCard; className?: string }) {
  const fmt = useGoalFormat();
  const pct = shownPercent(card);
  if (pct === null) return null;
  const risk = card.health === "at_risk";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% · ${fmt.value(card)}`}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
          card.status === "completed" || card.reached
            ? "bg-success"
            : risk
              ? "bg-approval"
              : "bg-accent",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function ProgressRing({
  percent,
  size = 64,
  tone = "accent",
  label,
}: {
  percent: number | null;
  size?: number;
  tone?: "accent" | "risk" | "done";
  label?: string;
}) {
  const stroke = size >= 56 ? 6 : 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = percent ?? 0;
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      role={percent === null ? undefined : "img"}
      aria-label={label ?? (percent === null ? undefined : `${percent}%`)}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-surface-2"
        />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - p / 100)}
            className={cn(
              "transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none",
              tone === "risk"
                ? "stroke-approval"
                : tone === "done"
                  ? "stroke-success"
                  : "stroke-accent",
            )}
          />
        )}
      </svg>
      <span className="absolute font-mono text-[12.5px]" aria-hidden>
        {percent === null ? "—" : `${percent}%`}
      </span>
    </span>
  );
}

export const ringTone = (c: GoalCard) =>
  c.status === "completed" || c.reached ? "done" : c.health === "at_risk" ? "risk" : "accent";

/**
 * One goal, scannable: icon, title, Vision / area, period, value, bar and status. Used by the
 * Goals grid and the Canvas Surfaces; `compact` drops the secondary line.
 */
export function GoalSummary({
  card,
  compact = false,
  onValueClick,
}: {
  card: GoalCard;
  compact?: boolean;
  onValueClick?: (el: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const g = t.native.goals;
  const fmt = useGoalFormat();
  const period = fmt.period(card.periodFrom, card.periodTo);
  // A deadline alone is not a period: it shows below as "Vence …".
  const context = [card.visions[0] ?? card.area, period ?? (card.deadline ? null : g.noPeriod)]
    .filter(Boolean)
    .join(" · ");
  const value = fmt.value(card);
  const drivers = card.habits.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start gap-3">
        <IconTile icon={card.icon} size={compact ? "sm" : "md"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-medium">{card.title}</p>
          {!compact && context && <p className="truncate text-[12.5px] text-muted">{context}</p>}
        </div>
        <HealthBadge state={card.health} reached={card.reached && card.status === "active"} />
      </div>
      {shownPercent(card) !== null || value ? (
        <div className="flex items-center gap-3">
          <GoalBar card={card} className="flex-1" />
          {value &&
            (onValueClick ? (
              <button
                type="button"
                onClick={(e) => onValueClick(e.currentTarget)}
                className="shrink-0 rounded-md px-1 font-mono text-[12.5px] hover:bg-active hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                aria-label={`${g.progress.update}: ${value}`}
              >
                {value}
              </button>
            ) : (
              <span className="shrink-0 font-mono text-[12.5px]">{value}</span>
            ))}
          {shownPercent(card) !== null && (
            <span className="w-9 shrink-0 text-right font-mono text-[12px] text-muted">
              {card.percent}%
            </span>
          )}
        </div>
      ) : null}
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
          {card.status === "completed" && card.completedAt ? (
            <span>{g.completedOn(fmt.day(card.completedAt.slice(0, 10)))}</span>
          ) : (
            card.deadline && <span>{g.due(fmt.day(card.deadline))}</span>
          )}
          {drivers > 0 && (
            <span
              className="inline-flex items-center gap-1"
              title={card.habits.map((h) => h.name).join(", ")}
            >
              <Repeat className="size-3" aria-hidden />
              {g.linkedHabits(drivers)}
            </span>
          )}
          {card.health === "at_risk" && fmt.reason(card) && (
            <span className="text-approval-text">{fmt.reason(card)}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** "Workout 2/3 esta semana", compact; drives = it adds to the goal's progress. */
export function HabitChips({ habits }: { habits: GoalCard["habits"] }) {
  const { t } = useI18n();
  const d = t.native.goals.detail;
  if (!habits.length) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {habits.map((h) => (
        <li key={h.name} className="flex items-center gap-2 text-[13px]">
          <span aria-hidden className="w-5 text-center">
            {h.icon ?? <Circle className="mx-auto size-2 fill-accent text-accent" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{h.name}</span>
          <span className="font-mono text-[12px] text-muted">
            {h.done}/{h.goal} {d.thisWeek}
          </span>
          <span className={cn("text-[11px]", h.drives ? "text-accent-text" : "text-faint")}>
            {h.drives ? d.drives : d.context}
          </span>
        </li>
      ))}
    </ul>
  );
}
