"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";

import type { VisualizationSpec } from "@/core/workspace/visualization";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  BarChart,
  DataTable,
  Distribution,
  Diverging,
  HBars,
  LineChart,
  Progress,
  SeriesTable,
  Streak,
  useNumberFormat,
  type ChartSize,
} from "./charts";

const CHART_H: Record<ChartSize, number> = { small: 120, medium: 170, large: 230, focus: 380 };

/** The Visualization Surface body: a validated spec, drawn by its template. */
export function Visualization({ spec, size }: { spec: VisualizationSpec; size: ChartSize }) {
  const { t } = useI18n();
  const [view, setView] = useState<"chart" | "table">("chart");
  const series = spec.type === "line" || spec.type === "area" || spec.type === "bar";
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {(spec.insight || series) && (
        <div className="flex items-start gap-3">
          {spec.insight && (
            <p
              className={cn(
                "min-w-0 flex-1 leading-[1.45] text-fg2",
                size === "focus" ? "text-[15.5px]" : "text-[13.5px]",
              )}
            >
              {spec.insight}
            </p>
          )}
          {series && (
            <div
              role="group"
              aria-label={t.canvas.viz.view}
              className="ml-auto flex shrink-0 rounded-lg border border-border p-0.5 font-mono text-[10.5px] tracking-[0.08em]"
            >
              {(["chart", "table"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cn(
                    "h-[22px] rounded-md px-2 uppercase",
                    view === v ? "bg-inner text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {t.canvas.viz[v]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {series && view === "table" ? <SeriesTable spec={spec} /> : <Chart spec={spec} size={size} />}
    </div>
  );
}

function Chart({ spec, size }: { spec: VisualizationSpec; size: ChartSize }) {
  switch (spec.type) {
    case "kpi":
      return <Kpi spec={spec} size={size} />;
    case "line":
    case "area":
      return <LineChart spec={spec} height={CHART_H[size]} />;
    case "bar":
      return <BarChart spec={spec} height={CHART_H[size]} />;
    case "hbar":
      return <HBars spec={spec} />;
    case "distribution":
      return <Distribution spec={spec} />;
    case "diverging":
      return <Diverging spec={spec} />;
    case "progress":
      return <Progress spec={spec} thick={size !== "small"} />;
    case "streak":
      return <Streak spec={spec} />;
    case "table":
      return <DataTable spec={spec} />;
  }
}

function Kpi({
  spec,
  size,
}: {
  spec: Extract<VisualizationSpec, { type: "kpi" }>;
  size: ChartSize;
}) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const prev = spec.previous ?? null;
  const delta = prev !== null && prev !== 0 ? (spec.value - prev) / Math.abs(prev) : null;
  const good =
    delta === null || spec.goodWhen === "none"
      ? null
      : spec.goodWhen === "up"
        ? delta > 0
        : delta < 0;
  const big = size === "small" ? "text-[30px]" : size === "medium" ? "text-[40px]" : "text-[56px]";
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn("leading-none font-light tracking-[-0.035em]", big)}>
          {f.full(spec.value)}
        </span>
        {delta !== null && (
          <span
            className={cn(
              "flex items-center gap-1 text-[13px]",
              good === null ? "text-muted" : good ? "text-success" : "text-approval-text",
            )}
          >
            {delta > 0 ? (
              <ArrowUp className="size-3" aria-hidden />
            ) : (
              <ArrowDown className="size-3" aria-hidden />
            )}
            {t.canvas.viz.delta(
              Math.abs(Math.round(delta * 1000) / 10),
              delta > 0,
              spec.previousLabel ?? "",
            )}
          </span>
        )}
      </p>
      {prev !== null && (
        <p className="text-[13px] text-muted">
          {spec.previousLabel ?? t.canvas.viz.previous}:{" "}
          <span className="font-mono">{f.full(prev)}</span>
        </p>
      )}
      {spec.secondary && spec.secondary.length > 0 && (
        <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
          {spec.secondary.map((x) => (
            <div key={x.label} className="flex gap-1.5">
              <dt className="text-muted">{x.label}</dt>
              <dd className="font-mono text-fg2">{f.full(x.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {spec.note && <p className="text-[12.5px] leading-[1.5] text-faint">{spec.note}</p>}
      {spec.goal && (
        <div className="mt-2 flex flex-col gap-1.5">
          <span className="relative h-2 rounded bg-track" aria-hidden>
            <span
              className="block h-2 rounded bg-accent"
              style={{ width: `${spec.goal.percent}%` }}
            />
            {spec.goal.pace !== undefined && (
              <span
                className="absolute -top-1 h-4 w-0.5 bg-fg"
                style={{ left: `${spec.goal.pace}%` }}
              />
            )}
          </span>
          <p className="text-[12px] text-fg2">{t.canvas.viz.goal(Math.round(spec.goal.percent))}</p>
        </div>
      )}
    </div>
  );
}
