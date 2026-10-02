"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { TemporalItem } from "./composition";
import { EASE } from "./motion";

/** Node shapes by kind: identity never relies on colour (reference temporal nodes). */
const NODE: Record<TemporalItem["kind"], string> = {
  meeting: "size-3 rounded-full",
  event: "size-3 rounded-full",
  email: "size-[11px] rounded-[3px]",
  document: "h-[13px] w-[9px] rounded-[2px]",
  task: "size-[11px] rounded-[4px]",
  recall: "size-2.5 rotate-45 rounded-[1px]",
  news: "size-3 rounded-full",
  record: "size-3 rounded-full",
};

/**
 * Temporal (ADR-021): what happened, in order. Desktop lays dated items along one axis,
 * alternating above and below with a NOW marker; phones read it as a vertical timeline.
 * Positions are ordinal (evenly spaced), so nothing collides; each card carries its own date.
 * Every item opens its Surface in Focus, and coming back restores the same scroll.
 */
export function TemporalView({
  items,
  timezone,
  vertical,
  onOpen,
  scroll,
  labelFor,
}: {
  items: TemporalItem[];
  timezone: string;
  vertical: boolean;
  onOpen: (item: TemporalItem) => void;
  /** Kept by the canvas so Focus → Back returns to the same place on the timeline. */
  scroll: { current: number };
  labelFor: (kind: TemporalItem["kind"]) => string;
}) {
  const { t, locale } = useI18n();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
  });
  const when = (at: string) =>
    at.length === 10
      ? day.format(new Date(`${at}T12:00:00Z`))
      : `${day.format(new Date(at))} · ${time.format(new Date(at))}`;
  const nowIndex = items.findIndex((i) => i.upcoming);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (vertical) window.scrollTo({ top: scroll.current });
    else el.scrollLeft = scroll.current || el.scrollWidth;
  }, [vertical, scroll]);
  useEffect(() => {
    const el = ref.current;
    if (!el || vertical) return;
    const save = () => (scroll.current = el.scrollLeft);
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [vertical, scroll]);

  const card = (it: TemporalItem, i: number) => (
    <button
      type="button"
      onClick={() => {
        if (vertical) scroll.current = window.scrollY;
        onOpen(it);
      }}
      className={cn(
        "sf flex w-full min-w-0 flex-col gap-1.5 rounded-2xl px-4 py-3 text-left transition-colors hover:border-accent-line",
        it.upcoming && "border-dashed",
      )}
      data-tier={i === nowIndex - 1 ? "primary" : "secondary"}
    >
      <span className="type-eyebrow text-faint">
        {labelFor(it.kind)} · {when(it.at)}
      </span>
      <span className="line-clamp-2 text-[14px] leading-[1.35] font-medium">{it.title}</span>
      {it.detail && <span className="line-clamp-1 text-[12.5px] text-muted">{it.detail}</span>}
    </button>
  );

  if (vertical)
    return (
      <ol ref={ref as never} aria-label={t.canvas.compositions.temporal} className="flex flex-col">
        {items.map((it, i) => (
          <li
            key={`${it.surfaceId}:${it.item}:${i}`}
            className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-3"
          >
            <span className="relative flex justify-center">
              <span aria-hidden className="absolute inset-y-0 left-2 w-px bg-border" />
              <span
                aria-hidden
                className={cn(
                  "relative mt-4 border-[1.5px]",
                  NODE[it.kind],
                  it.upcoming ? "border-accent bg-bg" : "border-border-strong bg-page",
                )}
              />
            </span>
            <div className="pb-3">{card(it, i)}</div>
          </li>
        ))}
      </ol>
    );

  const col = 228;
  return (
    <div ref={ref} className="-mx-2 [scrollbar-width:thin] overflow-x-auto px-2 pb-2">
      <ol
        aria-label={t.canvas.compositions.temporal}
        className="relative grid min-h-[520px] items-center"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(${col}px, 1fr))` }}
      >
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-axis" />
        {items.map((it, i) => {
          const above = i % 2 === 0;
          return (
            <motion.li
              key={`${it.surfaceId}:${it.item}:${i}`}
              initial={reduced ? false : { opacity: 0, y: above ? 10 : -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.32,
                ease: EASE,
                delay: reduced ? 0 : Math.min(i, 8) * 0.04,
              }}
              className="relative flex h-full flex-col px-2"
            >
              {i === nowIndex && (
                <span
                  aria-hidden
                  className="absolute top-1/2 -left-px z-10 flex -translate-y-1/2 flex-col items-center"
                >
                  <span className="mb-1 font-mono text-[10px] tracking-[0.14em] text-accent-text">
                    {t.canvas.now}
                  </span>
                  <span className="h-14 w-0.5 rounded bg-accent" />
                </span>
              )}
              <div
                className={cn(
                  "flex flex-1 flex-col",
                  above ? "justify-end pb-9" : "order-2 justify-start pt-9",
                )}
              >
                {card(it, i)}
              </div>
              <span
                aria-hidden
                className={cn(
                  "absolute left-1/2 w-px bg-axis",
                  above ? "top-[calc(50%-36px)] h-9" : "top-1/2 h-9",
                )}
              />
              <span
                aria-hidden
                className={cn(
                  "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-[1.5px]",
                  NODE[it.kind],
                  it.upcoming ? "border-accent bg-bg" : "border-axis bg-page",
                )}
              />
            </motion.li>
          );
        })}
      </ol>
    </div>
  );
}
