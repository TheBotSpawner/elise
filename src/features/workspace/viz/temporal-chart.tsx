"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { matches, parseWhen } from "@/core/workspace/temporal-planner";
import type { TemporalKind, VisualizationSpec } from "@/core/workspace/visualization";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { ChartSize } from "./charts";

/**
 * Temporal Surface body (ADR-028): the planner chose the view from the dates' density; this
 * draws it. Dates are wall-clock values from the source, formatted in UTC so they never shift.
 * Kind is told by shape (not colour), importance by weight, and every event opens its details
 * and source passage on demand. A focus narrows what's shown without losing the rest.
 */

type Spec = Extract<VisualizationSpec, { type: "temporal" }>;
type Event = Spec["events"][number];
type Indexed = { e: Event; i: number };

const DAY = 86_400_000;
const at = (s: string) => parseWhen(s)?.at ?? 0;
const endAt = (e: Event) => {
  const v = e.end ?? e.start;
  const p = parseWhen(v);
  if (!p) return 0;
  if (p.precision === "month") {
    const d = new Date(p.at);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
  }
  return p.precision === "day" ? p.at + DAY - 1 : p.at;
};

/** Node shape by kind: subtle, and never colour alone. */
const NODE: Record<TemporalKind, string> = {
  exam: "size-2.5 rotate-45 rounded-[1px]",
  deadline: "size-2.5 rounded-[2px]",
  delivery: "size-2.5 rounded-[2px]",
  start: "size-3 rounded-full",
  end: "size-3 rounded-full",
  meeting: "size-3 rounded-full",
  milestone: "size-3 rounded-full",
  holiday: "size-3 rounded-full border-dashed",
  break: "size-3 rounded-full border-dashed",
  general: "size-2 rounded-full",
};

function useDates() {
  const { locale } = useI18n();
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    const month = new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    });
    const sameDay = (a: string, b: string) => a.slice(0, 10) === b.slice(0, 10);
    /** "25 mar", "22–23 sep", "28 sep – 2 oct", "marzo de 2026", "25 mar · 09:30–11:00" (the
     * platform's own range formatting, per locale). */
    const label = (e: Event) => {
      const p = parseWhen(e.start)!;
      if (p.precision === "month")
        return e.end ? month.formatRange(p.at, at(e.end)) : month.format(p.at);
      if (p.precision === "time") {
        const end = e.end ? parseWhen(e.end) : null;
        const t = `${time.format(p.at)}${end && sameDay(e.start, e.end!) ? `–${time.format(end.at)}` : ""}`;
        return `${day.format(p.at)} · ${t}`;
      }
      return e.end ? day.formatRange(p.at, at(e.end)) : day.format(p.at);
    };
    return { day, month, weekday, time, label };
  }, [locale]);
}

export function TemporalChart({ spec, size }: { spec: Spec; size: ChartSize }) {
  const { t } = useI18n();
  const tt = t.canvas.viz.temporal;
  const [all, setAll] = useState(false);
  const indexed = spec.events.map((e, i) => ({ e, i }));
  const shown = all ? indexed : indexed.filter(({ e }) => matches(e, spec.focus));
  const hidden = spec.events.length - shown.length;
  const today = at(spec.today);
  return (
    <div className="flex flex-col gap-2">
      {spec.focus && (
        <p className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted">
          <span className="font-mono tracking-[0.08em] text-faint uppercase">{tt.showing}</span>
          {spec.focus.kinds?.map((k) => tt.kinds[k]).join(" · ")}
          {spec.focus.from && ` ${tt.from} ${spec.focus.from}`}
          {spec.focus.to && ` ${tt.to} ${spec.focus.to}`}
          {(hidden > 0 || all) && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="ml-auto underline-offset-2 hover:text-fg hover:underline"
            >
              {all ? tt.onlyFocus : tt.showAll(spec.events.length)}
            </button>
          )}
        </p>
      )}
      {!shown.length ? (
        <p className="text-[13px] text-muted">{tt.none}</p>
      ) : spec.view === "calendar" ? (
        <CalendarView spec={spec} items={shown} today={today} />
      ) : spec.view === "agenda" ? (
        <AgendaView spec={spec} items={shown} />
      ) : spec.view === "intervals" ? (
        <IntervalsView spec={spec} items={shown} today={today} />
      ) : (
        <TimelineView
          spec={spec}
          items={shown}
          today={today}
          rail={spec.view === "timeline"}
          limit={size === "small" ? 6 : 40}
        />
      )}
    </div>
  );
}

/** One event, expandable: details, recurrence, conflict and the source passage. */
function EventRow({
  spec,
  item,
  past,
  compact = false,
}: {
  spec: Spec;
  item: Indexed;
  past: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const tt = t.canvas.viz.temporal;
  const d = useDates();
  const [open, setOpen] = useState(false);
  const { e } = item;
  const source = e.source !== undefined ? spec.sources?.[e.source] : undefined;
  return (
    <div className={cn("min-w-0", past && "opacity-70")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--surface-2)] focus-visible:bg-[var(--surface-2)]"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          {!compact && (
            <span className="shrink-0 font-mono text-[12px] text-muted">{d.label(e)}</span>
          )}
          <span
            className={cn(
              "min-w-0 truncate text-[13.5px]",
              e.importance === "high" ? "font-medium text-fg" : "text-fg2",
              e.importance === "low" && "text-muted",
            )}
          >
            {e.title}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-faint">
          {tt.kinds[e.kind]}
          {e.recurrence && <span>· {e.recurrence}</span>}
          {e.uncertain && <span>· {t.canvas.viz.uncertain}</span>}
          {e.conflict && (
            <span className="rounded border border-approval-line bg-approval-bg px-1 text-approval-text">
              {tt.conflict}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-2 pb-2 text-[12px] text-muted">
          {e.detail && <p className="text-fg2">{e.detail}</p>}
          {source ? (
            <>
              <p>
                {t.canvas.viz.source}:{" "}
                {source.url ? (
                  <a
                    href={source.url}
                    {...(source.url.startsWith("https://")
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                    className="underline-offset-2 hover:text-fg hover:underline"
                  >
                    {source.title}
                  </a>
                ) : (
                  source.title
                )}
              </p>
              {source.excerpt && (
                <blockquote className="border-l-2 border-border pl-2 text-[11.5px] leading-[1.45] text-muted">
                  {source.excerpt}
                </blockquote>
              )}
            </>
          ) : (
            <p>{t.canvas.viz.source}: —</p>
          )}
        </div>
      )}
    </div>
  );
}

function Node({ e, past }: { e: Event; past: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative mt-[11px] shrink-0 border-[1.5px]",
        NODE[e.kind],
        e.importance === "high" && !past
          ? "border-accent bg-accent"
          : past
            ? "border-border-strong bg-page"
            : "border-accent bg-bg",
      )}
    />
  );
}

/** Milestones in order, grouped by month, with a "today" marker; a plain list without rail. */
function TimelineView({
  spec,
  items,
  today,
  rail,
  limit,
}: {
  spec: Spec;
  items: Indexed[];
  today: number;
  rail: boolean;
  limit: number;
}) {
  const { t } = useI18n();
  const d = useDates();
  const [more, setMore] = useState(false);
  const list = more ? items : items.slice(0, limit);
  const firstUpcoming = list.findIndex(({ e }) => endAt(e) >= today);
  return (
    <ol className="flex flex-col" aria-label={spec.title}>
      {list.map((it, n) => {
        const m = it.e.start.slice(0, 7);
        const heading =
          n === 0 || list[n - 1]!.e.start.slice(0, 7) !== m ? d.month.format(at(`${m}-01`)) : null;
        const past = endAt(it.e) < today;
        return (
          <li key={it.i} className="flex flex-col">
            {heading && (
              <span className="mt-1 mb-0.5 font-mono text-[10.5px] tracking-[0.08em] text-faint uppercase first:mt-0">
                {heading}
              </span>
            )}
            {n === firstUpcoming && firstUpcoming > 0 && (
              <span className="my-1 flex items-center gap-2 font-mono text-[10.5px] tracking-[0.08em] text-accent-text uppercase">
                <span className="h-px flex-1 bg-accent-line" />
                {t.canvas.viz.temporal.today}
                <span className="h-px flex-1 bg-accent-line" />
              </span>
            )}
            {rail ? (
              <div className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2">
                <span className="relative flex justify-center">
                  <span aria-hidden className="absolute inset-y-0 w-px bg-border" />
                  <Node e={it.e} past={past} />
                </span>
                <EventRow spec={spec} item={it} past={past} />
              </div>
            ) : (
              <EventRow spec={spec} item={it} past={past} />
            )}
          </li>
        );
      })}
      {items.length > list.length && (
        <li>
          <button
            type="button"
            onClick={() => setMore(true)}
            className="px-2 py-1 text-[12px] text-muted hover:text-fg"
          >
            {t.canvas.viz.temporal.more(items.length - list.length)}
          </button>
        </li>
      )}
    </ol>
  );
}

/** A month grid (one month at a time), with that month's events listed below it. */
function CalendarView({ spec, items, today }: { spec: Spec; items: Indexed[]; today: number }) {
  const { t, locale } = useI18n();
  const tt = t.canvas.viz.temporal;
  const d = useDates();
  const months = useMemo(() => {
    const first = new Date(at(items[0]!.e.start));
    const last = new Date(Math.max(...items.map(({ e }) => endAt(e))));
    const out: number[] = [];
    for (
      let y = first.getUTCFullYear(), m = first.getUTCMonth();
      Date.UTC(y, m, 1) <= last.getTime() && out.length < 12;
      m === 11 ? ((m = 0), y++) : m++
    )
      out.push(Date.UTC(y, m, 1));
    return out;
  }, [items]);
  // Open on the month of the next date (or the first one).
  const next = items.find(({ e }) => endAt(e) >= today) ?? items[0]!;
  const startMonth = Math.max(
    0,
    months.findIndex(
      (m) =>
        m ===
        Date.UTC(
          new Date(at(next.e.start)).getUTCFullYear(),
          new Date(at(next.e.start)).getUTCMonth(),
          1,
        ),
    ),
  );
  const [index, setIndex] = useState(startMonth);
  const [picked, setPicked] = useState<number | null>(null);
  const month = months[Math.min(index, months.length - 1)]!;
  const monthEnd = Date.UTC(new Date(month).getUTCFullYear(), new Date(month).getUTCMonth() + 1, 1);
  const days = (monthEnd - month) / DAY;
  const lead = (new Date(month).getUTCDay() + 6) % 7; // Monday first
  const on = (dayAt: number) =>
    items.filter(({ e }) => at(e.start) < dayAt + DAY && endAt(e) >= dayAt);
  const inMonth = items.filter(({ e }) => at(e.start) < monthEnd && endAt(e) >= month);
  const listed = picked !== null ? on(picked) : inMonth;
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" }).format(
      Date.UTC(2024, 0, 1 + i),
    ),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium capitalize">{d.month.format(month)}</span>
        {months.length > 1 && (
          <span className="ml-auto flex gap-1">
            <button
              type="button"
              aria-label={tt.previousMonth}
              disabled={index === 0}
              onClick={() => (setIndex(index - 1), setPicked(null))}
              className="rounded-md p-1 text-muted hover:text-fg disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              aria-label={tt.nextMonth}
              disabled={index >= months.length - 1}
              onClick={() => (setIndex(index + 1), setPicked(null))}
              className="rounded-md p-1 text-muted hover:text-fg disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        )}
      </div>
      <div role="grid" aria-label={d.month.format(month)} className="grid grid-cols-7 gap-0.5">
        {weekdays.map((w, i) => (
          <span
            key={i}
            role="columnheader"
            className="py-0.5 text-center font-mono text-[10px] text-faint uppercase"
          >
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`x${i}`} />
        ))}
        {Array.from({ length: days }, (_, n) => {
          const dayAt = month + n * DAY;
          const here = on(dayAt);
          const high = here.some(({ e }) => e.importance === "high");
          const isToday = dayAt === today;
          return (
            <button
              key={n}
              type="button"
              role="gridcell"
              aria-selected={picked === dayAt}
              disabled={!here.length}
              onClick={() => setPicked(picked === dayAt ? null : dayAt)}
              aria-label={`${d.weekday.format(dayAt)}${here.length ? `: ${here.map(({ e }) => e.title).join(", ")}` : ""}`}
              className={cn(
                "relative flex aspect-square min-h-7 flex-col items-center justify-center rounded-md font-mono text-[11.5px]",
                here.length
                  ? high
                    ? "bg-accent text-accent-fg"
                    : "border border-accent-line text-fg"
                  : "text-faint",
                isToday && "ring-1 ring-fg/40",
                picked === dayAt && "ring-2 ring-accent",
              )}
            >
              {n + 1}
              {here.length > 1 && (
                <span aria-hidden className="absolute bottom-0.5 text-[8px] leading-none">
                  {"•".repeat(Math.min(here.length, 3))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <ul className="flex flex-col">
        {listed.map((it) => (
          <li key={it.i}>
            <EventRow spec={spec} item={it} past={endAt(it.e) < today} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One or a few days of timed events: grouped by day, all-day first, times in order. */
function AgendaView({ spec, items }: { spec: Spec; items: Indexed[] }) {
  const { t } = useI18n();
  const d = useDates();
  const byDay = new Map<string, Indexed[]>();
  for (const it of items) {
    const key = it.e.start.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), it]);
  }
  return (
    <div className="flex flex-col gap-2">
      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} className="flex flex-col">
          {byDay.size > 1 && (
            <h4 className="px-2 font-mono text-[10.5px] tracking-[0.08em] text-faint uppercase">
              {d.weekday.format(at(day))}
            </h4>
          )}
          <ul className="flex flex-col">
            {list
              .sort(
                (a, b) => a.e.start.length - b.e.start.length || a.e.start.localeCompare(b.e.start),
              )
              .map((it) => {
                const p = parseWhen(it.e.start)!;
                const end = it.e.end ? parseWhen(it.e.end) : null;
                return (
                  <li
                    key={it.i}
                    className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-2"
                  >
                    <span className="pt-2 pl-2 font-mono text-[12px] text-muted">
                      {p.precision === "time"
                        ? `${d.time.format(p.at)}${end?.precision === "time" ? `–${d.time.format(end.at)}` : ""}`
                        : t.canvas.viz.temporal.allDay}
                    </span>
                    <EventRow spec={spec} item={it} past={false} compact />
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Gantt-like: each event a bar from start to end on one date axis; points as diamonds. */
function IntervalsView({ spec, items, today }: { spec: Spec; items: Indexed[]; today: number }) {
  const d = useDates();
  const lo = Math.min(...items.map(({ e }) => at(e.start)));
  const hi = Math.max(...items.map(({ e }) => endAt(e)));
  const span = Math.max(hi - lo, DAY);
  const x = (v: number) => ((v - lo) / span) * 100;
  const ticks: number[] = [];
  for (
    let t = Date.UTC(new Date(lo).getUTCFullYear(), new Date(lo).getUTCMonth() + 1, 1);
    t < hi && ticks.length < 12;
    t = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1)
  )
    ticks.push(t);
  return (
    <ul className="flex flex-col">
      {items.map((it) => {
        const s = x(at(it.e.start));
        const w = it.e.end ? Math.max(x(endAt(it.e)) - s, 1.5) : 0;
        return (
          <li
            key={it.i}
            className="grid grid-cols-[minmax(110px,40%)_minmax(0,1fr)] items-center gap-x-2"
          >
            <EventRow spec={spec} item={it} past={endAt(it.e) < today} />
            <span className="relative h-5" aria-hidden>
              <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--gridline)]" />
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute inset-y-0 w-px bg-[var(--gridline)]"
                  style={{ left: `${x(t)}%` }}
                />
              ))}
              {today >= lo && today <= hi && (
                <span
                  className="absolute inset-y-0 w-0 border-l border-dashed border-accent"
                  style={{ left: `${x(today)}%` }}
                />
              )}
              {it.e.end ? (
                <span
                  className={cn(
                    "absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full",
                    it.e.importance === "high" ? "bg-accent" : "bg-[var(--chart-neutral-2)]",
                  )}
                  style={{ left: `${s}%`, width: `${w}%` }}
                />
              ) : (
                <span
                  className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-accent"
                  style={{ left: `${s}%` }}
                />
              )}
            </span>
          </li>
        );
      })}
      {ticks.length > 0 && (
        <li className="grid grid-cols-[minmax(110px,40%)_minmax(0,1fr)] gap-x-2" aria-hidden>
          <span />
          <span className="relative h-4 font-mono text-[10px] text-faint">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: `${x(t)}%` }}>
                {d.day.format(t)}
              </span>
            ))}
          </span>
        </li>
      )}
    </ul>
  );
}
