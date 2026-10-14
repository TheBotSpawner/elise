"use client";

import Link from "next/link";

import type { SurfacePayloads } from "@/core/workspace/registry";
import type { VisualizationSpec } from "@/core/workspace/visualization";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  GoalSummary,
  HabitChips,
  HealthBadge,
  ProgressRing,
  ringTone,
  useGoalFormat,
} from "./goal-parts";
import { IconTile } from "./native-ui";

/**
 * Goals on the Live Canvas (ADR-055): structured Surfaces rendered from validated payloads —
 * one goal, a Vision with the goals advancing it, and an overview of a list scope. The same
 * pieces as My Elise → Goals, so the Canvas and the page always look and read alike.
 */

export function GoalSurfaceBody({ p }: { p: SurfacePayloads["goal"] }) {
  const { t } = useI18n();
  const g = t.native.goals;
  const d = g.detail;
  const fmt = useGoalFormat();
  const c = p.goal;
  const period = fmt.period(c.periodFrom, c.periodTo);
  const trend: VisualizationSpec | null =
    p.history.length >= 2
      ? ({
          type: "line",
          title: "",
          format: c.currency ? { kind: "currency", currency: c.currency } : { kind: "number" },
          x: p.history.map((h) => fmt.day(h.date).replace(/ \d{4}$/, "")),
          series: [{ name: c.unit ?? d.progress, values: p.history.map((h) => h.value) }],
          ...(c.target !== null && c.progressType === "numeric"
            ? { target: { value: c.target, label: d.target } }
            : {}),
        } as VisualizationSpec)
      : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <ProgressRing percent={c.percent} size={68} tone={ringTone(c)} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            {c.icon && <span aria-hidden>{c.icon}</span>}
            <HealthBadge state={c.health} reached={c.reached && c.status === "active"} />
          </span>
          <span className="font-mono text-[18px]">{fmt.value(c) || g.health[c.health]}</span>
          <span className="text-[12px] text-muted">
            {[period, c.deadline ? g.due(fmt.day(c.deadline)) : null, c.visions[0]]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      {c.health === "at_risk" && fmt.reason(c) && (
        <p className="rounded-xl bg-approval-bg px-3 py-2 text-[12.5px] text-approval-text">
          {fmt.reason(c)}
        </p>
      )}
      {c.reached && c.status === "active" && (
        <p className="rounded-xl bg-success/12 px-3 py-2 text-[12.5px]">{g.reachedHint}</p>
      )}
      <p className="text-[12px] text-faint">{d.basis[c.basis]}</p>
      {trend && <Visualization spec={trend} size="small" />}
      <HabitChips habits={c.habits} />
      {p.parent && (
        <p className="text-[12.5px]">
          <span className="text-muted">{d.parent}: </span>
          {p.parent.icon} {p.parent.title}
        </p>
      )}
      {p.children.length > 0 && (
        <p className="text-[12.5px]">
          <span className="text-muted">{d.children}: </span>
          {p.children
            .map((x) => `${x.title}${x.percent !== null ? ` ${x.percent}%` : ""}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}

export function GoalsOverviewBody({ p }: { p: SurfacePayloads["goals_overview"] }) {
  const { t } = useI18n();
  const g = t.native.goals;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-4 gap-2 text-[12px]">
        {(
          [
            [g.summary.active, p.summary.active, false],
            [g.summary.atRisk, p.summary.atRisk, p.summary.atRisk > 0],
            [g.summary.completed, p.summary.completed, false],
            [
              g.summary.average,
              p.summary.averageProgress === null ? "—" : `${p.summary.averageProgress}%`,
              false,
            ],
          ] as const
        ).map(([label, value, flag]) => (
          <div key={label} className="flex flex-col gap-0.5 rounded-xl bg-surface-2/60 px-2.5 py-2">
            <dt className="truncate text-muted">{label}</dt>
            <dd className={cn("font-mono text-[16px]", flag && "text-approval-text")}>{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="flex flex-col gap-3">
        {p.goals.map((c) => (
          <li key={c.id}>
            <Link
              href={`/my-elise/goals?goal=${c.id}`}
              className="block rounded-xl hover:bg-active/50"
            >
              <GoalSummary card={c} />
            </Link>
          </li>
        ))}
      </ul>
      {p.total > p.goals.length && (
        <Link href="/my-elise/goals" className="text-[12.5px] text-accent-text">
          +{p.total - p.goals.length}
        </Link>
      )}
    </div>
  );
}

export function VisionSurfaceBody({ p }: { p: SurfacePayloads["vision"] }) {
  const { t } = useI18n();
  const g = t.native.goals;
  const d = g.detail;
  const v = p.vision;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <IconTile icon={v.icon} />
        <div className="min-w-0">
          <p className="text-[14px] leading-snug">{v.title}</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {g.visionStatus[v.status]}
            {v.area ? ` · ${v.area}` : ""}
            {p.total ? ` · ${g.visionDone(p.completed, p.total)}` : ""}
          </p>
        </div>
      </div>
      {v.description && <p className="line-clamp-3 text-[12.5px] text-muted">{v.description}</p>}
      {p.goals.length ? (
        <ul className="flex flex-col gap-3">
          {p.goals.map((c) => (
            <li key={c.id}>
              <GoalSummary card={c} compact />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-faint">{d.noGoals}</p>
      )}
      {p.habits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="type-label text-faint">{d.visionHabits}</h3>
          <HabitChips habits={p.habits} />
        </div>
      )}
    </div>
  );
}
