"use client";

import { ChevronLeft, ChevronRight, Minus, Plus, Search, Target, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type { HabitsWorkspace } from "@/application/native-service";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { useConfirm } from "@/components/ui/confirm";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  completesDay,
  habitProgress,
  isHabitIcon,
  type Habit,
  type HabitEntry,
  type HabitFrequency,
} from "@/core/capabilities/habits";
import {
  containsToday,
  dailyIntensity,
  habitRange,
  habitStats,
  habitsSummary,
  habitsTrend,
  longestStreak,
  monthlyRates,
  previousRange,
  rateDelta,
  shiftHabitRange,
  suggestHabitIcon,
  weekdayMisses,
  type DayCell,
  type HabitRange,
  type HabitStats,
  type HabitView,
} from "@/core/habits/analytics";
import { addDays } from "@/core/time";
import type { VisualizationSpec } from "@/core/workspace/visualization";
import { completionFeedback } from "@/features/feedback/completion";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { habitCheckInAction, habitHistoryAction, habitsCsvAction } from "./actions";
import { ImportPanel } from "./import-panel";
import { Bar, IconTile, Menu } from "./native-ui";
import { useNative } from "./use-native";

/**
 * Habits workspace (ADR-053): week / month / year / custom ranges, every past day editable,
 * progress and analytics from `core/habits/analytics` (the same code Chat and the Canvas use).
 * Day marks are optimistic: the grid changes at once and only that check-in is written.
 */

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const QUICK_ICONS = ["🏋️", "🏃", "📚", "🧘", "💧", "🥗", "🛏️", "🌅", "😴", "🧹", "🎓", "✍️"];

function useFormats() {
  const { locale } = useI18n();
  const loc = locale === "es" ? "es-AR" : "en-US";
  const f = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(loc, { ...o, timeZone: "UTC" });
  const at = (d: string) => new Date(`${d}T00:00:00Z`);
  const dayMonth = f({ day: "numeric", month: "short" });
  const monthYear = f({ month: "long", year: "numeric" });
  const narrow = f({ weekday: "narrow" });
  const long = f({ weekday: "long", day: "numeric", month: "long" });
  const month = f({ month: "short" });
  // Node and browsers separate ranges with different spaces: normalize for hydration.
  const clean = (s: string) => s.replace(/[  ]/g, " ");
  return {
    range(r: HabitRange) {
      if (r.view === "year") return r.from.slice(0, 4);
      if (r.view === "month") return monthYear.format(at(r.from));
      // "12–18 oct" / "28 sept – 4 oct", composed (browsers format es ranges inconsistently).
      return r.from.slice(0, 7) === r.to.slice(0, 7)
        ? `${Number(r.from.slice(8))}–${clean(dayMonth.format(at(r.to)))}`
        : `${clean(dayMonth.format(at(r.from)))} – ${clean(dayMonth.format(at(r.to)))}`;
    },
    narrow: (d: string) => narrow.format(at(d)),
    long: (d: string) => long.format(at(d)),
    dayMonth: (d: string) => dayMonth.format(at(d)),
    month: (ym: string) => month.format(at(`${ym}-01`)),
    pct: (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`),
  };
}

function useHabitUrl() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return {
    params,
    set(patch: Record<string, string | null>) {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
  };
}

const targetText = (h: Habit, t: ReturnType<typeof useI18n>["t"]) => {
  const unit = h.unit ? ` ${h.unit}` : "";
  const per = h.frequency === "weekly" ? t.native.habits.perWeek : t.native.habits.perDay;
  const days =
    h.frequency === "specific_days"
      ? ` · ${h.preferredDays.map((d) => t.schedules.days[d]).join(", ")}`
      : "";
  return `${h.target}${unit} ${per}${days}`;
};

// ── Small pieces ─────────────────────────────────────────────────────────────

// ── Create / edit ────────────────────────────────────────────────────────────

export type HabitGoalOptions = HabitsWorkspace["goals"];

/** "Objetivos relacionados" (ADR-055): the same links the goal side shows, set from here. */
function RelatedGoals({
  options,
  value,
  onChange,
}: {
  options: HabitGoalOptions;
  value: { goal: string; useForProgress: boolean }[];
  onChange: (v: { goal: string; useForProgress: boolean }[]) => void;
}) {
  const { t } = useI18n();
  const h = t.native.goals.habitSide;
  const f = t.native.goals.form;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{h.title}</span>
      {value.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {value.map((v) => {
            const goal = options.goals.find((g) => g.id === v.goal);
            return (
              <li
                key={v.goal}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2 text-[13px]"
              >
                {goal?.icon && <span aria-hidden>{goal.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{goal?.title ?? "…"}</span>
                {goal?.canDrive && (
                  <label className="flex items-center gap-2 text-[12px] text-muted">
                    {h.use}
                    <Switch
                      checked={v.useForProgress}
                      aria-label={`${h.use}: ${goal.title}`}
                      onCheckedChange={(use) =>
                        onChange(
                          value.map((x) => (x.goal === v.goal ? { ...x, useForProgress: use } : x)),
                        )
                      }
                    />
                  </label>
                )}
                <button
                  type="button"
                  aria-label={f.remove(goal?.title ?? "")}
                  onClick={() => onChange(value.filter((x) => x.goal !== v.goal))}
                  className="grid size-6 place-items-center rounded-full text-faint hover:bg-active hover:text-fg"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Combobox
        value=""
        placeholder={h.add}
        emptyText={f.nothingFound}
        options={options.goals
          .filter((g) => !value.some((v) => v.goal === g.id))
          .map((g) => ({ value: g.id, label: `${g.icon ?? "🎯"} ${g.title}` }))}
        onChange={(id) =>
          onChange([
            ...value,
            { goal: id, useForProgress: Boolean(options.goals.find((g) => g.id === id)?.canDrive) },
          ])
        }
      />
      {value.some((v) => v.useForProgress) && <p className="text-[11.5px] text-faint">{h.hint}</p>}
    </div>
  );
}

function HabitForm({
  habit,
  initialName = "",
  goalOptions,
  onDone,
}: {
  habit?: Habit;
  initialName?: string;
  goalOptions: HabitGoalOptions;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const w = t.native.habits.ws;
  const { act, pending } = useNative();
  const initialGoals = habit
    ? (goalOptions.links[habit.id] ?? []).map((l) => ({ goal: l.goalId, useForProgress: l.drives }))
    : [];
  const [goals, setGoals] = useState(initialGoals);
  const goalsChanged = JSON.stringify(goals) !== JSON.stringify(initialGoals);
  const [name, setName] = useState(habit?.name ?? initialName);
  const [icon, setIcon] = useState(habit?.icon ?? suggestHabitIcon(initialName) ?? "");
  const [frequency, setFrequency] = useState<HabitFrequency>(habit?.frequency ?? "weekly");
  const [target, setTarget] = useState(String(habit?.target ?? 3));
  const [unit, setUnit] = useState(habit?.unit ?? "");
  const [days, setDays] = useState<number[]>(habit?.preferredDays ?? []);
  const iconOk = !icon || isHabitIcon(icon);
  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface p-5 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!iconOk) return;
        const fields = {
          name: name.trim(),
          frequency,
          target: Number(target.replace(",", ".")) || 1,
          ...(frequency === "specific_days" ? { preferredDays: days } : {}),
        };
        if (habit)
          act(
            "habits.update",
            {
              habit: habit.id,
              ...fields,
              unit: unit.trim() || null,
              icon: icon || null,
              // Only when they changed: the full set replaces the habit's goal links.
              ...(goalsChanged ? { goals } : {}),
            },
            onDone,
          );
        else
          act(
            "habits.create",
            {
              ...fields,
              ...(unit.trim() ? { unit: unit.trim() } : {}),
              ...(icon ? { icon } : {}),
              ...(goals.length ? { goals } : {}),
            },
            onDone,
          );
      }}
    >
      {habit && <h2 className="text-[15px] font-medium">{w.editTitle}</h2>}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="habit-name">{t.native.habits.name}</Label>
          <Input
            id="habit-name"
            autoFocus
            required
            maxLength={120}
            value={name}
            placeholder={t.native.habits.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !icon && setIcon(suggestHabitIcon(name) ?? "")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="habit-icon">{w.icon}</Label>
          <Input
            id="habit-icon"
            value={icon}
            maxLength={16}
            placeholder={w.iconHint}
            aria-invalid={!iconOk}
            onChange={(e) => setIcon(e.target.value.trim())}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={w.icon}>
        {QUICK_ICONS.map((i) => (
          <button
            key={i}
            type="button"
            aria-pressed={icon === i}
            onClick={() => setIcon(icon === i ? "" : i)}
            className={cn(
              "grid size-8 place-items-center rounded-lg text-[16px] transition-colors",
              icon === i ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-surface-2",
            )}
          >
            {i}
          </button>
        ))}
      </div>
      {!iconOk && <p className="text-[12.5px] text-danger-text">{w.iconInvalid}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="habit-frequency">{t.native.habits.frequency}</Label>
          <Select
            id="habit-frequency"
            value={frequency}
            onChange={(e) => {
              const f = e.target.value as HabitFrequency;
              setFrequency(f);
              if (f !== "weekly" && target === "3") setTarget("1");
            }}
          >
            {(["weekly", "daily", "specific_days"] as const).map((f) => (
              <option key={f} value={f}>
                {t.native.habits.frequencies[f]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="habit-target">
            {t.native.habits.target} (
            {frequency === "weekly" ? t.native.habits.perWeek : t.native.habits.perDay})
          </Label>
          <Input
            id="habit-target"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="habit-unit">{t.native.habits.unit}</Label>
          <Input
            id="habit-unit"
            maxLength={30}
            value={unit}
            placeholder={t.native.habits.unitPlaceholder}
            onChange={(e) => setUnit(e.target.value)}
          />
        </div>
      </div>
      {frequency === "specific_days" && (
        <div className="flex flex-wrap gap-1.5">
          {WEEK_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}
              className={cn(
                "h-9 min-w-12 rounded-full border px-3 text-[13px]",
                days.includes(d)
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-border-strong text-muted",
              )}
            >
              {t.schedules.days[d]}
            </button>
          ))}
        </div>
      )}
      <RelatedGoals options={goalOptions} value={goals} onChange={setGoals} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {w.cancel}
        </Button>
        <Button
          type="submit"
          disabled={
            pending || !name.trim() || !iconOk || (frequency === "specific_days" && !days.length)
          }
        >
          {habit ? w.save : t.native.create}
        </Button>
      </div>
    </form>
  );
}

// ── Day cells and the quantity editor ────────────────────────────────────────

type Write = (habit: Habit, date: string, value: number | null, element?: Element) => void;

function DayButton({
  habit,
  cell,
  label,
  compact = false,
  readOnly,
  today,
  onBinary,
  onEdit,
}: {
  habit: Habit;
  cell: DayCell;
  label: ReactNode;
  compact?: boolean;
  readOnly: boolean;
  today: string;
  onBinary: (el: HTMLElement) => void;
  onEdit: (el: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const w = t.native.habits.ws;
  const fmt = useFormats();
  const measured = Boolean(habit.unit);
  const future = cell.state === "future";
  const share =
    measured && habit.frequency !== "weekly" ? Math.min(1, cell.value / habit.target) : 0;
  return (
    <button
      type="button"
      disabled={readOnly || future}
      onClick={(e) => (measured ? onEdit(e.currentTarget) : onBinary(e.currentTarget))}
      aria-pressed={measured ? undefined : cell.met}
      aria-label={w.dayLabel(
        `${habit.name}, ${fmt.long(cell.date)}`,
        measured && cell.value > 0
          ? `${cell.value} / ${habit.target} ${habit.unit}`
          : w.states[cell.state],
      )}
      className={cn(
        "relative flex w-full flex-col items-center justify-center overflow-hidden rounded-lg border transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
        compact ? "h-8 text-[11px]" : "h-12 text-[12px]",
        cell.met
          ? "border-accent bg-accent-soft text-accent-text"
          : cell.state === "partial"
            ? "border-accent-line text-accent-text"
            : cell.state === "missed"
              ? "border-border-strong text-muted hover:border-accent-line"
              : cell.state === "skipped"
                ? "border-dashed border-border text-faint line-through"
                : cell.state === "future"
                  ? "border-border text-faint opacity-40"
                  : cell.scheduled
                    ? "border-border-strong text-muted hover:border-accent-line"
                    : "border-dashed border-border text-faint hover:border-accent-line",
        cell.date === today && "ring-1 ring-accent",
      )}
    >
      {label}
      {share > 0 && share < 1 && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
          style={{ width: `${share * 100}%` }}
        />
      )}
    </button>
  );
}

function DayEditor({
  habit,
  date,
  value,
  anchor,
  onClose,
  onSave,
}: {
  habit: Habit;
  date: string;
  value: number;
  anchor: DOMRect;
  onClose: () => void;
  onSave: (v: number | null) => void;
}) {
  const { t } = useI18n();
  const e = t.native.habits.ws.editor;
  const fmt = useFormats();
  const [v, setV] = useState(value ? String(value) : "");
  const root = useRef<HTMLDivElement>(null);
  const step = habit.target >= 20 ? 5 : 1;
  const num = Number(v.replace(",", ".")) || 0;
  const [mobile] = useState(() => window.innerWidth < 640);
  useEffect(() => {
    const close = (ev: MouseEvent | KeyboardEvent) => {
      if (
        ev instanceof KeyboardEvent
          ? ev.key === "Escape"
          : !root.current?.contains(ev.target as Node)
      )
        onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);
  const left = Math.max(
    12,
    Math.min(anchor.left + anchor.width / 2 - 140, window.innerWidth - 292),
  );
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`${habit.name} · ${fmt.long(date)}`}
      className={cn(
        "fixed z-50 flex flex-col gap-3 border border-border-strong bg-[var(--menu-bg)] p-4 shadow-xl backdrop-blur",
        mobile ? "inset-x-0 bottom-0 rounded-t-2xl pb-6" : "w-[280px] rounded-2xl",
      )}
      style={mobile ? undefined : { top: anchor.bottom + 8, left }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px]">
          <span className="font-medium">{habit.name}</span>
          <span className="block text-muted first-letter:uppercase">{fmt.long(date)}</span>
        </p>
        <button
          type="button"
          aria-label={e.close}
          onClick={onClose}
          className="grid size-7 place-items-center rounded-full text-muted hover:bg-active"
        >
          <X className="size-4" />
        </button>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSave(num > 0 ? num : null);
        }}
      >
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            aria-label={e.minus}
            onClick={() => setV(String(Math.max(0, num - step)))}
          >
            <Minus />
          </Button>
          <Input
            autoFocus
            aria-label={e.value}
            inputMode="decimal"
            value={v}
            onChange={(ev) => setV(ev.target.value)}
            className="h-10 text-center font-mono"
          />
          <Button
            size="sm"
            variant="secondary"
            aria-label={e.plus}
            onClick={() => setV(String(num + step))}
          >
            <Plus />
          </Button>
        </div>
        <p className="text-center text-[12px] text-muted">
          {num} / {habit.target} {habit.unit}
        </p>
        <div className="flex flex-wrap justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>
            {e.clear}
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => onSave(habit.target)}>
              {e.complete}
            </Button>
            <Button size="sm" type="submit">
              {e.save}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ── One habit row ────────────────────────────────────────────────────────────

function CalendarGrid({
  habit,
  cells,
  today,
  readOnly,
  write,
  edit,
}: {
  habit: Habit;
  cells: DayCell[];
  today: string;
  readOnly: boolean;
  write: Write;
  edit: (habit: Habit, cell: DayCell, el: HTMLElement) => void;
}) {
  const fmt = useFormats();
  const lead = (new Date(`${cells[0]!.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return (
    <div className="grid grid-cols-7 gap-1">
      {WEEK_ORDER.map((d, i) => (
        <span key={d} className="text-center text-[10.5px] text-faint">
          {fmt.narrow(addDays("2026-01-05", i))}
        </span>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <span key={`pad-${i}`} />
      ))}
      {cells.map((c) => (
        <DayButton
          key={c.date}
          habit={habit}
          cell={c}
          compact
          today={today}
          readOnly={readOnly}
          label={<span className="font-mono">{Number(c.date.slice(8))}</span>}
          onBinary={(el) => write(habit, c.date, c.met ? null : 1, el)}
          onEdit={(el) => edit(habit, c, el)}
        />
      ))}
    </div>
  );
}

function MonthBars({
  months,
  onPick,
}: {
  months: { month: string; rate: number | null }[];
  onPick: (month: string) => void;
}) {
  const fmt = useFormats();
  return (
    <ol className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
      {months.map((m) => (
        <li key={m.month}>
          <button
            type="button"
            disabled={m.rate === null}
            onClick={() => onPick(m.month)}
            title={`${fmt.month(m.month)}: ${fmt.pct(m.rate)}`}
            className="flex w-full flex-col items-center gap-1 rounded-lg px-0.5 py-1 enabled:hover:bg-active disabled:opacity-40"
          >
            <span
              className="flex h-10 w-3 items-end overflow-hidden rounded-full bg-surface-2"
              aria-hidden
            >
              <span
                className="block w-full rounded-full bg-accent"
                style={{ height: `${Math.round((m.rate ?? 0) * 100)}%` }}
              />
            </span>
            <span className="text-[10.5px] text-faint capitalize">{fmt.month(m.month)}</span>
            <span className="font-mono text-[10.5px] text-muted">{fmt.pct(m.rate)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function HabitRow({
  habit,
  stats,
  entries,
  range,
  today,
  selected,
  risk,
  write,
  edit,
  onOpen,
  onEdit,
  goMonth,
  goals = [],
}: {
  habit: Habit;
  stats: HabitStats;
  entries: HabitEntry[];
  range: HabitRange;
  today: string;
  selected: boolean;
  risk: { atRisk: boolean; unreachable: boolean } | null;
  write: Write;
  edit: (habit: Habit, cell: DayCell, el: HTMLElement) => void;
  onOpen: () => void;
  onEdit: () => void;
  goMonth: (month: string) => void;
  /** Titles of the goals this habit relates to (ADR-055). */
  goals?: string[];
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const w = t.native.habits.ws;
  const fmt = useFormats();
  const { act } = useNative();
  const readOnly = habit.archived;
  const unit = habit.unit ? ` ${habit.unit}` : "";
  const menu = habit.archived
    ? [
        { label: w.menu.stats, onClick: onOpen },
        { label: w.menu.restore, onClick: () => act("habits.restore", { habit: habit.id }) },
      ]
    : [
        { label: w.menu.stats, onClick: onOpen },
        { label: w.menu.edit, onClick: onEdit },
        habit.active
          ? { label: w.menu.pause, onClick: () => act("habits.pause", { habit: habit.id }) }
          : {
              label: w.menu.resume,
              onClick: () => act("habits.pause", { habit: habit.id, resume: true }),
            },
        {
          label: w.menu.archive,
          onClick: async () =>
            (await confirm({ title: t.native.archiveConfirm(habit.name), destructive: true })) &&
            act("habits.archive", { habit: habit.id }),
        },
      ];
  menu.push({
    label: w.menu.delete,
    danger: true,
    onClick: async () =>
      (await confirm({ title: w.deleteConfirm(habit.name), destructive: true })) &&
      act("habits.delete", { habit: habit.id }),
  } as (typeof menu)[number]);
  const months =
    range.view === "year" || (range.view === "custom" && stats.days.length > 62)
      ? monthlyRates([habit], entries, range.from.slice(0, 4), today).filter(
          (m) => m.month >= range.from.slice(0, 7) && m.month <= range.to.slice(0, 7),
        )
      : null;

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-surface px-4 py-3.5 transition-colors",
        selected ? "border-accent-line" : "border-border",
        !habit.active && !habit.archived && "opacity-75",
      )}
    >
      <div className="flex items-center gap-3">
        <IconTile icon={habit.icon} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[15px] font-medium hover:text-accent-text">
            {habit.name}
          </span>
          <span className="block truncate text-[12.5px] text-muted">
            {targetText(habit, t)}
            {goals.length > 0 && (
              <span
                className="ml-2 inline-flex items-center gap-1 text-faint"
                title={goals.join(", ")}
              >
                <Target className="size-3" aria-hidden />
                <span className="sr-only">{t.native.goals.habitSide.title}: </span>
                {goals.length === 1 ? goals[0] : goals.length}
              </span>
            )}
            {!habit.active && !habit.archived && (
              <>
                {" · "}
                {habit.pausedUntil
                  ? w.pausedUntil(fmt.dayMonth(habit.pausedUntil))
                  : t.native.habits.paused}
              </>
            )}
          </span>
        </button>
        <div className="hidden w-40 shrink-0 flex-col gap-1 sm:flex">
          <span className="flex items-baseline justify-between font-mono text-[12.5px]">
            <span>
              {stats.done}
              {habit.frequency === "weekly" ? unit : ""} / {stats.goal}
            </span>
            <span className="text-muted">{fmt.pct(stats.progress)}</span>
          </span>
          <Bar value={stats.progress} flag={Boolean(risk?.atRisk)} />
        </div>
        <Menu label={w.menuFor(habit.name)} items={menu} />
      </div>
      <div className="flex items-center gap-2 sm:hidden">
        <Bar value={stats.progress} flag={Boolean(risk?.atRisk)} />
        <span className="shrink-0 font-mono text-[12px] text-muted">
          {stats.done} / {stats.goal}
        </span>
      </div>
      {risk?.atRisk && (
        <p className="-mt-1 text-[12px] text-approval-text">
          {risk.unreachable ? w.unreachable : w.risk}
        </p>
      )}

      {months ? (
        <MonthBars months={months} onPick={goMonth} />
      ) : stats.days.length === 7 ? (
        <ol className="grid grid-cols-7 gap-1.5">
          {stats.days.map((c) => (
            <li key={c.date}>
              <DayButton
                habit={habit}
                cell={c}
                today={today}
                readOnly={readOnly}
                onBinary={(el) => write(habit, c.date, c.met ? null : 1, el)}
                onEdit={(el) => edit(habit, c, el)}
                label={
                  <>
                    <span>{fmt.narrow(c.date)}</span>
                    <span className="font-mono text-[11px]">
                      {habit.unit
                        ? c.value > 0
                          ? `${c.value}/${habit.target}`
                          : "·"
                        : c.met
                          ? "✓"
                          : "·"}
                    </span>
                  </>
                }
              />
            </li>
          ))}
        </ol>
      ) : (
        <CalendarGrid
          habit={habit}
          cells={stats.days}
          today={today}
          readOnly={readOnly}
          write={write}
          edit={edit}
        />
      )}
    </li>
  );
}

// ── Analytics column and detail ──────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5">
      <h2 className="type-label text-faint">{title}</h2>
      {children}
    </section>
  );
}

function Heatmap({
  days,
  today,
}: {
  days: { date: string; value: number | null }[];
  today: string;
}) {
  const fmt = useFormats();
  if (!days.length) return null;
  const lead = (new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay() + 6) % 7;
  const cells = [...Array<null>(lead).fill(null), ...days];
  const weeks = Math.ceil(cells.length / 7);
  const wide = weeks > 6;
  return (
    <div
      className="grid gap-[3px]"
      style={
        wide
          ? {
              gridTemplateRows: "repeat(7, minmax(0, 1fr))",
              gridAutoFlow: "column",
              gridAutoColumns: "minmax(0, 1fr)",
            }
          : { gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }
      }
    >
      {cells.map((d, i) =>
        d ? (
          <span
            key={d.date}
            title={`${fmt.long(d.date)}: ${fmt.pct(d.value)}`}
            className={cn(
              "aspect-square rounded-[3px]",
              d.value === null ? "bg-surface-2/40" : d.value === 0 ? "bg-surface-2" : "bg-accent",
              d.date === today && "ring-1 ring-fg/40",
            )}
            style={d.value ? { opacity: 0.25 + 0.75 * d.value } : undefined}
          />
        ) : (
          <span key={`pad-${i}`} />
        ),
      )}
    </div>
  );
}

function AnalyticsColumn({
  habits,
  entries,
  range,
  today,
}: {
  habits: Habit[];
  entries: HabitEntry[];
  range: HabitRange;
  today: string;
}) {
  const { t } = useI18n();
  const w = t.native.habits.ws;
  const fmt = useFormats();
  const active = habits.filter((h) => h.active && !h.archived);
  const trend = useMemo(
    () => habitsTrend(active, entries, range, today),
    [active, entries, range, today],
  );
  const points = trend.points.filter((p) => p.rate !== null);
  const trendSpec: VisualizationSpec | null =
    points.length >= 2
      ? ({
          type: points.length > 31 ? "line" : "bar",
          title: w.trend,
          format: { kind: "percent" },
          x: points.map((p) =>
            trend.granularity === "month" ? fmt.month(p.key) : fmt.dayMonth(p.key),
          ),
          series: [{ name: w.completion, values: points.map((p) => Math.round(p.rate! * 100)) }],
        } as VisualizationSpec)
      : null;
  const byHabit = active
    .map((h) => ({ h, s: habitStats(h, entries, range, today) }))
    .filter((x) => x.s.rate !== null)
    .sort((a, b) => a.s.rate! - b.s.rate!)
    .slice(0, 12);
  const misses = weekdayMisses(active, entries, range, today).filter((m) => m.expected > 0);
  const heat = range.view === "week" ? [] : dailyIntensity(active, entries, range, today);
  if (!active.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {trendSpec && (
        <Panel title={w.trend}>
          <Visualization spec={{ ...trendSpec, title: "" } as VisualizationSpec} size="small" />
        </Panel>
      )}
      {byHabit.length >= 2 && (
        <Panel title={w.byHabit}>
          <ul className="flex flex-col gap-2">
            {byHabit.map(({ h, s }) => (
              <li key={h.id} className="flex flex-col gap-1 text-[13px]">
                <span className="flex justify-between gap-2">
                  <span className="truncate">
                    {h.icon ? `${h.icon} ` : ""}
                    {h.name}
                  </span>
                  <span className="font-mono text-[12px] text-muted">{fmt.pct(s.rate)}</span>
                </span>
                <Bar value={s.rate} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {heat.length > 0 && (
        <Panel title={w.heatmap}>
          <Heatmap days={heat} today={today} />
        </Panel>
      )}
      {misses.some((m) => m.missed > 0) && (
        <Panel title={w.weekdays}>
          <ul className="flex flex-col gap-1.5">
            {WEEK_ORDER.map((d) => misses.find((m) => m.weekday === d))
              .filter((m): m is NonNullable<typeof m> => Boolean(m))
              .map((m) => (
                <li
                  key={m.weekday}
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-[12.5px]"
                >
                  <span className="text-muted">{t.schedules.days[m.weekday]}</span>
                  <Bar value={m.missed / m.expected} flag />
                  <span className="text-right font-mono text-faint">
                    {m.missed}/{m.expected}
                  </span>
                </li>
              ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function HabitDetail({
  habit,
  entries,
  range,
  today,
  onClose,
}: {
  habit: Habit;
  entries: HabitEntry[];
  range: HabitRange;
  today: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const w = t.native.habits.ws;
  const d = w.detail;
  const fmt = useFormats();
  const [history, setHistory] = useState<HabitEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    void habitHistoryAction(habit.id).then((r) => live && r.ok && setHistory(r.value));
    return () => {
      live = false;
    };
  }, [habit.id, entries]);
  // The full history when loaded, else the window the screen already has.
  const all = useMemo(() => {
    if (!history) return entries;
    const inWindow = new Set(entries.filter((e) => e.habitId === habit.id).map((e) => e.date));
    return [
      ...history.filter((e) => !inWindow.has(e.date)),
      ...entries.filter((e) => e.habitId === habit.id),
    ];
  }, [history, entries, habit.id]);
  const s = habitStats(habit, all, range, today);
  const prev = habitStats(habit, all, previousRange(range), today);
  const delta = rateDelta(s.rate, prev.rate);
  const current = habitProgress(habit, all, today).streak;
  const longest = history ? longestStreak(habit, all, today) : null;
  const twelve = habitStats(habit, all, { from: addDays(today, -83), to: today }, today);
  const trend = habitsTrend([habit], all, range, today);
  const points = trend.points.filter((p) => p.rate !== null);
  const streakText = (x: { count: number; unit: "days" | "weeks" }) =>
    t.native.habits.streak(x.count, x.unit).replace(/^\S+ \S+ /, "");
  const stat = (label: string, value: string, sub?: string) => (
    <div className="flex flex-col gap-0.5 rounded-xl bg-surface-2/60 px-3 py-2">
      <span className="text-[11.5px] text-muted">{label}</span>
      <span className="font-mono text-[15px]">{value}</span>
      {sub && <span className="text-[11px] text-faint">{sub}</span>}
    </div>
  );
  return (
    <section
      aria-label={habit.name}
      className="flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface p-4 max-xl:fixed max-xl:inset-0 max-xl:z-40 max-xl:overflow-y-auto max-xl:rounded-none max-xl:pb-10"
    >
      <div className="flex items-start gap-3">
        <IconTile icon={habit.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-medium">{habit.name}</h2>
          <p className="text-[12.5px] text-muted">{targetText(habit, t)}</p>
        </div>
        <button
          type="button"
          aria-label={d.close}
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-muted hover:bg-active"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="flex justify-between text-[12.5px]">
          <span className="text-muted">
            {d.period} · {fmt.range(range)}
          </span>
          <span className="font-mono">
            {s.done} / {s.goal}
          </span>
        </span>
        <Bar value={s.progress} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {stat(d.completion, fmt.pct(s.rate), delta !== null ? w.vsPrevious(delta) : undefined)}
        {stat(d.previous, fmt.pct(prev.rate))}
        {stat(d.current, current.count ? streakText(current) : "0")}
        {stat(d.longest, longest ? (longest.count ? streakText(longest) : "0") : "…")}
        {s.quantity && stat(d.total, `${s.quantity.total} ${habit.unit}`)}
        {s.quantity?.perActiveDay != null &&
          stat(d.average, `${s.quantity.perActiveDay} ${habit.unit}`)}
        {s.attainment !== null && stat(d.attainment, fmt.pct(s.attainment))}
      </div>
      {points.length >= 2 && (
        <Visualization
          size="small"
          spec={
            {
              type: points.length > 31 ? "line" : "bar",
              title: "",
              format: { kind: "percent" },
              x: points.map((p) =>
                trend.granularity === "month" ? fmt.month(p.key) : fmt.dayMonth(p.key),
              ),
              series: [
                { name: d.completion, values: points.map((p) => Math.round(p.rate! * 100)) },
              ],
            } as VisualizationSpec
          }
        />
      )}
      <div className="flex flex-col gap-2">
        <h3 className="type-label text-faint">{d.history}</h3>
        <Heatmap
          days={twelve.days.map((c) => ({
            date: c.date,
            value: c.state === "future" ? null : c.met ? 1 : c.value > 0 ? 0.5 : 0,
          }))}
          today={today}
        />
        {!history && <p className="text-[12px] text-faint">{d.loading}</p>}
      </div>
    </section>
  );
}

// ── Workspace ────────────────────────────────────────────────────────────────

export function HabitsView({ data, workspaceId }: { data: HabitsWorkspace; workspaceId: string }) {
  const { t } = useI18n();
  const desktop = useIsDesktop();
  const w = t.native.habits.ws;
  const fmt = useFormats();
  const router = useRouter();
  const { set } = useHabitUrl();
  const { range, today, status } = data;

  // Optimistic entries: server props reset them; a local write shows at once.
  const [entries, setEntries] = useState(data.entries);
  const [seen, setSeen] = useState(data.entries);
  if (data.entries !== seen) {
    setSeen(data.entries);
    setEntries(data.entries);
  }
  const lastWrite = useRef(0);
  useRealtimeRefresh(workspaceId, ["habits", "habit_entries"], () => {
    // Our own check-ins are already on screen; other devices and Chat refresh the view.
    if (Date.now() - lastWrite.current > 4000) router.refresh();
  });

  const [panel, setPanel] = useState<"new" | "import" | null>(null);
  const [starter, setStarter] = useState("");
  const [editing, setEditing] = useState<Habit | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [customOpen, setCustomOpen] = useState(range.view === "custom");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [editor, setEditor] = useState<{ habit: Habit; cell: DayCell; rect: DOMRect } | null>(null);

  const write: Write = (habit, date, value, element) => {
    if (date > today) return;
    const before = entries;
    // Not met → met, by this tap: the completion feedback (never on undo or a lower value).
    const was = entries.find((e) => e.habitId === habit.id && e.date === date);
    if (completesDay(habit, was, value))
      completionFeedback({ kind: "habit", key: `habit:${habit.id}:${date}`, element });
    setEntries((cur) => {
      const rest = cur.filter((e) => !(e.habitId === habit.id && e.date === date));
      return value === null
        ? rest
        : [
            ...rest,
            {
              id: `local-${habit.id}-${date}`,
              habitId: habit.id,
              date,
              value,
              status: "done",
              notes: null,
              source: "user_ui",
            },
          ];
    });
    lastWrite.current = Date.now();
    const args =
      value === null
        ? { habit: habit.id, date, status: "undo" }
        : habit.unit
          ? { habit: habit.id, date, value, mode: "set" }
          : { habit: habit.id, date, status: "done" };
    void habitCheckInAction(args).then((r) => {
      if (!r.ok) {
        setEntries(before);
        toast.error(errorText(t, r.error));
      }
    });
  };

  const visible = data.habits.filter(
    (h) => !q.trim() || h.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const stats = useMemo(
    () => new Map(data.habits.map((h) => [h.id, habitStats(h, entries, range, today)])),
    [data.habits, entries, range, today],
  );
  const weekly = useMemo(
    () => new Map(data.habits.map((h) => [h.id, habitProgress(h, entries, today).week])),
    [data.habits, entries, today],
  );
  const atRisk = data.habits.filter((h) => h.active && weekly.get(h.id)?.atRisk).map((h) => h.id);
  const summary = useMemo(
    () => habitsSummary(data.habits, entries, range, today, atRisk),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- atRisk derives from the same inputs
    [data.habits, entries, range, today],
  );
  const previous = useMemo(
    () => habitsSummary(data.habits, entries, previousRange(range), today),
    [data.habits, entries, range, today],
  );
  const delta = rateDelta(summary.rate, previous.rate);
  const selected = data.habits.find((h) => h.id === selectedId) ?? null;
  const showRisk = containsToday(range, today) || range.view !== "week";

  const go = (r: HabitRange) =>
    set({
      view: r.view === "week" ? null : r.view,
      date: r.view === "custom" || containsToday(r, today) ? null : r.from,
      from: r.view === "custom" ? r.from : null,
      to: r.view === "custom" ? r.to : null,
    });

  const exportCsv = () =>
    void habitsCsvAction().then((r) => {
      if (!r.ok) return toast.error(errorText(t, r.error));
      const url = URL.createObjectURL(new Blob([r.value], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `elise-habitos-${today}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const empty = data.counts.active + data.counts.paused + data.counts.archived === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Range + actions */}
      {/*
        Phones (ADR-066): "Nuevo hábito" first, within reach, with ⋯ (status, import, export);
        then the period as a full-width segmented control and one ‹ range › row.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 max-md:w-full">
          <div
            role="radiogroup"
            aria-label={w.views.week}
            className="flex rounded-full bg-surface-2 p-0.5 max-md:w-full max-md:[&>button]:h-10 max-md:[&>button]:flex-1"
          >
            {(["week", "month", "year", "custom"] as HabitView[]).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={
                  range.view === v || (v === "custom" && customOpen && range.view !== v)
                }
                onClick={() => {
                  if (v === "custom") return setCustomOpen(true);
                  setCustomOpen(false);
                  go(habitRange(v, containsToday(range, today) ? today : range.from));
                }}
                className={cn(
                  "h-8 rounded-full px-3 text-[13px] transition-colors",
                  range.view === v
                    ? "bg-bg font-medium text-fg shadow-sm"
                    : "text-muted hover:text-fg",
                )}
              >
                {w.views[v]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 max-md:w-full max-md:justify-between">
            <Button
              size="sm"
              variant="ghost"
              aria-label={w.prev}
              onClick={() => go(shiftHabitRange(range, -1))}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-28 text-center text-[14px] font-medium first-letter:uppercase">
              {fmt.range(range)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={w.next}
              onClick={() => go(shiftHabitRange(range, 1))}
            >
              <ChevronRight />
            </Button>
            {!containsToday(range, today) && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => go(habitRange(range.view === "custom" ? "week" : range.view, today))}
              >
                {w.today}
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:order-first max-md:w-full">
          <Select
            aria-label={w.status.active}
            value={status}
            className="h-9 w-auto max-md:hidden"
            onChange={(e) => set({ status: e.target.value === "active" ? null : e.target.value })}
          >
            {(["active", "paused", "archived"] as const).map((s) => (
              <option key={s} value={s}>
                {w.status[s]} ({data.counts[s]})
              </option>
            ))}
          </Select>
          {data.habits.length > 6 && (
            <div className="relative max-md:order-last max-md:w-full">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
                aria-hidden
              />
              <Input
                aria-label={w.search}
                placeholder={w.search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-9 w-48 pl-9 max-md:h-11 max-md:w-full"
              />
            </div>
          )}
          <Button
            className="max-md:flex-1"
            onClick={() => {
              setStarter("");
              setPanel(panel === "new" ? null : "new");
            }}
          >
            <Plus />
            {t.native.habits.new}
          </Button>
          <Menu
            label={w.more}
            items={[
              // Phones: which habits to show lives here (the select is for wider screens).
              ...(desktop
                ? []
                : (["active", "paused", "archived"] as const)
                    .filter((x) => x !== status)
                    .map((x) => ({
                      label: `${w.status[x]} (${data.counts[x]})`,
                      onClick: () => set({ status: x === "active" ? null : x }),
                    }))),
              { label: t.native.importCsv, onClick: () => setPanel("import") },
              { label: w.exportCsv, onClick: exportCsv },
            ]}
          />
        </div>
      </div>
      {!desktop && status !== "active" && (
        <button
          type="button"
          onClick={() => set({ status: null })}
          className="flex h-9 w-fit items-center gap-1.5 rounded-full border border-accent-line bg-accent-soft px-3.5 text-[14px] text-accent-text"
        >
          {w.status[status]} ({data.counts[status]})
          <X className="size-3.5" aria-hidden />
        </button>
      )}
      {customOpen && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (from && to && from <= to) go(habitRange("custom", from, { from, to }));
          }}
        >
          <Input
            type="date"
            aria-label={w.from}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-auto"
          />
          <Input
            type="date"
            aria-label={w.to}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-auto"
          />
          <Button size="sm" type="submit" variant="secondary">
            {w.apply}
          </Button>
        </form>
      )}

      {/* Summary */}
      {status === "active" && summary.active > 0 && (
        <dl className="flex items-stretch divide-x divide-border rounded-2xl border border-border bg-surface text-[13px] md:flex-wrap max-md:[&>div]:flex-1 max-md:[&>div]:px-3">
          <div className="flex flex-col gap-0.5 px-4 py-2.5">
            <dt className="text-muted">{w.completion}</dt>
            <dd className="font-mono text-[18px]">
              {fmt.pct(summary.rate)}
              {delta !== null && (
                <span
                  className={cn(
                    "ml-2 text-[11.5px] max-md:ml-0 max-md:block",
                    delta >= 0 ? "text-success" : "text-faint",
                  )}
                >
                  {w.vsPrevious(delta)}
                </span>
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5 px-4 py-2.5">
            <dt className="text-muted">{w.activeCount}</dt>
            <dd className="font-mono text-[18px]">{summary.active}</dd>
          </div>
          {showRisk && (
            <div className="flex flex-col gap-0.5 px-4 py-2.5">
              <dt className="text-muted">{w.atRisk}</dt>
              <dd
                className={cn("font-mono text-[18px]", atRisk.length > 0 && "text-approval-text")}
              >
                {atRisk.length}
              </dd>
            </div>
          )}
          {summary.bestStreak && (
            <div className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5 max-md:hidden">
              <dt className="text-muted">{w.bestStreak}</dt>
              <dd className="truncate text-[14px]">
                <span className="font-mono text-[18px]">{summary.bestStreak.count}</span>{" "}
                {summary.bestStreak.unit === "weeks"
                  ? t.native.habits.streak(summary.bestStreak.count, "weeks").split(" ").at(-1)
                  : t.native.habits.streak(summary.bestStreak.count, "days").split(" ").at(-1)}
                <span className="text-muted"> · {summary.bestStreak.name}</span>
              </dd>
            </div>
          )}
        </dl>
      )}

      {panel === "new" && (
        <HabitForm
          key={starter}
          initialName={starter}
          goalOptions={data.goals}
          onDone={() => setPanel(null)}
        />
      )}
      {panel === "import" && <ImportPanel kind="habits" onDone={() => setPanel(null)} />}
      {editing && (
        <HabitForm
          key={editing.id}
          habit={editing}
          goalOptions={data.goals}
          onDone={() => setEditing(null)}
        />
      )}

      {empty && panel !== "new" ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <h2 className="font-medium">{w.emptyTitle}</h2>
          <p className="max-w-md text-[13.5px] text-muted">{w.emptyBody}</p>
          <Button onClick={() => setPanel("new")}>
            <Plus />
            {t.native.habits.new}
          </Button>
          <div className="flex flex-wrap justify-center gap-1.5">
            {w.starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setStarter(s);
                  setPanel("new");
                }}
                className="rounded-full bg-surface-2 px-3 py-1 text-[13px] text-muted hover:text-fg"
              >
                {suggestHabitIcon(s) ?? ""} {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
          {visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
              {q.trim() ? w.noMatch : w.none[status]}
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {visible.map((h) => (
                <HabitRow
                  key={h.id}
                  habit={h}
                  stats={stats.get(h.id)!}
                  entries={entries}
                  range={range}
                  today={today}
                  selected={h.id === selectedId}
                  risk={h.active && containsToday(range, today) ? (weekly.get(h.id) ?? null) : null}
                  write={write}
                  edit={(habit, cell, el) =>
                    setEditor({ habit, cell, rect: el.getBoundingClientRect() })
                  }
                  onOpen={() => setSelectedId(h.id === selectedId ? null : h.id)}
                  onEdit={() => setEditing(h)}
                  goMonth={(m) => go(habitRange("month", `${m}-01`))}
                  goals={(data.goals.links[h.id] ?? []).map(
                    (l) => data.goals.goals.find((g) => g.id === l.goalId)?.title ?? "",
                  )}
                />
              ))}
            </ul>
          )}
          <aside className="flex flex-col gap-3">
            {selected ? (
              <HabitDetail
                key={selected.id}
                habit={selected}
                entries={entries}
                range={range}
                today={today}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              status === "active" && (
                <AnalyticsColumn
                  habits={data.habits}
                  entries={entries}
                  range={range}
                  today={today}
                />
              )
            )}
          </aside>
        </div>
      )}
      {editor && (
        <DayEditor
          habit={editor.habit}
          date={editor.cell.date}
          value={editor.cell.value}
          anchor={editor.rect}
          onClose={() => setEditor(null)}
          onSave={(v) => {
            write(editor.habit, editor.cell.date, v);
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}
