"use client";

import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";

import type { VisualizationSpec } from "@/core/workspace/visualization";
import { useElementSize } from "@/hooks/use-element-size";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { datapointKeys, domain, niceStep, SERIES_FILL, Tip, useNumberFormat } from "./charts";
import { CHART_IN } from "../canvas/motion";

/**
 * Conventional charts (ADR-029): donut, scatter, histogram, waterfall and candlestick — the
 * familiar forms people read at a glance, drawn in ELISE's tokens. Every mark is reachable by
 * keyboard with its exact value; colour is never the only signal (labels, shape, position).
 */

type Spec<T extends VisualizationSpec["type"]> = Extract<VisualizationSpec, { type: T }>;

const PAD_L = 44;

// ── Donut ────────────────────────────────────────────────────────────────────

/** Parts of a true whole: a ring with the total inside, and every part labelled with its share. */
export function DonutChart({ spec }: { spec: Spec<"donut"> }) {
  const { t } = useI18n();
  const f = useNumberFormat(spec.format);
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const total = spec.rows.reduce((n, r) => n + r.value, 0) || 1;
  const R = 52;
  const C = 2 * Math.PI * R;
  // Where each slice starts on the ring (cumulative), computed once.
  const starts = spec.rows.map((_, i) =>
    spec.rows.slice(0, i).reduce((acc, r) => acc + (r.value / total) * C, 0),
  );
  const fill = (i: number) =>
    SERIES_FILL[i] ?? `color-mix(in srgb, var(--fg) ${30 - i * 4}%, transparent)`;
  const focus = hover !== null ? spec.rows[hover] : null;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        viewBox="0 0 140 140"
        className="size-[132px] shrink-0"
        role="img"
        aria-label={spec.rows
          .map((r) => `${r.label} ${f.full(r.value)} (${Math.round((r.value / total) * 100)}%)`)
          .join(", ")}
      >
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--track)" strokeWidth="16" />
        {spec.rows.map((r, i) => {
          const len = (r.value / total) * C;
          const dash = `${Math.max(0, len - 1.5)} ${C}`;
          return (
            <motion.circle
              key={r.label}
              cx="70"
              cy="70"
              r={R}
              fill="none"
              stroke={fill(i)}
              strokeWidth={hover === i ? 19 : 16}
              strokeDasharray={dash}
              strokeDashoffset={-starts[i]!}
              transform="rotate(-90 70 70)"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={CHART_IN}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
        <text x="70" y="66" textAnchor="middle" className="fill-muted font-mono text-[9px]">
          {focus ? focus.label.slice(0, 16) : t.canvas.viz.total}
        </text>
        <text x="70" y="82" textAnchor="middle" className="fill-fg font-mono text-[13px]">
          {f.short(focus ? focus.value : total)}
        </text>
      </svg>
      <ul className="flex min-w-[180px] flex-1 flex-col">
        {spec.rows.map((r, i) => (
          <li
            key={r.label}
            tabIndex={0}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            className={cn(
              "grid min-h-[30px] grid-cols-[12px_minmax(0,1fr)_auto_42px] items-center gap-2.5 rounded border-t border-[var(--sf-ambient-line)] text-[13px] outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-accent",
              hover === i && "bg-[var(--surface-2)]",
            )}
          >
            <span className="size-2.5 rounded-[3px]" style={{ background: fill(i) }} aria-hidden />
            <span className="truncate text-fg2">{r.label}</span>
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

// ── Scatter ──────────────────────────────────────────────────────────────────

export function ScatterChart({ spec, height }: { spec: Spec<"scatter">; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const fy = useNumberFormat(spec.format);
  const fx = useNumberFormat(spec.xFormat);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(160, width);
  const h = height;
  const dx = domain(
    spec.points.map((p) => p.x),
    false,
  );
  const dy = domain(
    spec.points.map((p) => p.y),
    false,
  );
  const X = (v: number) => PAD_L + ((v - dx.lo) / (dx.hi - dx.lo || 1)) * (w - PAD_L - 10);
  const Y = (v: number) => 8 + (1 - (v - dy.lo) / (dy.hi - dy.lo || 1)) * (h - 40);
  const xTicks = dx.ticks.filter(
    (_, i) => i % Math.max(1, Math.ceil(dx.ticks.length / Math.max(2, Math.floor(w / 70)))) === 0,
  );
  const p = hover !== null ? spec.points[hover] : null;
  return (
    <div ref={ref} className="relative flex flex-col gap-1">
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="group"
          aria-label={`${spec.yLabel} vs ${spec.xLabel}`}
          className="block overflow-visible"
          onKeyDown={datapointKeys(spec.points.length, hover, setHover)}
        >
          {dy.ticks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD_L} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" />
              <text x={0} y={Y(t) + 4} className="fill-faint font-mono text-[10.5px]">
                {fy.short(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={`x${t}`}
              x={X(t)}
              y={h - 18}
              textAnchor="middle"
              className="fill-faint font-mono text-[10.5px]"
            >
              {fx.short(t)}
            </text>
          ))}
          <text x={w} y={h - 2} textAnchor="end" className="fill-muted text-[11px]">
            {spec.xLabel} →
          </text>
          {spec.points.map((pt, i) => (
            <circle
              key={i}
              cx={X(pt.x)}
              cy={Y(pt.y)}
              r={hover === i ? 6 : 4.5}
              tabIndex={0}
              role="img"
              aria-label={`${pt.label ? `${pt.label}: ` : ""}${spec.xLabel} ${fx.full(pt.x)}, ${spec.yLabel} ${fy.full(pt.y)}`}
              fill="var(--accent)"
              fillOpacity={hover === null || hover === i ? 0.8 : 0.35}
              stroke="var(--bg)"
              strokeWidth={1}
              className="outline-none"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
      )}
      {p && (
        <Tip x={X(p.x)} y={Y(p.y) + 30} width={w}>
          {p.label && <p className="truncate text-fg">{p.label}</p>}
          <p className="flex justify-between gap-3">
            <span className="text-muted">{spec.xLabel}</span>
            <span className="font-mono">{fx.full(p.x)}</span>
          </p>
          <p className="flex justify-between gap-3">
            <span className="text-muted">{spec.yLabel}</span>
            <span className="font-mono">{fy.full(p.y)}</span>
          </p>
        </Tip>
      )}
    </div>
  );
}

// ── Histogram ────────────────────────────────────────────────────────────────

export function HistogramChart({ spec, height }: { spec: Spec<"histogram">; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const reduced = useReducedMotion();
  const f = useNumberFormat(spec.format);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(160, width);
  const h = height;
  const n = spec.bins.length;
  const maxCount = Math.max(...spec.bins.map((b) => b.count), 1);
  const step = niceStep(maxCount);
  const top = Math.ceil(maxCount / step) * step;
  const slot = (w - PAD_L) / n;
  const Y = (v: number) => 8 + (1 - v / top) * (h - 34);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));
  const b = hover !== null ? spec.bins[hover] : null;
  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="group"
          aria-label={spec.bins
            .map((x) => `${f.full(x.from)}–${f.full(x.to)}: ${x.count}`)
            .join(", ")}
          className="block overflow-visible"
          onKeyDown={datapointKeys(n, hover, setHover)}
        >
          {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" />
              <text x={0} y={Y(t) + 4} className="fill-faint font-mono text-[10.5px]">
                {t}
              </text>
            </g>
          ))}
          {spec.bins.map((bin, i) => (
            <g
              key={i}
              tabIndex={0}
              role="img"
              aria-label={`${f.full(bin.from)}–${f.full(bin.to)}: ${bin.count}`}
              className="outline-none"
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            >
              <motion.rect
                x={PAD_L + slot * i + 0.5}
                width={Math.max(1, slot - 1)}
                rx={1.5}
                fill={
                  hover === i ? "var(--accent)" : "color-mix(in srgb, var(--accent) 70%, var(--bg))"
                }
                initial={reduced ? false : { y: Y(0), height: 0 }}
                animate={{ y: Y(bin.count), height: Math.max(0, Y(0) - Y(bin.count)) }}
                transition={CHART_IN}
              />
              {(i % every === 0 || i === n - 1) && (
                <text
                  x={PAD_L + slot * i}
                  y={h - 4}
                  textAnchor="middle"
                  className="fill-faint font-mono text-[10.5px]"
                >
                  {f.short(bin.from)}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      {b && (
        <Tip x={PAD_L + slot * hover! + slot / 2} y={Y(b.count) + 30} width={w}>
          <p className="font-mono text-[11px] text-muted">
            {f.full(b.from)} – {f.full(b.to)}
          </p>
          <p className="font-mono text-fg">
            {b.count} {spec.unitLabel ?? ""}
          </p>
        </Tip>
      )}
    </div>
  );
}

// ── Waterfall ────────────────────────────────────────────────────────────────

/** Each step's [from, to]: totals stand on zero, changes float from the running total. */
export function waterfallBars<T extends { value: number; kind: "start" | "delta" | "end" }>(
  steps: T[],
): (T & { from: number; to: number })[] {
  const out: (T & { from: number; to: number })[] = [];
  for (const st of steps) {
    const before = out.at(-1)?.to ?? 0;
    out.push(
      st.kind === "delta"
        ? { ...st, from: before, to: before + st.value }
        : { ...st, from: 0, to: st.value },
    );
  }
  return out;
}

/** From a start to an end through additive changes: each bar floats from the running total. */
export function WaterfallChart({ spec, height }: { spec: Spec<"waterfall">; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const reduced = useReducedMotion();
  const f = useNumberFormat(spec.format);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(160, width);
  const h = height;
  const bars = waterfallBars(spec.steps);
  const d = domain(
    bars.flatMap((b) => [b.from, b.to]),
    true,
  );
  const n = bars.length;
  const slot = (w - PAD_L) / n;
  const bw = Math.min(44, slot * 0.6);
  const Y = (v: number) => 8 + (1 - (v - d.lo) / (d.hi - d.lo || 1)) * (h - 34);
  const color = (b: (typeof bars)[number]) =>
    b.kind !== "delta"
      ? "var(--chart-neutral)"
      : b.value >= 0
        ? "var(--accent)"
        : "var(--approval-line)";
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));
  const cur = hover !== null ? bars[hover] : null;
  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="group"
          aria-label={bars
            .map(
              (b) => `${b.label} ${b.kind === "delta" && b.value > 0 ? "+" : ""}${f.full(b.value)}`,
            )
            .join(", ")}
          className="block overflow-visible"
          onKeyDown={datapointKeys(n, hover, setHover)}
        >
          {d.ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={w} y1={Y(t)} y2={Y(t)} stroke="var(--gridline)" />
              <text x={0} y={Y(t) + 4} className="fill-faint font-mono text-[10.5px]">
                {f.short(t)}
              </text>
            </g>
          ))}
          {bars.map((b, i) => {
            const cx = PAD_L + slot * i + slot / 2;
            const y0 = Y(Math.max(b.from, b.to));
            const y1 = Y(Math.min(b.from, b.to));
            return (
              <g
                key={i}
                tabIndex={0}
                role="img"
                aria-label={`${b.label}: ${b.kind === "delta" && b.value > 0 ? "+" : ""}${f.full(b.value)}`}
                className="outline-none"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <motion.rect
                  x={cx - bw / 2}
                  width={bw}
                  rx={2}
                  fill={color(b)}
                  initial={reduced ? false : { y: y1, height: 0 }}
                  animate={{ y: y0, height: Math.max(1, y1 - y0) }}
                  transition={CHART_IN}
                />
                {i < n - 1 && (
                  <line
                    x1={cx + bw / 2}
                    x2={cx + slot - bw / 2}
                    y1={Y(b.to)}
                    y2={Y(b.to)}
                    stroke="var(--fg-muted)"
                    strokeDasharray="2 2"
                  />
                )}
                <text
                  x={cx}
                  y={y0 - 5}
                  textAnchor="middle"
                  className="fill-muted font-mono text-[10.5px]"
                >
                  {b.kind === "delta" && b.value > 0 ? "+" : ""}
                  {f.short(b.value)}
                </text>
                {(i % every === 0 || i === n - 1) && (
                  <text x={cx} y={h - 4} textAnchor="middle" className="fill-faint text-[10.5px]">
                    {b.label.length > 12 ? `${b.label.slice(0, 11)}…` : b.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {cur && (
        <Tip x={PAD_L + slot * hover! + slot / 2} y={Y(Math.max(cur.from, cur.to)) + 30} width={w}>
          <p className="truncate text-fg">{cur.label}</p>
          <p className="font-mono">
            {cur.kind === "delta" && cur.value > 0 ? "+" : ""}
            {f.full(cur.value)}
          </p>
        </Tip>
      )}
    </div>
  );
}

// ── Candlestick ──────────────────────────────────────────────────────────────

/** Real open/high/low/close per period: a wick for the range, a body from open to close. */
export function CandlestickChart({ spec, height }: { spec: Spec<"candlestick">; height: number }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(ref);
  const f = useNumberFormat(spec.format);
  const [hover, setHover] = useState<number | null>(null);
  const w = Math.max(160, width);
  const h = height;
  const d = domain(
    spec.ohlc.flatMap((c) => [c.low, c.high]),
    false,
  );
  const n = spec.x.length;
  const slot = (w - PAD_L) / n;
  const bw = Math.max(2, Math.min(14, slot * 0.6));
  const Y = (v: number) => 8 + (1 - (v - d.lo) / (d.hi - d.lo || 1)) * (h - 34);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 70))));
  const c = hover !== null ? spec.ohlc[hover] : null;
  const o = t.canvas.viz.ohlc;
  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={w}
          height={h}
          role="group"
          aria-label={spec.title}
          className="block overflow-visible"
          onKeyDown={datapointKeys(n, hover, setHover)}
        >
          {d.ticks.map((tk) => (
            <g key={tk}>
              <line x1={PAD_L} x2={w} y1={Y(tk)} y2={Y(tk)} stroke="var(--gridline)" />
              <text x={0} y={Y(tk) + 4} className="fill-faint font-mono text-[10.5px]">
                {f.short(tk)}
              </text>
            </g>
          ))}
          {spec.ohlc.map((k, i) => {
            const cx = PAD_L + slot * i + slot / 2;
            const up = k.close >= k.open;
            return (
              <g
                key={i}
                tabIndex={0}
                role="img"
                aria-label={`${spec.x[i]}: ${o.open} ${f.full(k.open)}, ${o.high} ${f.full(k.high)}, ${o.low} ${f.full(k.low)}, ${o.close} ${f.full(k.close)}`}
                className="outline-none"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <rect x={cx - slot / 2} y={0} width={slot} height={h} fill="transparent" />
                <line x1={cx} x2={cx} y1={Y(k.high)} y2={Y(k.low)} stroke="var(--fg-muted)" />
                {/* Up: filled accent; down: hollow — direction never depends on colour alone. */}
                <rect
                  x={cx - bw / 2}
                  y={Y(Math.max(k.open, k.close))}
                  width={bw}
                  height={Math.max(1, Math.abs(Y(k.open) - Y(k.close)))}
                  fill={up ? "var(--accent)" : "var(--bg)"}
                  stroke={up ? "var(--accent)" : "var(--fg-muted)"}
                />
                {(i % every === 0 || i === n - 1) && (
                  <text
                    x={cx}
                    y={h - 4}
                    textAnchor="middle"
                    className="fill-faint font-mono text-[10.5px]"
                  >
                    {spec.x[i]}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {c && (
        <Tip x={PAD_L + slot * hover! + slot / 2} y={Y(c.high) + 30} width={w}>
          <p className="font-mono text-[10.5px] text-muted uppercase">{spec.x[hover!]}</p>
          {(["open", "high", "low", "close"] as const).map((key) => (
            <p key={key} className="flex justify-between gap-3">
              <span className="text-muted">{o[key]}</span>
              <span className="font-mono">{f.full(c[key])}</span>
            </p>
          ))}
        </Tip>
      )}
    </div>
  );
}
