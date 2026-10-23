"use client";

import { useState } from "react";

import { Input, Select } from "@/components/ui/input";
import {
  describeRepeat,
  parseRRule,
  WEEKDAYS,
  type Repeat,
  type Weekday,
} from "@/core/tasks/recurrence";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export type RepeatScope = "this" | "following" | "all";

const dayOf = (iso: string): Weekday =>
  WEEKDAYS[(new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7]!;
const dateOf = (iso: string) => Number(iso.slice(8, 10));
/** Which week of the month a date is in (1–4), or -1 for the last one ("el último viernes"). */
const ordinalOf = (iso: string) => {
  const d = dateOf(iso);
  const last = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), 0)).getUTCDate();
  return d + 7 > last ? -1 : Math.ceil(d / 7);
};

type Preset = "none" | "daily" | "weekly" | "weekdays" | "monthly" | "yearly" | "custom";

function presetOf(r: Repeat | null): Preset {
  if (!r) return "none";
  if (r.count || r.until || r.interval > 1 || r.ordinal || r.monthDay) return "custom";
  if (r.freq === "weekly" && r.days?.join() === "mo,tu,we,th,fr") return "weekdays";
  if (r.freq === "weekly" && (r.days?.length ?? 1) > 1) return "custom";
  return r.freq;
}

/**
 * "Repetir" (ADR-115): presets for the usual rules, and a custom editor for every N, days of the
 * week, the Nth weekday of the month and how it ends. With a series, the scope says what an edit
 * of this task changes: only this occurrence, this and the following, or the whole series.
 */
export function RepeatField({
  rrule,
  dueDate,
  today,
  scope,
  onScope,
  onChange,
  compact = false,
}: {
  rrule: string | null;
  dueDate: string | null;
  today: string;
  scope: RepeatScope;
  onScope: (s: RepeatScope) => void;
  onChange: (repeat: Repeat | null) => void;
  /** Creating a task: no series yet, so no "changes apply to" switch. */
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const x = t.tasks.ws.repeat;
  let current: Repeat | null = null;
  try {
    current = rrule ? parseRRule(rrule) : null;
  } catch {
    current = null;
  }
  const anchor = dueDate ?? today;
  const [editing, setEditing] = useState(false);
  const preset = presetOf(current);

  const pick = (p: Preset) => {
    if (p === "custom") return setEditing(true);
    setEditing(false);
    if (p === "none") return onChange(null);
    if (p === "weekdays")
      return onChange({ freq: "weekly", interval: 1, days: ["mo", "tu", "we", "th", "fr"] });
    if (p === "weekly") return onChange({ freq: "weekly", interval: 1, days: [dayOf(anchor)] });
    onChange({ freq: p, interval: 1 });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        aria-label={x.label}
        value={editing ? "custom" : preset}
        onChange={(e) => pick(e.target.value as Preset)}
        className="h-8 w-auto max-w-full py-0 text-[13px]"
      >
        <option value="none">{x.none}</option>
        <option value="daily">{x.daily}</option>
        <option value="weekly">{x.weekly(x.days[dayOf(anchor)])}</option>
        <option value="weekdays">{x.weekdays}</option>
        <option value="monthly">{x.monthly(dateOf(anchor))}</option>
        <option value="yearly">{x.yearly}</option>
        <option value="custom">
          {preset === "custom" && current ? describeRepeat(current, anchor, locale) : x.custom}
        </option>
      </Select>
      {editing && (
        <CustomRepeat
          initial={current}
          anchor={anchor}
          onCancel={() => setEditing(false)}
          onSave={(r) => {
            setEditing(false);
            onChange(r);
          }}
        />
      )}
      {current && !compact && (
        <div role="radiogroup" aria-label={x.scopeLabel} className="flex flex-wrap gap-1">
          {(["this", "following", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={scope === s}
              onClick={() => onScope(s)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[11.5px]",
                scope === s
                  ? "border-accent-line bg-accent-soft text-accent-text"
                  : "border-border text-muted hover:text-fg",
              )}
            >
              {x.scope[s]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomRepeat({
  initial,
  anchor,
  onSave,
  onCancel,
}: {
  initial: Repeat | null;
  anchor: string;
  onSave: (r: Repeat) => void;
  onCancel: () => void;
}) {
  const { t, locale } = useI18n();
  const x = t.tasks.ws.repeat;
  const [freq, setFreq] = useState<Repeat["freq"]>(initial?.freq ?? "weekly");
  const [interval, setInterval] = useState(initial?.interval ?? 1);
  const [days, setDays] = useState<Weekday[]>(initial?.days ?? [dayOf(anchor)]);
  const [monthly, setMonthly] = useState<"day" | "ordinal">(initial?.ordinal ? "ordinal" : "day");
  const [end, setEnd] = useState<"never" | "until" | "count">(
    initial?.until ? "until" : initial?.count ? "count" : "never",
  );
  const [until, setUntil] = useState(initial?.until ?? "");
  const [count, setCount] = useState(initial?.count ?? 10);

  const rule: Repeat = {
    freq,
    interval: Math.max(1, Math.min(365, interval || 1)),
    ...(freq === "weekly" && days.length ? { days } : {}),
    ...(freq === "monthly" && monthly === "ordinal"
      ? { ordinal: { n: ordinalOf(anchor), day: dayOf(anchor) } }
      : {}),
    ...(end === "until" && until ? { until } : {}),
    ...(end === "count" ? { count: Math.max(1, Math.min(1000, count || 1)) } : {}),
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border p-3 text-[12.5px]">
      <label className="flex flex-wrap items-center gap-2">
        {x.every}
        <Input
          type="number"
          min={1}
          max={365}
          value={interval}
          onChange={(e) => setInterval(Number(e.target.value))}
          aria-label={x.every}
          className="h-7 w-16 py-0 text-[12.5px]"
        />
        <Select
          aria-label={x.unit}
          value={freq}
          onChange={(e) => setFreq(e.target.value as Repeat["freq"])}
          className="h-7 w-auto py-0 text-[12.5px]"
        >
          {(["daily", "weekly", "monthly", "yearly"] as const).map((f) => (
            <option key={f} value={f}>
              {x.units[f]}
            </option>
          ))}
        </Select>
      </label>
      {freq === "weekly" && (
        <div role="group" aria-label={x.onDays} className="flex gap-1">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              aria-label={x.days[d]}
              onClick={() => setDays(days.includes(d) ? days.filter((y) => y !== d) : [...days, d])}
              className={cn(
                "grid size-7 place-items-center rounded-full border text-[11px]",
                days.includes(d)
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border text-muted hover:text-fg",
              )}
            >
              {x.days[d].slice(0, 2)}
            </button>
          ))}
        </div>
      )}
      {freq === "monthly" && (
        <Select
          aria-label={x.monthlyMode}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value as "day" | "ordinal")}
          className="h-7 w-auto py-0 text-[12.5px]"
        >
          <option value="day">{x.onDay(dateOf(anchor))}</option>
          <option value="ordinal">{x.onOrdinal(ordinalOf(anchor), x.days[dayOf(anchor)])}</option>
        </Select>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">{x.ends}</span>
        <Select
          aria-label={x.ends}
          value={end}
          onChange={(e) => setEnd(e.target.value as typeof end)}
          className="h-7 w-auto py-0 text-[12.5px]"
        >
          <option value="never">{x.never}</option>
          <option value="until">{x.onDate}</option>
          <option value="count">{x.after}</option>
        </Select>
        {end === "until" && (
          <Input
            type="date"
            value={until}
            min={anchor}
            aria-label={x.onDate}
            onChange={(e) => setUntil(e.target.value)}
            className="h-7 w-auto py-0 text-[12.5px]"
          />
        )}
        {end === "count" && (
          <Input
            type="number"
            min={1}
            max={1000}
            value={count}
            aria-label={x.after}
            onChange={(e) => setCount(Number(e.target.value))}
            className="h-7 w-16 py-0 text-[12.5px]"
          />
        )}
      </div>
      <p className="text-faint">{describeRepeat(rule, anchor, locale)}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-7 rounded-full px-3 text-muted">
          {x.cancel}
        </button>
        <button
          type="button"
          disabled={(end === "until" && !until) || (freq === "weekly" && !days.length)}
          onClick={() => onSave(rule)}
          className="h-7 rounded-full bg-fg px-3 font-medium text-bg disabled:opacity-50"
        >
          {x.save}
        </button>
      </div>
    </div>
  );
}
