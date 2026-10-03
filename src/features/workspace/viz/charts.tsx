"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId, useRef, useState, type ReactNode } from "react";

import type { VisualizationSpec } from "@/core/workspace/visualization";
import { useElementSize } from "@/hooks/use-element-size";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { CHART_IN } from "../canvas/motion";

/**
 * ELISE visualization layer (ADR-021): one renderer per validated template, plain SVG and
 * HTML, no chart library. Accent marks what the chart is about; everything else is neutral.
 * Every chart has a text equivalent (aria-label + a Table view) and per-mark tooltips that
 * also open on keyboard focus. Text always uses text tokens, never the series colour.
 */

/** The template(s) whose type includes T (some templates share a schema: hbar | distribution). */
type Spec<T extends VisualizationSpec["type"]> = VisualizationSpec extends infer S
  ? S extends { type: infer K }
    ? T extends K
      ? S
      : never
    : never
  : never;
export type ChartSize = "small" | "medium" | "large" | "focus";

export function useNumberFormat(format: VisualizationSpec["format"]) {
  const { locale } = useI18n();
  const opts: Intl.NumberFormatOptions =
    format.kind === "currency" && format.currency
      ? {
          style: "currency",
          currency: format.currency,
          maximumFractionDigits: format.decimals ?? 0,
        }
      : format.kind === "percent"
        ? { style: "percent", maximumFractionDigits: format.decimals ?? 0 }
        : { maximumFractionDigits: format.decimals ?? 1 };
  const full = new Intl.NumberFormat(locale, opts);
  const short = new Intl.NumberFormat(locale, { ...opts, notation: "compact" });
  const unit = format.kind === "hours" ? " h" : "";
  // Percent specs carry 0–100 in series (readable to people and to the model).
  const scale = (v: number) => (format.kind === "percent" ? v / 100 : v);
  return {
    full: (v: number) => `${full.format(scale(v))}${unit}`,
    short: (v: number) =>
      `${Math.abs(v) >= 10_000 ? short.format(scale(v)) : full.format(scale(v))}${unit}`,
  };
}

/** A round step (1, 2, 2.5 or 5 × 10ⁿ) giving about three gridlines. */
export function niceStep(v: number) {
  const raw = Math.max(v, 1e-9) / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function niceMax(v: number) {
  if (v <= 0) return 1;
  const step = niceStep(v);
  return Math.ceil(v / step) * step;
}
const ticks = (max: number) => {
  const step = niceStep(max);
  return Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
};

/**
 * The y range of a line: fitted to the data on round ticks (a price between 7,400 and 8,100
 * must not be a flat line on a zero baseline), from zero only when zero is near or meaningful
 * (an area shows magnitude). Bars always start at zero — their length is the value.
 */
export function domain(
  values: number[],
  fromZero: boolean,
): { lo: number; hi: number; ticks: number[] } {
  const lo0 = Math.min(...values);
  const hi0 = Math.max(...values);
  const nearZero = lo0 >= 0 && lo0 <= (hi0 - lo0) * 0.5;
  if (fromZero || nearZero) {
    const lo = Math.min(0, lo0);
    const hi = niceMax(Math.max(hi0, 0)) || 1;
    const step = niceStep(hi - lo);
    const start = Math.floor(lo / step) * step;
    return {
      lo: start,
      hi,
      ticks: Array.from(
        { length: Math.round((hi - start) / step) + 1 },
        (_, i) => start + i * step,
      ),
    };
  }
  const pad = (hi0 - lo0 || Math.abs(hi0) || 1) * 0.08;
  const step = niceStep(hi0 - lo0 + 2 * pad);
  const lo = Math.floor((lo0 - pad) / step) * step;
  const hi = Math.ceil((hi0 + pad) / step) * step;
  return {
    lo,
    hi,
    ticks: Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step),
  };
}

/** Series colours in order: the accent, then quieter steps of it, then neutrals. */
export const SERIES_FILL = [
  "var(--accent)",
  "color-mix(in srgb, var(--accent) 55%, var(--bg))",
  "var(--chart-neutral)",
  "var(--chart-neutral-2)",
];

/** A tooltip that opens on hover or keyboard focus of its mark. */
export function Tip({
  x,
  y,
  width,
  children,
}: {
  x: number;
  y: number;
  width: number;
  children: ReactNode;
}) {
  const w = 168;
  const left = Math.min(Math.max(0, x - w / 2), Math.max(0, width - w));
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 rounded-lg border border-border-strong bg-[var(--tip-bg)] px-3 py-2 text-[12px] shadow-[var(--menu-shadow)]"
      style={{ left, top: Math.max(0, y - 64), width: w }}
    >
      {children}
    </div>
  );
}

function Legend({
  items,
  hidden,
  onToggle,
}: {
  items: { name: string; dashed?: boolean; accent?: boolean; color?: string }[];
  /** Series hidden by the user (a legend entry toggles its series). */
  hidden?: ReadonlySet<string>;
  onToggle?: (name: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
      {items.map((it) => {
        const mark = (
          <svg width="18" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="18"
              y2="3"
              stroke={it.color ?? (it.accent ? "var(--accent)" : "var(--fg-muted)")}
              strokeWidth={it.color ? 6 : 2}
              strokeDasharray={it.dashed ? "4 4" : undefined}
            />
          </svg>
        );
        return (
          <li key={it.name}>
            {onToggle ? (
              <button
                type="button"
                aria-pressed={!hidden?.has(it.name)}
                onClick={() => onToggle(it.name)}
                className={cn(
                  "flex items-center gap-1.5 rounded hover:text-fg",
                  hidden?.has(it.name) && "opacity-45",
                )}
              >
                {mark}
                {it.name}
              </button>
            ) : (
              <span className="flex items-center gap-1.5">
                {mark}
                {it.name}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Arrow keys move through a chart's datapoints (the tooltip follows). */
export function datapointKeys(n: number, current: number | null, set: (i: number | null) => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next =
        (current ?? (e.key === "ArrowRight" ? -1 : n)) + (e.key === "ArrowRight" ? 1 : -1);
      set(Math.max(0, Math.min(n - 1, next)));
    } else if (e.key === "Home") set(0);
    else if (e.key === "End") set(n - 1);
    else if (e.key === "Escape") set(null);
  };
}

// ── Line / area ──────────────────────────────────────────────────────────────

const PAD_L = 44;

export function LineChart({ spec, height }: { spec: Spec<"line" | "area">; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const reduced = useReducedMotion();
  const gid = useId();
  const f = useNumberFormat(spec.format);
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const shown = spec.series.filter((s) => !hidden.has(s.name));
  const all = (shown.length ? shown : spec.series).flatMap((s) =>
    s.values.filter((v): v is number => v !== null),
  );
  const extra = [spec.target?.value, spec.reference?.value].filter(
    (v): v is number => v !== undefined,
  );
  const d = domain([...all, ...extra], spec.type === "area");
  const min = d.lo;
  const max = d.hi;
  const n = spec.x.length;
  const w = Math.max(120, width);
  const h = height;
  const X = (i: number) => PAD_L + (i / Math.max(1, n - 1)) * (w - PAD_L - 8);
  const Y = (v: number) => 8 + (1 - (v - min) / (max - min || 1)) * (h - 32);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };
  const main = spec.series[0]!;
  const lastIdx = main.values.findLastIndex((v) => v !== null);
  const area =
    spec.type === "area" && lastIdx > 0
      ? `${path(main.values)} L${X(lastIdx).toFixed(1)} ${Y(min)} L${X(main.values.findIndex((v) => v !== null))} ${Y(min)} Z`
      : null;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 80))));
  return (
    <div ref={ref} className="relative flex flex-col gap-2">
      <Legend
        items={spec.series.map((s, i) => ({ name: s.name, dashed: i > 0, accent: i === 0 }))}
        hidden={hidden}
        onToggle={(name) =>
          setHidden((h0) => {
            const next = new Set(h0);
            if (next.has(name)) next.delete(name);
            else if (next.size < spec.series.length - 1) next.add(name);
            return next;
          })
        }
      />
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="img"
          tabIndex={0}
          aria-label={chartSummary(spec, f.full)}
          className="block overflow-visible rounded outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onKeyDown={datapointKeys(n, hover, setHover)}
          onFocus={() => setHover((h0) => h0 ?? n - 1)}
          onBlur={() => setHover(null)}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - PAD_L) / (w - PAD_L - 8)) * (n - 1));
            setHover(Math.max(0, Math.min(n - 1, i)));
          }}
        >
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {d.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" />
              <text x={0} y={Y(t) + 4} className="fill-faint font-mono text-[10.5px]">
                {f.short(t)}
              </text>
            </g>
          ))}
          {spec.target && (
            <g>
              <line
                x1={PAD_L}
                x2={w}
                y1={Y(spec.target.value)}
                y2={Y(spec.target.value)}
                stroke="var(--fg-muted)"
                strokeDasharray="4 4"
              />
              {spec.target.label && (
                <text
                  x={w}
                  y={Y(spec.target.value) - 6}
                  textAnchor="end"
                  className="fill-muted font-mono text-[10.5px]"
                >
                  {spec.target.label}
                </text>
              )}
            </g>
          )}
          {area && <path d={area} fill={`url(#${gid})`} />}
          {[...spec.series].reverse().map((s, ri) => {
            const i = spec.series.length - 1 - ri;
            if (hidden.has(s.name)) return null;
            return (
              <motion.path
                key={s.name}
                d={path(s.values)}
                fill="none"
                stroke={i === 0 ? "var(--accent)" : "var(--fg-muted)"}
                strokeWidth={i === 0 ? 2 : 1.5}
                strokeDasharray={i > 0 ? "4 4" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                initial={reduced || i > 0 ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={CHART_IN}
              />
            );
          })}
          {lastIdx >= 0 && (
            <g>
              <circle
                cx={X(lastIdx)}
                cy={Y(main.values[lastIdx]!)}
                r={7}
                fill="var(--accent)"
                fillOpacity={0.18}
              />
              <circle cx={X(lastIdx)} cy={Y(main.values[lastIdx]!)} r={3.5} fill="var(--accent)" />
              <text
                x={X(lastIdx) + (lastIdx > n * 0.8 ? -10 : 10)}
                y={Y(main.values[lastIdx]!) - 12}
                textAnchor={lastIdx > n * 0.8 ? "end" : "start"}
                className="fill-fg font-mono text-[12px]"
              >
                {f.full(main.values[lastIdx]!)}
              </text>
            </g>
          )}
          {spec.x.map((label, i) =>
            (i % labelEvery === 0 && n - 1 - i >= labelEvery / 2) || i === n - 1 ? (
              <text
                key={i}
                x={X(i)}
                y={h - 4}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                className="fill-faint font-mono text-[10.5px]"
              >
                {label}
              </text>
            ) : null,
          )}
          {hover !== null && (
            <line
              x1={X(hover)}
              x2={X(hover)}
              y1={8}
              y2={h - 24}
              stroke="var(--fg-muted)"
              strokeOpacity={0.5}
            />
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <Tip x={X(hover)} y={Y(main.values[hover] ?? 0) + 30} width={w}>
          <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted uppercase">
            {spec.x[hover]}
          </p>
          {spec.series.map((s) => (
            <p key={s.name} className="flex justify-between gap-3">
              <span className="text-muted">{s.name}</span>
              <span className="font-mono text-fg">
                {s.values[hover] === null ? "—" : f.full(s.values[hover]!)}
              </span>
            </p>
          ))}
        </Tip>
      )}
    </div>
  );
}

// ── Bars (single or paired periods) ──────────────────────────────────────────

export function BarChart({ spec, height }: { spec: Spec<"bar">; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const reduced = useReducedMotion();
  const f = useNumberFormat(spec.format);
  const [hover, setHover] = useState<number | null>(null);
  const k = spec.series.length;
  const stacked = Boolean(spec.stacked) && k > 1;
  const at = (si: number, i: number) => Math.max(0, spec.series[si]!.values[i] ?? 0);
  const totals = spec.x.map((_, i) => spec.series.reduce((n, _s, si) => n + at(si, i), 0));
  const peak = stacked
    ? Math.max(...totals)
    : Math.max(...spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const max = niceMax(Math.max(peak, spec.target?.value ?? 0));
  const n = spec.x.length;
  const w = Math.max(120, width);
  const h = height;
  const slot = (w - PAD_L) / n;
  // Grouped bars share ~70% of the slot; one bar (or a stack) is wider.
  const bw = stacked || k === 1 ? Math.min(40, slot * 0.56) : Math.min(22, (slot * 0.7) / k);
  const Y = (v: number) => 8 + (1 - Math.max(0, v) / max) * (h - 34);
  const base = Y(0);
  const highlight = new Set(spec.highlight ?? []);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 56))));
  const fillFor = (si: number, i: number) =>
    k > 1
      ? SERIES_FILL[si]!
      : highlight.size && !highlight.has(i)
        ? "var(--chart-neutral-2)"
        : "var(--accent)";
  return (
    <div ref={ref} className="relative flex flex-col gap-2">
      <Legend items={spec.series.map((s, si) => ({ name: s.name, color: SERIES_FILL[si] }))} />
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="group"
          aria-label={chartSummary(spec, f.full)}
          className="block overflow-visible"
          onKeyDown={datapointKeys(n, hover, setHover)}
        >
          {ticks(max).map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" />
              <text x={0} y={Y(t) + 4} className="fill-faint font-mono text-[10.5px]">
                {f.short(t)}
              </text>
            </g>
          ))}
          {spec.x.map((label, i) => {
            const cx = PAD_L + slot * i + slot / 2;
            let acc = 0;
            return (
              <g
                key={i}
                tabIndex={0}
                role="img"
                aria-label={`${label}: ${spec.series.map((s) => `${s.name} ${s.values[i] === null ? "—" : f.full(s.values[i]!)}`).join(", ")}${stacked ? ` (${f.full(totals[i]!)})` : ""}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              >
                <rect x={cx - slot / 2} y={0} width={slot} height={h} fill="transparent" />
                {spec.series.map((s, si) => {
                  const v = s.values[i];
                  if (v === null || v === undefined) return null;
                  const x = stacked || k === 1 ? cx - bw / 2 : cx - (k * bw) / 2 + si * bw;
                  const bottom = stacked ? acc : 0;
                  if (stacked) acc += Math.max(0, v);
                  const top = stacked ? acc : v;
                  return (
                    <motion.rect
                      key={si}
                      x={x + (stacked || k === 1 ? 0 : 1)}
                      width={stacked || k === 1 ? bw : bw - 2}
                      rx={stacked ? 1.5 : 3}
                      fill={fillFor(si, i)}
                      initial={reduced ? false : { y: Y(bottom), height: 0 }}
                      animate={{ y: Y(top), height: Math.max(1, Y(bottom) - Y(top)) }}
                      transition={CHART_IN}
                    />
                  );
                })}
                {(highlight.has(i) || n <= 6) && (stacked || k === 1) && (
                  <text
                    x={cx}
                    y={Y(stacked ? totals[i]! : (spec.series[0]!.values[i] ?? 0)) - 6}
                    textAnchor="middle"
                    className={cn(
                      "font-mono text-[11px]",
                      highlight.has(i) ? "fill-fg" : "fill-muted",
                    )}
                  >
                    {f.short(stacked ? totals[i]! : (spec.series[0]!.values[i] ?? 0))}
                  </text>
                )}
                {(i % labelEvery === 0 || highlight.has(i)) && (
                  <text
                    x={cx}
                    y={h - 4}
                    textAnchor="middle"
                    className="fill-faint font-mono text-[10.5px]"
                  >
                    {label}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={PAD_L} x2={w} y1={base} y2={base} stroke="var(--axis)" />
          {spec.target && (
            <g>
              <line
                x1={PAD_L}
                x2={w}
                y1={Y(spec.target.value)}
                y2={Y(spec.target.value)}
                stroke="var(--fg-muted)"
                strokeDasharray="4 4"
              />
              {spec.target.label && (
                <text
                  x={w}
                  y={Y(spec.target.value) - 6}
                  textAnchor="end"
                  className="fill-muted font-mono text-[10.5px]"
                >
                  {spec.target.label}
                </text>
              )}
            </g>
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <Tip
          x={PAD_L + slot * hover + slot / 2}
          y={
            Y(
              stacked
                ? totals[hover]!
                : Math.max(0, ...spec.series.map((s) => s.values[hover] ?? 0)),
            ) + 30
          }
          width={w}
        >
          <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted uppercase">
            {spec.x[hover]}
          </p>
          {spec.series.map((s) => (
            <p key={s.name} className="flex justify-between gap-3">
              <span className="text-muted">{s.name}</span>
              <span className="font-mono text-fg">
                {s.values[hover] === null ? "—" : f.full(s.values[hover]!)}
              </span>
            </p>
          ))}
        </Tip>
      )}
    </div>
  );
}

// ── Ranked bars, distribution, diverging, progress ───────────────────────────

export function HBars({ spec }: { spec: Spec<"hbar"> }) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const reduced = useReducedMotion();
  const max = niceMax(Math.max(...spec.rows.map((r) => r.value)));
  const hl = new Set(spec.highlight ?? []);
  return (
    <ul className="flex flex-col gap-2">
      {spec.rows.map((r) => {
        const source = r.source !== undefined ? spec.sources?.[r.source] : undefined;
        return (
          <li
            key={r.label}
            tabIndex={0}
            aria-label={`${r.label}: ${f.full(r.value)}${r.uncertain ? `, ${t.canvas.viz.uncertain}` : ""}${source ? `. ${t.canvas.viz.source}: ${source.title}` : ""}`}
            className="grid grid-cols-[minmax(72px,32%)_minmax(0,1fr)_auto] items-center gap-3 rounded text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span className={cn("truncate", hl.has(r.label) ? "font-medium text-fg" : "text-fg2")}>
              {r.label}
            </span>
            <span className="relative h-4" aria-hidden>
              <motion.span
                className={cn(
                  "absolute inset-y-0 left-0 origin-left rounded-[3px]",
                  r.uncertain && "border-2 border-dashed border-[var(--accent)] bg-transparent",
                )}
                style={{
                  width: `${Math.max(0.5, (r.value / max) * 100)}%`,
                  ...(r.uncertain
                    ? {}
                    : {
                        background:
                          hl.size && !hl.has(r.label) ? "var(--chart-neutral-2)" : "var(--accent)",
                      }),
                }}
                initial={reduced ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={CHART_IN}
              />
            </span>
            <span className="text-right font-mono text-[12px] text-fg">
              {f.full(r.value)}
              {r.source !== undefined && (
                <sup className="ml-0.5 text-[9.5px] text-faint">{r.source + 1}</sup>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function Distribution({ spec }: { spec: Spec<"distribution"> }) {
  const f = useNumberFormat(spec.format);
  const total = spec.rows.reduce((n, r) => n + r.value, 0) || 1;
  const hl = new Set(spec.highlight ?? []);
  // Neutral steps by share; the highlighted category takes the accent.
  const steps = [0.5, 0.36, 0.26, 0.18, 0.12, 0.08, 0.06];
  const fill = (i: number, label: string) =>
    hl.has(label)
      ? "var(--accent)"
      : `color-mix(in srgb, var(--fg) ${Math.round(steps[Math.min(i, steps.length - 1)]! * 100)}%, transparent)`;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="img"
        aria-label={spec.rows
          .map((r) => `${r.label} ${Math.round((r.value / total) * 100)}%`)
          .join(", ")}
        className="flex h-3.5 gap-0.5"
      >
        {spec.rows.map((r, i) => (
          <span
            key={r.label}
            className="rounded-[3px]"
            style={{ flexGrow: r.value / total, flexBasis: 0, background: fill(i, r.label) }}
          />
        ))}
      </div>
      <ul className="flex flex-col">
        {spec.rows.map((r, i) => (
          <li
            key={r.label}
            className="grid min-h-[30px] grid-cols-[14px_minmax(0,1fr)_auto_44px] items-center gap-2.5 border-t border-[var(--sf-ambient-line)] text-[13px]"
          >
            <span
              className="size-2.5 rounded-[3px]"
              style={{ background: fill(i, r.label) }}
              aria-hidden
            />
            <span className={cn("truncate", hl.has(r.label) ? "font-medium text-fg" : "text-fg2")}>
              {r.label}
            </span>
            <span className="text-right font-mono text-[12px]">{f.full(r.value)}</span>
            <span className="text-right font-mono text-[11.5px] text-muted">
              {Math.round((r.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Diverging({ spec }: { spec: Spec<"diverging"> }) {
  const f = useNumberFormat(spec.format);
  const max = Math.max(...spec.rows.map((r) => Math.abs(r.value))) || 1;
  const hl = new Set(spec.highlight ?? []);
  const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
  return (
    <div className="flex flex-col gap-1.5">
      <ul className="flex flex-col gap-1.5">
        {spec.rows.map((r) => {
          const color = hl.has(r.label) ? "var(--accent)" : "var(--chart-neutral-2)";
          return (
            <li
              key={r.label}
              className="grid min-h-[26px] grid-cols-[minmax(72px,26%)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center text-[13px]"
            >
              <span
                className={cn(
                  "truncate pr-2",
                  hl.has(r.label) ? "font-medium text-fg" : "text-fg2",
                )}
              >
                {r.label}
              </span>
              <span
                className="flex h-[26px] items-center justify-end border-r border-border-strong"
                aria-hidden
              >
                {r.value < 0 && (
                  <span
                    className="h-2.5 rounded-l"
                    style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: color }}
                  />
                )}
              </span>
              <span className="flex h-[26px] items-center" aria-hidden>
                {r.value > 0 && (
                  <span
                    className="h-2.5 rounded-r"
                    style={{ width: `${(r.value / max) * 100}%`, background: color }}
                  />
                )}
              </span>
              <span
                className={cn(
                  "pl-3 text-right font-mono text-[12px]",
                  hl.has(r.label) ? "text-fg" : "text-muted",
                )}
              >
                {sign(r.value)}
                {f.full(Math.abs(r.value))}
              </span>
            </li>
          );
        })}
      </ul>
      <p
        aria-hidden
        className="grid grid-cols-[minmax(72px,26%)_minmax(0,1fr)_minmax(0,1fr)_auto] font-mono text-[10px] tracking-[0.06em] text-faint uppercase"
      >
        <span />
        <span className="pr-2 text-right">← {spec.negativeLabel}</span>
        <span className="pl-2">{spec.positiveLabel} →</span>
        <span />
      </p>
    </div>
  );
}

export function Progress({ spec, thick }: { spec: Spec<"progress">; thick: boolean }) {
  const reduced = useReducedMotion();
  const { t } = useI18n();
  return (
    <ul className={cn("flex flex-col", thick ? "gap-4" : "gap-3")}>
      {spec.rows.map((r) => (
        <li key={r.label} className="flex flex-col gap-1.5">
          <p className="flex justify-between gap-3 text-[13px]">
            <span className="truncate text-fg2">{r.label}</span>
            <span
              className={cn(
                "shrink-0 font-mono text-[11px]",
                r.flag ? "text-approval-text" : "text-muted",
              )}
            >
              {r.state ?? `${Math.round(r.value * 100)}%`}
              {r.flag && <span className="sr-only">, {t.canvas.viz.behindPace}</span>}
            </span>
          </p>
          <span className={cn("relative rounded bg-track", thick ? "h-2" : "h-1")} aria-hidden>
            <motion.span
              className={cn("block origin-left rounded", thick ? "h-2" : "h-1")}
              style={{
                width: `${r.value * 100}%`,
                background: r.flag ? "var(--approval)" : "var(--accent)",
              }}
              initial={reduced ? false : { scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={CHART_IN}
            />
            {r.pace !== undefined && (
              <span
                className={cn("absolute w-0.5 bg-fg2", thick ? "-top-1 h-4" : "-top-[3px] h-2.5")}
                style={{ left: `${r.pace * 100}%` }}
              />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

const DAY_STYLE = {
  done: "bg-accent border-accent",
  miss: "border-border-strong",
  today: "border-accent border-dashed",
  future: "border-border border-dotted",
  rest: "bg-track border-transparent",
} as const;

export function Streak({ spec }: { spec: Spec<"streak"> }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 overflow-x-auto">
      <div
        aria-hidden
        className="grid grid-cols-[minmax(110px,1fr)_repeat(7,24px)_84px] gap-x-1.5 pb-1.5 font-mono text-[10px] text-faint"
      >
        <span />
        {spec.days.map((d, i) => (
          <span key={i} className={cn("text-center", i === spec.today && "text-accent-text")}>
            {d}
          </span>
        ))}
        <span />
      </div>
      {spec.rows.map((r) => (
        <div
          key={r.label}
          role="group"
          aria-label={`${r.label}: ${r.summary}${r.state ? `, ${r.state}` : ""}`}
          className="grid min-h-12 grid-cols-[minmax(110px,1fr)_repeat(7,24px)_84px] items-center gap-x-1.5 border-t border-[var(--sf-ambient-line)]"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px]">{r.label}</span>
            {r.meta && <span className="truncate text-[12px] text-muted">{r.meta}</span>}
          </span>
          {r.days.map((d, i) => (
            <span
              key={i}
              title={t.canvas.viz.days[d]}
              className={cn(
                "size-[18px] justify-self-center rounded-full border-[1.5px]",
                DAY_STYLE[d],
              )}
            />
          ))}
          <span className="flex flex-col items-end">
            <span className="font-mono text-[12.5px]">{r.summary}</span>
            {r.state && (
              <span className={cn("text-[11.5px]", r.behind ? "text-approval-text" : "text-muted")}>
                {r.state}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

export function DataTable({ spec }: { spec: Spec<"table"> }) {
  const f = useNumberFormat(spec.format);
  const cell = (v: string, numeric?: boolean) => {
    if (!numeric) return v;
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== "" ? f.full(n) : v;
  };
  return (
    <div className="flex flex-col">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border">
            {spec.columns.map((c) => (
              <th
                key={c.label}
                scope="col"
                className={cn(
                  "pb-2 font-mono text-[10.5px] font-normal tracking-[0.1em] text-faint uppercase",
                  c.numeric ? "text-right" : "text-left",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr
              key={i}
              className={cn(
                "h-9 border-b border-[var(--sf-ambient-line)]",
                i === spec.highlightRow && "bg-accent-soft",
              )}
            >
              {r.map((v, j) => (
                <td
                  key={j}
                  className={cn(
                    "max-w-0 truncate pr-3 last:pr-0",
                    spec.columns[j]?.numeric ? "text-right font-mono text-[12.5px]" : "",
                    j === 0 || i === spec.highlightRow ? "text-fg" : "text-fg2",
                  )}
                >
                  {cell(v, spec.columns[j]?.numeric)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {spec.note && <p className="mt-2 text-[12px] text-faint">{spec.note}</p>}
    </div>
  );
}

/** The same numbers as a table: the text equivalent of every series chart. */
export function SeriesTable({ spec }: { spec: Spec<"line" | "area" | "bar"> }) {
  const f = useNumberFormat(spec.format);
  return (
    <div className="max-h-[360px] overflow-y-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border">
            <th
              scope="col"
              className="pb-2 text-left font-mono text-[10.5px] font-normal tracking-[0.1em] text-faint uppercase"
            >
              {spec.title}
            </th>
            {spec.series.map((s) => (
              <th
                key={s.name}
                scope="col"
                className="pb-2 text-right font-mono text-[10.5px] font-normal tracking-[0.1em] text-faint uppercase"
              >
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.x.map((x, i) => (
            <tr key={i} className="h-8 border-b border-[var(--sf-ambient-line)]">
              <th scope="row" className="text-left font-normal text-fg2">
                {x}
              </th>
              {spec.series.map((s) => (
                <td key={s.name} className="text-right font-mono text-[12.5px]">
                  {s.values[i] === null ? "—" : f.full(s.values[i]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One sentence a screen reader hears for a series chart. */
function chartSummary(spec: Spec<"line" | "area" | "bar">, fmt: (v: number) => string) {
  return `${spec.title}. ${spec.series
    .map((s) => {
      const vals = s.values.filter((v): v is number => v !== null);
      if (!vals.length) return s.name;
      const hi = Math.max(...vals);
      const lo = Math.min(...vals);
      return `${s.name}: ${spec.x[0]} ${fmt(s.values.find((v) => v !== null)!)} → ${spec.x.at(-1)} ${fmt(vals.at(-1)!)}; max ${fmt(hi)}, min ${fmt(lo)}`;
    })
    .join(". ")}`;
}
