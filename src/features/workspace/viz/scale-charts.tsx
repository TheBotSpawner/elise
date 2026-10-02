"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import type { VisualizationSpec } from "@/core/workspace/visualization";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useNumberFormat } from "./charts";
import { CHART_IN } from "../canvas/motion";

/**
 * Comparison on one scale (ADR-027): dots for values of the same metric across categories,
 * and scenarios/ranges. Both show a sourced reference as a dashed marker, deltas computed by
 * ELISE, and every point's provenance on demand (click or keyboard). Shape and text — not
 * colour alone — tell a weak datapoint (hollow, labelled) from a solid one.
 */

type Dot = Extract<VisualizationSpec, { type: "dot" }>;
type Range = Extract<VisualizationSpec, { type: "range" }>;

/** A padded linear scale over the values and the reference. */
function scale(values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  return (v: number) => ((v - min) / (max - min)) * 100;
}

function pctText(p: number | undefined) {
  return p === undefined ? null : `${p > 0 ? "+" : ""}${p}%`;
}

export function DotChart({ spec }: { spec: Dot }) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const reduced = useReducedMotion();
  const [open, setOpen] = useState<number | null>(null);
  const ref = spec.reference;
  const x = scale([...spec.rows.map((r) => r.value), ...(ref ? [ref.value] : [])]);
  return (
    <div className="flex flex-col gap-1">
      {ref && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <svg width="16" height="8" aria-hidden>
            <line
              x1="0"
              y1="4"
              x2="16"
              y2="4"
              stroke="var(--fg-muted)"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
          </svg>
          {ref.label} · <span className="font-mono">{f.full(ref.value)}</span>
          <SourceMark spec={spec} index={ref.source} />
        </p>
      )}
      <ul className="flex flex-col">
        {spec.rows.map((r, i) => {
          const delta = pctText(r.deltaPct);
          const source = r.source !== undefined ? spec.sources?.[r.source] : undefined;
          return (
            <li
              key={`${r.label}-${i}`}
              className="border-t border-[var(--sf-ambient-line)] first:border-t-0"
            >
              <button
                type="button"
                aria-expanded={open === i}
                onClick={() => setOpen(open === i ? null : i)}
                aria-label={`${r.label}: ${f.full(r.value)}${delta && ref ? `, ${t.canvas.viz.vsReference(delta, ref.label)}` : ""}${r.uncertain ? `, ${t.canvas.viz.uncertain}` : ""}${source ? `. ${t.canvas.viz.source}: ${source.title}` : ""}`}
                className="grid min-h-[34px] w-full grid-cols-[minmax(72px,28%)_minmax(0,1fr)_auto] items-center gap-3 text-left text-[13px] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)]"
              >
                <span className="truncate text-fg2">{r.label}</span>
                <span className="relative h-5" aria-hidden>
                  <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--gridline)]" />
                  {ref && (
                    <span
                      className="absolute top-0 bottom-0 w-0 border-l border-dashed border-[var(--fg-muted)]"
                      style={{ left: `${x(ref.value)}%` }}
                    />
                  )}
                  {ref && (
                    <span
                      className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-[var(--chart-neutral-2)]"
                      style={{
                        left: `${Math.min(x(ref.value), x(r.value))}%`,
                        width: `${Math.abs(x(r.value) - x(ref.value))}%`,
                      }}
                    />
                  )}
                  <motion.span
                    className={cn(
                      "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--accent)]",
                      r.uncertain ? "bg-transparent" : "bg-[var(--accent)]",
                    )}
                    initial={
                      reduced ? false : { left: ref ? `${x(ref.value)}%` : "0%", opacity: 0 }
                    }
                    animate={{ left: `${x(r.value)}%`, opacity: 1 }}
                    transition={CHART_IN}
                  />
                </span>
                <span className="flex items-baseline justify-end gap-2 text-right">
                  <span className="font-mono text-[12.5px] text-fg">{f.full(r.value)}</span>
                  {delta && <span className="font-mono text-[11px] text-muted">{delta}</span>}
                </span>
              </button>
              {open === i && (
                <p className="pb-2 pl-[calc(28%+12px)] text-[11.5px] text-muted">
                  {r.uncertain && <span className="mr-2 text-fg2">{t.canvas.viz.uncertain}.</span>}
                  {source ? <SourceLink source={source} /> : <span>{t.canvas.viz.source}: —</span>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function RangeChart({ spec }: { spec: Range }) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const [open, setOpen] = useState<number | null>(null);
  const ref = spec.reference;
  const values = spec.scenarios.map((s) => s.value);
  const x = scale([...values, ...(ref ? [ref.value] : [])]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const ordered = [...spec.scenarios]
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => a.value - b.value);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={`${t.canvas.viz.range} ${f.full(lo)}–${f.full(hi)}: ${ordered
          .map((s) => `${s.label} ${f.full(s.value)}`)
          .join(", ")}${ref ? `; ${ref.label} ${f.full(ref.value)}` : ""}`}
        className="relative mx-2 h-16"
      >
        <span className="absolute inset-x-0 top-8 h-px bg-[var(--gridline)]" aria-hidden />
        {/* The span between the lowest and highest scenario (not a probability). */}
        <span
          className="absolute top-[26px] h-3 rounded-full bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]"
          style={{ left: `${x(lo)}%`, width: `${x(hi) - x(lo)}%` }}
          aria-hidden
        />
        {ref && (
          <span
            className="absolute top-2 bottom-0 w-0 border-l border-dashed border-[var(--fg-muted)]"
            style={{ left: `${x(ref.value)}%` }}
            aria-hidden
          >
            <span className="absolute -top-1 left-1 font-mono text-[10px] whitespace-nowrap text-muted">
              {ref.label}
            </span>
          </span>
        )}
        {ordered.map((s) => (
          <span
            key={s.i}
            className={cn(
              "absolute top-8 -translate-x-1/2 -translate-y-1/2 border-2 border-[var(--accent)] bg-[var(--bg)]",
              s.kind === "base" ? "size-3.5 rounded-full bg-[var(--accent)]" : "size-3 rotate-45",
            )}
            style={{ left: `${x(s.value)}%` }}
            aria-hidden
          />
        ))}
      </div>
      <ul className="flex flex-col">
        {ordered.map((s) => {
          const source = s.source !== undefined ? spec.sources?.[s.source] : undefined;
          return (
            <li key={s.i} className="border-t border-[var(--sf-ambient-line)]">
              <button
                type="button"
                aria-expanded={open === s.i}
                onClick={() => setOpen(open === s.i ? null : s.i)}
                className="grid min-h-[30px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left text-[13px] hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)]"
              >
                <span
                  className={cn("truncate", s.kind === "base" ? "font-medium text-fg" : "text-fg2")}
                >
                  {s.label}
                </span>
                <span className="font-mono text-[12.5px]">{f.full(s.value)}</span>
              </button>
              {open === s.i && (
                <p className="pb-2 text-[11.5px] text-muted">
                  {source ? <SourceLink source={source} /> : <span>{t.canvas.viz.source}: —</span>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-faint">{t.canvas.viz.scenarioNote}</p>
    </div>
  );
}

/** The same values as a table, with each one's source: the text equivalent of a comparison. */
export function PointsTable({ spec }: { spec: Dot | Range }) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const rows = spec.type === "dot" ? spec.rows : spec.scenarios;
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="border-b border-border font-mono text-[10.5px] tracking-[0.1em] text-faint uppercase">
          <th scope="col" className="pb-2 text-left font-normal">
            {spec.title}
          </th>
          <th scope="col" className="pb-2 text-right font-normal">
            {t.canvas.viz.point}
          </th>
          <th scope="col" className="pb-2 pl-3 text-left font-normal">
            {t.canvas.viz.source}
          </th>
        </tr>
      </thead>
      <tbody>
        {spec.reference && (
          <tr className="h-8 border-b border-[var(--sf-ambient-line)] text-muted">
            <th scope="row" className="text-left font-normal">
              {spec.reference.label} ({t.canvas.viz.reference})
            </th>
            <td className="text-right font-mono">{f.full(spec.reference.value)}</td>
            <td className="truncate pl-3">
              {spec.sources?.[spec.reference.source ?? -1]?.title ?? "—"}
            </td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={i} className="h-8 border-b border-[var(--sf-ambient-line)]">
            <th scope="row" className="text-left font-normal text-fg2">
              {r.label}
            </th>
            <td className="text-right font-mono">
              {f.full(r.value)}
              {"deltaPct" in r && r.deltaPct !== undefined ? ` (${pctText(r.deltaPct)})` : ""}
            </td>
            <td className="max-w-[180px] truncate pl-3">
              {spec.sources?.[r.source ?? -1]?.title ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Where the numbers come from: every source, openable. */
export function SourcesFooter({ sources }: { sources: { title: string; url: string | null }[] }) {
  const { t } = useI18n();
  if (!sources.length) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      <span className="font-mono tracking-[0.08em] text-faint uppercase">
        {t.canvas.viz.sources}
      </span>
      {sources.map((s, i) => (
        <SourceLink key={i} source={s} />
      ))}
    </p>
  );
}

function SourceLink({ source }: { source: { title: string; url: string | null } }) {
  return source.url ? (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-2 hover:text-fg hover:underline"
    >
      {source.title} ↗
    </a>
  ) : (
    <span>{source.title}</span>
  );
}

function SourceMark({ spec, index }: { spec: Dot | Range; index: number | undefined }) {
  const s = index !== undefined ? spec.sources?.[index] : undefined;
  return s ? (
    <span className="text-faint">
      · <SourceLink source={s} />
    </span>
  ) : null;
}
