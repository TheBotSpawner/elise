"use client";

import { ChevronLeft, ChevronRight, ExternalLink, MapPin, Users, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { todayIn, toLocalDateTime } from "@/core/time";
import {
  agendaGroups,
  allDayBars,
  CALENDAR_VIEWS,
  calendarsOf,
  dayBlocks,
  daysBetween,
  eventLabel,
  eventsOn,
  localSpan,
  monthWeeks,
  viewRange,
  visibleEvents,
  yearDensity,
  type CalendarChange,
  type CalendarItem,
  type CalendarPayload,
  type CalendarView,
} from "@/core/workspace/calendar";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * The Calendar Surface (ADR-033): familiar calendar grammar — every event in its own day and
 * time. Day/Week are time grids with an all-day strip and a "now" line; Month is a grid with
 * "+N más"; Year is twelve compact months by density; Agenda is grouped by explicit dates. The
 * controls change the presentation of this same Surface (never another one).
 */

type Locale = "es" | "en";
const HOUR = { compact: 36, normal: 44, focus: 52 } as const;
/** Up to four calendars are told apart by a subtle mark (and always by name in the detail). */
const MARKS = ["bg-accent", "bg-fg2", "bg-warning", "bg-success"] as const;

const subscribeMinute = (cb: () => void) => {
  const id = window.setInterval(cb, 60_000);
  return () => window.clearInterval(id);
};
function useNowMinute() {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000) * 60_000,
    () => 0,
  );
}

function fmt(locale: Locale) {
  const tag = locale === "es" ? "es-AR" : "en-US";
  const at = (d: string) => new Date(`${d}T12:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(tag, { ...o, timeZone: "UTC" });
  return {
    weekday: (d: string) => f({ weekday: "short" }).format(at(d)).replace(".", ""),
    dayNum: (d: string) => f({ day: "numeric" }).format(at(d)),
    dayHead: (d: string) =>
      f({ weekday: "short", day: "numeric", month: "short" }).format(at(d)).replace(/\./g, ""),
    dayLong: (d: string) => f({ weekday: "long", day: "numeric", month: "long" }).format(at(d)),
    month: (d: string) => f({ month: "long", year: "numeric" }).format(at(d)),
    monthShort: (d: string) => f({ month: "long" }).format(at(d)),
    range: (from: string, to: string) =>
      f({ day: "numeric", month: "short", year: "numeric" }).formatRange(at(from), at(to)),
  };
}

const hm = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function CalendarBody({
  p,
  loading,
  focus,
  onChange,
}: {
  p: CalendarPayload;
  loading: boolean;
  /** Expanded (Focus): taller hours, full toolbar. */
  focus: boolean;
  onChange?: (change: CalendarChange) => void;
}) {
  const { t, locale } = useI18n();
  const desktop = useIsDesktop();
  const f = fmt(locale);
  const tz = p.timezone;
  const today = todayIn(tz);
  const [detail, setDetail] = useState<CalendarItem | null>(null);
  const events = visibleEvents(p);
  const calendars = calendarsOf(p.events);
  const mark = (e: CalendarItem) =>
    e.busy ? "bg-faint" : MARKS[calendars.findIndex((c) => c.id === e.calendarId) % MARKS.length];
  const shown = viewRange(p.view, p.anchor, p.range);
  const loaded = (d: string) => d >= p.range.from && d < p.range.to;
  const change = (c: CalendarChange) => {
    setDetail(null);
    onChange?.(c);
  };
  const title =
    p.view === "day"
      ? f.dayLong(p.anchor)
      : p.view === "month"
        ? f.month(p.anchor)
        : p.view === "year"
          ? p.anchor.slice(0, 4)
          : f.range(shown.from, daysBetween(shown.from, shown.to).at(-1) ?? shown.from);
  const open = (e: CalendarItem) => setDetail(e);
  const label = (e: CalendarItem) =>
    `${eventLabel(e, tz, locale)}${calendars.length > 1 && !e.busy ? ` · ${e.calendarName}` : ""}`;

  return (
    <div className="relative flex min-w-0 flex-col gap-3">
      <Toolbar
        title={title}
        view={p.view}
        calendars={calendars}
        hidden={p.hidden}
        onChange={onChange ? change : undefined}
        compact={!desktop}
      />
      {loading && (
        <p role="status" className="font-mono text-[11px] text-muted">
          {t.calendar.loading}
        </p>
      )}
      {p.truncated && <p className="text-[12px] text-faint">{t.calendar.truncated}</p>}
      <div className={cn("min-w-0", loading && "opacity-60")}>
        {p.view === "day" || (p.view === "week" && !desktop) ? (
          <>
            {p.view === "week" && (
              <DayStrip
                days={daysBetween(shown.from, shown.to)}
                selected={p.anchor}
                events={events}
                tz={tz}
                today={today}
                f={f}
                onSelect={(d) => change({ anchor: d })}
              />
            )}
            <TimeGrid
              days={[p.anchor]}
              events={events}
              free={p.free}
              tz={tz}
              today={today}
              loaded={loaded}
              hour={focus ? HOUR.focus : HOUR.normal}
              f={f}
              mark={mark}
              label={label}
              onOpen={open}
              showHeads={false}
            />
          </>
        ) : p.view === "week" ? (
          <TimeGrid
            days={daysBetween(shown.from, shown.to)}
            events={events}
            free={p.free}
            tz={tz}
            today={today}
            loaded={loaded}
            hour={focus ? HOUR.focus : events.length > 40 ? HOUR.compact : HOUR.normal}
            f={f}
            mark={mark}
            label={label}
            onOpen={open}
            showHeads
            onDay={(d) => change({ view: "day", anchor: d })}
          />
        ) : p.view === "month" ? (
          <MonthGrid
            anchor={p.anchor}
            events={events}
            tz={tz}
            today={today}
            loaded={loaded}
            f={f}
            mark={mark}
            label={label}
            onOpen={open}
            onDay={(d) => change({ view: "day", anchor: d })}
            compact={!desktop}
          />
        ) : p.view === "year" ? (
          <YearGrid
            anchor={p.anchor}
            events={events}
            tz={tz}
            today={today}
            f={f}
            onMonth={(d) => change({ view: "month", anchor: d })}
          />
        ) : (
          <Agenda p={p} events={events} f={f} mark={mark} label={label} onOpen={open} />
        )}
      </div>
      {detail && (
        <EventDetail
          e={detail}
          tz={tz}
          locale={locale}
          multi={calendars.length > 1}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function Toolbar({
  title,
  view,
  calendars,
  hidden,
  onChange,
  compact,
}: {
  title: string;
  view: CalendarView;
  calendars: { id: string; name: string; account: string }[];
  hidden: string[];
  onChange?: (c: CalendarChange) => void;
  compact: boolean;
}) {
  const { t } = useI18n();
  const btn =
    "grid size-8 place-items-center rounded-full border border-border text-muted hover:border-accent-line hover:text-fg";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 truncate text-[15px] font-medium capitalize first-letter:uppercase">
        {title}
      </p>
      {onChange && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={btn}
            aria-label={t.calendar.previous}
            onClick={() => onChange({ shift: -1 })}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => onChange({ shift: 0 })}
            className="h-8 rounded-full border border-border px-3 text-[12.5px] text-fg2 hover:border-accent-line hover:text-fg"
          >
            {t.calendar.today}
          </button>
          <button
            type="button"
            className={btn}
            aria-label={t.calendar.next}
            onClick={() => onChange({ shift: 1 })}
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </div>
      )}
      {onChange && (
        <div
          role="group"
          aria-label={t.calendar.view}
          className={cn(
            "flex items-center rounded-full border border-border p-0.5",
            compact && "order-last w-full justify-between",
          )}
        >
          {CALENDAR_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onChange({ view: v })}
              className={cn(
                "h-7 rounded-full px-2.5 text-[12.5px]",
                compact && "flex-1",
                view === v ? "bg-active text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t.calendar.views[v]}
            </button>
          ))}
        </div>
      )}
      {onChange && calendars.length > 1 && (
        <details className="relative">
          <summary className="flex h-8 cursor-pointer list-none items-center rounded-full border border-border px-3 text-[12.5px] text-fg2 [&::-webkit-details-marker]:hidden">
            {t.calendar.calendars} ▾
          </summary>
          <div className="absolute right-0 z-20 mt-1 flex min-w-52 flex-col gap-0.5 rounded-xl border border-border bg-[var(--menu-bg)] p-1.5 shadow-[var(--menu-shadow)] backdrop-blur-xl">
            {calendars.map((c, i) => (
              <label
                key={c.id}
                className="flex h-9 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-active"
              >
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.id)}
                  onChange={(e) =>
                    onChange({
                      hidden: e.target.checked
                        ? hidden.filter((h) => h !== c.id)
                        : [...hidden, c.id],
                    })
                  }
                />
                <span aria-hidden className={cn("size-2 rounded-full", MARKS[i % MARKS.length])} />
                <span className="truncate">{c.name}</span>
                <span className="ml-auto truncate text-[11.5px] text-faint">{c.account}</span>
              </label>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Day / Week: time grid ───────────────────────────────────────────────────

function TimeGrid({
  days,
  events,
  free,
  tz,
  today,
  loaded,
  hour,
  f,
  mark,
  label,
  onOpen,
  showHeads,
  onDay,
}: {
  days: string[];
  events: CalendarItem[];
  free: CalendarPayload["free"];
  tz: string;
  today: string;
  loaded: (d: string) => boolean;
  hour: number;
  f: ReturnType<typeof fmt>;
  mark: (e: CalendarItem) => string | undefined;
  label: (e: CalendarItem) => string;
  onOpen: (e: CalendarItem) => void;
  showHeads: boolean;
  onDay?: (d: string) => void;
}) {
  const { t } = useI18n();
  const now = useNowMinute();
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => days.map((d) => dayBlocks(events, d, tz)), [days, events, tz]);
  const bars = useMemo(() => allDayBars(events, days, tz), [events, days, tz]);
  const lanes = bars.length ? Math.max(...bars.map((b) => b.lane)) + 1 : 0;
  // Open on the first event (or 08:00): the morning before it is a scroll away.
  const first = Math.min(8 * 60, ...blocks.flat().map((b) => b.from));
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (first / 60) * hour - 8);
  }, [first, hour]);
  const nowLocal = now ? toLocalDateTime(new Date(now), tz) : null;
  const nowMin = nowLocal
    ? Number(nowLocal.slice(11, 13)) * 60 + Number(nowLocal.slice(14, 16))
    : 0;
  const cols = `44px repeat(${days.length}, minmax(0, 1fr))`;
  const freeOn = (d: string) =>
    free
      .map((w) => localSpan({ start: w.start, end: w.end, allDay: false }, tz))
      .filter((s) => s.first <= d && s.last >= d)
      .map((s) => ({ from: s.first === d ? s.startMin : 0, to: s.last === d ? s.endMin : 1440 }));

  return (
    <div className="flex min-w-0 flex-col">
      {showHeads && (
        <div className="grid border-b border-border pb-1.5" style={{ gridTemplateColumns: cols }}>
          <span />
          {days.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDay?.(d)}
              aria-label={t.calendar.openDay(f.dayLong(d))}
              className={cn(
                "flex flex-col items-center rounded-lg py-0.5 hover:bg-active",
                !loaded(d) && "opacity-50",
              )}
            >
              <span className="font-mono text-[10.5px] tracking-[0.08em] text-faint uppercase">
                {f.weekday(d)}
              </span>
              <span
                className={cn(
                  "grid size-7 place-items-center rounded-full text-[14px]",
                  d === today ? "bg-accent text-accent-fg" : "text-fg",
                )}
              >
                {f.dayNum(d)}
              </span>
            </button>
          ))}
        </div>
      )}
      {lanes > 0 && (
        <div
          className="grid gap-y-0.5 border-b border-border py-1"
          style={{ gridTemplateColumns: cols, gridTemplateRows: `repeat(${lanes}, 22px)` }}
        >
          <span className="row-span-full self-center font-mono text-[9.5px] text-faint uppercase">
            {t.calendar.allDay}
          </span>
          {bars.map((b) => (
            <button
              key={b.item.id}
              type="button"
              onClick={() => onOpen(b.item)}
              aria-label={label(b.item)}
              title={label(b.item)}
              style={{ gridColumn: `${b.start + 2} / ${b.end + 3}`, gridRow: b.lane + 1 }}
              className={cn(
                "mx-0.5 flex min-w-0 items-center gap-1.5 rounded-md bg-accent-soft px-2 text-left text-[12px] text-accent-text hover:brightness-95",
                b.before && "rounded-l-none",
                b.after && "rounded-r-none",
              )}
            >
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", mark(b.item))} />
              <span className="truncate">{b.item.title}</span>
            </button>
          ))}
        </div>
      )}
      <div ref={scroller} className="max-h-[min(560px,62vh)] overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: cols, height: hour * 24 }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className="absolute right-1.5 -translate-y-1/2 font-mono text-[10px] text-faint"
                style={{ top: (i + 1) * hour }}
              >
                {hm((i + 1) * 60)}
              </span>
            ))}
          </div>
          {days.map((d, di) => (
            <div
              key={d}
              className={cn(
                "relative border-l border-border",
                !loaded(d) &&
                  "bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--color-gridline)_6px_7px)]",
              )}
            >
              {Array.from({ length: 23 }, (_, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="absolute inset-x-0 border-t border-[var(--color-gridline)]"
                  style={{ top: (i + 1) * hour }}
                />
              ))}
              {freeOn(d).map((w, i) => (
                <span
                  key={`free-${i}`}
                  className="absolute inset-x-0.5 rounded-md border border-dashed border-accent-line bg-accent-soft/40"
                  style={{ top: (w.from / 60) * hour, height: ((w.to - w.from) / 60) * hour }}
                  title={`${t.calendar.free} ${hm(w.from)}–${hm(w.to)}`}
                />
              ))}
              {blocks[di]!.map((b) => (
                <button
                  key={b.item.id}
                  type="button"
                  onClick={() => onOpen(b.item)}
                  aria-label={label(b.item)}
                  title={label(b.item)}
                  className={cn(
                    "absolute flex flex-col overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11.5px] leading-tight focus-visible:z-10",
                    b.item.busy
                      ? "border-border-strong bg-[repeating-linear-gradient(135deg,var(--color-surface-2)_0_5px,var(--color-surface)_5px_10px)] text-muted"
                      : "border-accent-line bg-accent-soft text-fg hover:brightness-95",
                    b.item.status === "tentative" && "border-dashed",
                  )}
                  style={{
                    top: (b.from / 60) * hour,
                    height: Math.max(((b.to - b.from) / 60) * hour - 2, 16),
                    left: `calc(${(b.col / b.cols) * 100}% + 2px)`,
                    width: `calc(${100 / b.cols}% - 4px)`,
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1">
                    <span
                      aria-hidden
                      className={cn("size-1.5 shrink-0 rounded-full", mark(b.item))}
                    />
                    <span className="truncate font-medium">
                      {b.item.busy ? t.calendar.busy : b.item.title}
                    </span>
                  </span>
                  {b.to - b.from >= 45 && (
                    <span className="truncate font-mono text-[10px] text-muted">
                      {hm(b.from)}–{hm(b.to)}
                    </span>
                  )}
                </button>
              ))}
              {d === today && nowLocal && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 z-10 h-px bg-danger"
                  style={{ top: (nowMin / 60) * hour }}
                >
                  <span className="absolute -top-[3px] -left-[3px] size-[7px] rounded-full bg-danger" />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Phones: the week as a strip of days; the selected day's schedule below. */
function DayStrip({
  days,
  selected,
  events,
  tz,
  today,
  f,
  onSelect,
}: {
  days: string[];
  selected: string;
  events: CalendarItem[];
  tz: string;
  today: string;
  f: ReturnType<typeof fmt>;
  onSelect: (d: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-2 grid grid-cols-7 gap-1">
      {days.map((d) => {
        const n = eventsOn(events, d, tz).length;
        return (
          <button
            key={d}
            type="button"
            aria-pressed={d === selected}
            aria-label={`${t.calendar.openDay(f.dayLong(d))}${n ? ` · ${n}` : ""}`}
            onClick={() => onSelect(d)}
            className={cn(
              "flex flex-col items-center gap-0.5 rounded-xl py-1.5",
              d === selected ? "bg-active" : "hover:bg-active/60",
            )}
          >
            <span className="font-mono text-[10.5px] text-faint uppercase">{f.weekday(d)}</span>
            <span className={cn("text-[15px]", d === today && "font-semibold text-accent-text")}>
              {f.dayNum(d)}
            </span>
            <span
              aria-hidden
              className={cn("size-1 rounded-full", n ? "bg-accent" : "bg-transparent")}
            />
          </button>
        );
      })}
    </div>
  );
}

// ── Month ────────────────────────────────────────────────────────────────────

function MonthGrid({
  anchor,
  events,
  tz,
  today,
  loaded,
  f,
  mark,
  label,
  onOpen,
  onDay,
  compact,
}: {
  anchor: string;
  events: CalendarItem[];
  tz: string;
  today: string;
  loaded: (d: string) => boolean;
  f: ReturnType<typeof fmt>;
  mark: (e: CalendarItem) => string | undefined;
  label: (e: CalendarItem) => string;
  onOpen: (e: CalendarItem) => void;
  onDay: (d: string) => void;
  compact: boolean;
}) {
  const { t } = useI18n();
  const weeks = monthWeeks(anchor);
  const month = anchor.slice(0, 7);
  const max = compact ? 0 : 3;
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-7 pb-1">
        {weeks[0]!.map((d) => (
          <span
            key={d}
            className="text-center font-mono text-[10.5px] tracking-[0.08em] text-faint uppercase"
          >
            {f.weekday(d)}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 border-t border-l border-border">
        {weeks.flat().map((d) => {
          const day = eventsOn(events, d, tz);
          const shown = day.slice(0, max);
          const rest = day.length - shown.length;
          return (
            <div
              key={d}
              className={cn(
                "flex min-w-0 flex-col gap-0.5 border-r border-b border-border p-1",
                compact ? "min-h-12" : "min-h-24",
                !d.startsWith(month) && "bg-surface-2/50",
                !loaded(d) && "opacity-50",
              )}
            >
              <button
                type="button"
                onClick={() => onDay(d)}
                aria-label={`${t.calendar.openDay(f.dayLong(d))}${day.length ? ` · ${day.length}` : ""}`}
                className={cn(
                  "grid size-6 place-items-center self-start rounded-full text-[12.5px] hover:bg-active",
                  d === today && "bg-accent text-accent-fg hover:bg-accent",
                  !d.startsWith(month) && d !== today && "text-faint",
                )}
              >
                {f.dayNum(d)}
              </button>
              {compact && day.length > 0 && (
                <span aria-hidden className="flex gap-0.5 px-1">
                  {day.slice(0, 3).map((e) => (
                    <span key={e.id} className={cn("size-1.5 rounded-full", mark(e))} />
                  ))}
                </span>
              )}
              {shown.map((e) => {
                const span = localSpan(e, tz);
                const allDay = e.allDay || span.first !== span.last;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onOpen(e)}
                    aria-label={label(e)}
                    title={label(e)}
                    className={cn(
                      "flex min-w-0 items-center gap-1 rounded px-1 text-left text-[11.5px] leading-[18px] hover:bg-active",
                      allDay && "bg-accent-soft text-accent-text",
                    )}
                  >
                    {!allDay && (
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", mark(e))} />
                    )}
                    {!allDay && span.first === d && (
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        {hm(span.startMin)}
                      </span>
                    )}
                    <span className="truncate">{e.busy ? t.calendar.busy : e.title}</span>
                  </button>
                );
              })}
              {rest > 0 && !compact && (
                <button
                  type="button"
                  onClick={() => onDay(d)}
                  className="self-start px-1 text-[11px] text-accent-text hover:underline"
                >
                  {t.calendar.more(rest)}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Year ─────────────────────────────────────────────────────────────────────

function YearGrid({
  anchor,
  events,
  tz,
  today,
  f,
  onMonth,
}: {
  anchor: string;
  events: CalendarItem[];
  tz: string;
  today: string;
  f: ReturnType<typeof fmt>;
  onMonth: (d: string) => void;
}) {
  const { t } = useI18n();
  const year = anchor.slice(0, 4);
  const density = useMemo(() => yearDensity(events, year, tz), [events, year, tz]);
  const months = Array.from(
    { length: 12 },
    (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`,
  );
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {months.map((m) => {
        const days = monthWeeks(m).flat();
        const count = days
          .filter((d) => d.startsWith(m.slice(0, 7)))
          .reduce((n, d) => n + (density.get(d) ?? 0), 0);
        return (
          <button
            key={m}
            type="button"
            onClick={() => onMonth(m)}
            aria-label={t.calendar.openMonth(f.monthShort(m), count)}
            className="flex flex-col gap-1.5 rounded-xl p-2 text-left hover:bg-active"
          >
            <span className="flex items-baseline justify-between text-[13px] capitalize">
              {f.monthShort(m)}
              {count > 0 && <span className="font-mono text-[10.5px] text-muted">{count}</span>}
            </span>
            <span aria-hidden className="grid grid-cols-7 gap-[2px]">
              {days.map((d) => {
                const n = d.startsWith(m.slice(0, 7)) ? (density.get(d) ?? 0) : -1;
                return (
                  <span
                    key={d}
                    className={cn(
                      "aspect-square rounded-[2px]",
                      n < 0 ? "bg-transparent" : n === 0 ? "bg-surface-2" : "bg-accent",
                      d === today && "ring-1 ring-fg",
                    )}
                    style={n > 0 ? { opacity: Math.min(1, 0.35 + n * 0.2) } : undefined}
                  />
                );
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Agenda ───────────────────────────────────────────────────────────────────

function Agenda({
  p,
  events,
  f,
  mark,
  label,
  onOpen,
}: {
  p: CalendarPayload;
  events: CalendarItem[];
  f: ReturnType<typeof fmt>;
  mark: (e: CalendarItem) => string | undefined;
  label: (e: CalendarItem) => string;
  onOpen: (e: CalendarItem) => void;
}) {
  const { t } = useI18n();
  const groups = agendaGroups(events, p.range, p.timezone);
  const multi = calendarsOf(events).length > 1;
  if (!groups.length) return <p className="text-[14px] text-muted">{t.calendar.noEvents}</p>;
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <section key={g.day} aria-label={f.dayLong(g.day)}>
          <h3 className="mb-1 font-mono text-[11px] tracking-[0.1em] text-faint uppercase">
            {f.dayHead(g.day)}
          </h3>
          <ul className="flex flex-col">
            {g.items.map(({ item: e, span }) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onOpen(e)}
                  aria-label={label(e)}
                  className="grid w-full grid-cols-[96px_minmax(0,1fr)_auto] items-baseline gap-3 rounded-lg px-1 py-1.5 text-left text-[14px] hover:bg-active"
                >
                  <span className="font-mono text-[12px] text-muted">
                    {e.allDay
                      ? t.calendar.allDay
                      : span.first === span.last
                        ? `${hm(span.startMin)}–${hm(span.endMin)}`
                        : hm(span.startMin)}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", mark(e))} />
                      <span className="truncate">{e.busy ? t.calendar.busy : e.title}</span>
                    </span>
                    {span.first !== span.last && (
                      <span className="text-[12px] text-muted">
                        {f.dayHead(span.first)} → {f.dayHead(span.last)}
                      </span>
                    )}
                  </span>
                  {multi ? (
                    <span className="truncate text-[12px] text-faint">{e.calendarName}</span>
                  ) : (
                    <span />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── Detail ───────────────────────────────────────────────────────────────────

function EventDetail({
  e,
  tz,
  locale,
  multi,
  onClose,
}: {
  e: CalendarItem;
  tz: string;
  locale: Locale;
  multi: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (k: KeyboardEvent) => k.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const when = eventLabel(e, tz, locale).split(", ").slice(1).join(", ");
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={e.busy ? t.calendar.busy : e.title}
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col gap-2 rounded-2xl border border-border-strong bg-[var(--menu-bg)] p-4 shadow-[var(--menu-shadow)] backdrop-blur-xl outline-none md:inset-x-auto md:right-0 md:w-[360px]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15.5px] font-medium">{e.busy ? t.calendar.busy : e.title}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.calendar.close}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-active"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="text-[13.5px] text-fg2 first-letter:uppercase">{when}</p>
      {!e.busy && (
        <p className="text-[12.5px] text-muted">
          {e.calendarName}
          {multi || e.account ? ` · ${e.account}` : ""}
        </p>
      )}
      {e.location && (
        <p className="flex items-center gap-1.5 text-[13px] text-fg2">
          <MapPin className="size-3.5 text-muted" aria-hidden />
          {e.location}
        </p>
      )}
      {e.attendees > 0 && (
        <p className="flex items-center gap-1.5 text-[13px] text-fg2">
          <Users className="size-3.5 text-muted" aria-hidden />
          {t.calendar.attendees(e.attendees)}
        </p>
      )}
      {e.description && <p className="line-clamp-4 text-[13px] text-muted">{e.description}</p>}
      {(e.meetingUrl || e.htmlUrl) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {e.meetingUrl && (
            <a
              href={e.meetingUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-1.5 rounded-full bg-fg px-3 text-[12.5px] text-bg"
            >
              <Video className="size-3.5" aria-hidden />
              {t.calendar.join}
            </a>
          )}
          {e.htmlUrl && (
            <a
              href={e.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] text-fg2 hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t.calendar.openInCalendar}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
