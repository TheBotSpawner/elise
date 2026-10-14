"use client";

import { Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  drivesProgress,
  goalProblems,
  isGoalIcon,
  type Goal,
  type NewGoal,
  type ProgressMode,
  type Vision,
} from "@/core/capabilities/goals";
import { inferGoalDraft, suggestGoalIcon, visionIdsOf } from "@/core/goals/analytics";
import {
  periodLabel,
  presetOf,
  quarterName,
  resolveGoalPeriod,
  type GoalPeriodPreset,
} from "@/core/goals/periods";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useNative } from "./use-native";

/**
 * Goal and Vision creation / editing (ADR-055): one compact dialog for both, primary fields
 * first (name, how it's measured, target, period) and everything else one tap away. The same
 * tools as Chat validate and save; the form only checks what it can show inline.
 */

type Measure = "binary" | "number" | "percentage" | "money" | "decrease";
type Section = "vision" | "habits" | "description" | "deadline" | "area" | "parent" | "related";

const QUICK_ICONS = ["🎯", "🚀", "💰", "🤝", "📰", "📚", "🎓", "🏋️", "🧠", "⚙️", "✈️", "❤️"];
const CURRENCIES = ["ARS", "USD", "EUR", "BRL", "CLP", "MXN", "UYU"];
const PERIOD_OPTIONS: GoalPeriodPreset[] = [
  "this_quarter",
  "next_quarter",
  "q1",
  "q2",
  "q3",
  "q4",
  "this_year",
  "next_year",
  "months_3",
  "months_6",
  "months_12",
  "custom",
  "none",
];

const textareaClass =
  "min-h-20 w-full resize-y rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none";

const measureOf = (g: Goal): Measure =>
  g.progressType === "binary"
    ? "binary"
    : g.progressType === "percentage"
      ? "percentage"
      : g.direction === "decrease"
        ? "decrease"
        : g.currency
          ? "money"
          : "number";

const num = (v: string) => {
  const s = v.trim().replace(/\s/g, "");
  if (!s) return null;
  // "10.000.000" and "1.234,5" (es) as well as "1,234.5" (en).
  const n = Number(
    /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,(?=\d{3}\b)/g, "").replace(",", "."),
  );
  return Number.isFinite(n) ? n : null;
};

export interface GoalOptions {
  visions: Pick<Vision, "id" | "title" | "icon">[];
  habits: { id: string; name: string; icon: string | null }[];
  goals: { id: string; title: string; icon: string | null }[];
  areas: string[];
}

function Field({
  id,
  label,
  children,
  hint,
}: {
  id: string;
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[12.5px] text-muted">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11.5px] text-faint">{hint}</p>}
    </div>
  );
}

function Chip({
  label,
  icon,
  onRemove,
  removeLabel,
  children,
}: {
  label: string;
  icon?: string | null;
  onRemove: () => void;
  removeLabel: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[13px]">
      {icon && <span aria-hidden>{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="grid size-6 place-items-center rounded-full text-faint hover:bg-active hover:text-fg"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

function IconPicker({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
}) {
  const { t } = useI18n();
  const f = t.native.goals.form;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        id={id}
        type="button"
        aria-label={f.icon}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-11 place-items-center rounded-xl border border-border bg-surface text-[22px] hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        {value || "🎯"}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1.5 flex w-64 flex-col gap-2 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] p-3 shadow-[var(--menu-shadow)]">
          <div className="grid grid-cols-6 gap-1" role="group" aria-label={f.icon}>
            {QUICK_ICONS.map((i) => (
              <button
                key={i}
                type="button"
                aria-pressed={value === i}
                onClick={() => {
                  onChange(i);
                  setOpen(false);
                }}
                className={cn(
                  "grid size-9 place-items-center rounded-lg text-[18px]",
                  value === i ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-surface-2",
                )}
              >
                {i}
              </button>
            ))}
          </div>
          <Input
            aria-label={f.icon}
            value={value}
            maxLength={16}
            onChange={(e) => onChange(e.target.value.trim())}
            className="h-9"
          />
        </div>
      )}
    </div>
  );
}

export function GoalDialog({
  open,
  onClose,
  goal,
  today,
  options,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  goal?: Goal | null;
  today: string;
  options: GoalOptions;
  initial?: { title?: string; visionId?: string };
}) {
  const { t } = useI18n();
  const f = t.native.goals.form;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={goal ? f.editTitle : f.newTitle}
      className="border-border-strong bg-[var(--overlay-bg)] shadow-[0_32px_96px_-24px_rgba(0,0,0,0.55)] sm:max-w-xl"
    >
      <GoalForm
        goal={goal ?? null}
        today={today}
        options={options}
        initial={initial}
        onDone={onClose}
      />
    </Dialog>
  );
}

function GoalForm({
  goal,
  today,
  options,
  initial,
  onDone,
}: {
  goal: Goal | null;
  today: string;
  options: GoalOptions;
  initial?: { title?: string; visionId?: string };
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const g = t.native.goals;
  const f = g.form;
  const { act, pending } = useNative();

  const [title, setTitle] = useState(goal?.title ?? initial?.title ?? "");
  const [icon, setIcon] = useState(goal?.icon ?? suggestGoalIcon(initial?.title ?? "") ?? "");
  const [iconTouched, setIconTouched] = useState(Boolean(goal));
  const [measure, setMeasure] = useState<Measure>(goal ? measureOf(goal) : "number");
  const [target, setTarget] = useState(goal?.targetValue?.toString() ?? "");
  const [unit, setUnit] = useState(goal?.metric ?? "");
  const [currency, setCurrency] = useState(goal?.currency ?? "ARS");
  const [start, setStart] = useState(goal?.startValue?.toString() ?? "");
  const [current, setCurrent] = useState(goal?.currentValue?.toString() ?? "");
  const startPeriod =
    goal?.periodStart && goal.periodEnd ? { from: goal.periodStart, to: goal.periodEnd } : null;
  const [preset, setPreset] = useState<GoalPeriodPreset>(
    goal ? presetOf(startPeriod, today) : "this_year",
  );
  const [from, setFrom] = useState(startPeriod?.from ?? today);
  const [to, setTo] = useState(startPeriod?.to ?? "");
  const [touched, setTouched] = useState<Set<string>>(new Set(goal ? ["all"] : []));
  const [suggested, setSuggested] = useState(false);

  const followsPeriod = !goal?.targetDate || goal.targetDate === goal.periodEnd;
  const [deadline, setDeadline] = useState(goal && !followsPeriod ? (goal.targetDate ?? "") : "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [area, setArea] = useState(goal?.area ?? "");
  const [visionIds, setVisionIds] = useState<string[]>(
    goal ? visionIdsOf(goal) : initial?.visionId ? [initial.visionId] : [],
  );
  const [habits, setHabits] = useState<{ id: string; use: boolean }[]>(
    goal?.links
      .filter((l) => l.resourceType === "habit")
      .map((l) => ({ id: l.resourceId, use: drivesProgress(l) })) ?? [],
  );
  const [parentId, setParentId] = useState(goal?.parentGoalId ?? "");
  const [relatedIds, setRelatedIds] = useState<string[]>(
    goal?.links.filter((l) => l.resourceType === "goal").map((l) => l.resourceId) ?? [],
  );
  const [mode, setMode] = useState<ProgressMode>(goal?.progressMode ?? "manual");
  const [sections, setSections] = useState<Set<Section>>(() => {
    const s = new Set<Section>();
    if (visionIds.length) s.add("vision");
    if (habits.length) s.add("habits");
    if (description) s.add("description");
    if (deadline) s.add("deadline");
    if (area) s.add("area");
    if (parentId) s.add("parent");
    if (relatedIds.length) s.add("related");
    return s;
  });
  const show = (s: Section) => setSections(new Set([...sections, s]));
  const touch = (k: string) => setTouched(new Set([...touched, k]));

  const period = useMemo(
    () => resolveGoalPeriod(preset, today, preset === "custom" ? { from, to } : {}),
    [preset, today, from, to],
  );
  const canDrive = measure === "number" || measure === "money";
  const anyDriver = canDrive && habits.some((h) => h.use);

  const fields: NewGoal = {
    title: title.trim(),
    progressType:
      measure === "binary" ? "binary" : measure === "percentage" ? "percentage" : "numeric",
    progressMode: mode,
    direction: measure === "decrease" ? "decrease" : "increase",
    targetValue: measure === "percentage" ? 100 : measure === "binary" ? null : num(target),
    startValue: measure === "decrease" ? num(start) : (goal?.startValue ?? null),
    currentValue: num(current),
    metric:
      measure === "money" || measure === "binary" || measure === "percentage"
        ? null
        : unit.trim() || null,
    currency: measure === "money" ? currency : null,
    periodStart: period?.from ?? null,
    periodEnd: period?.to ?? null,
  };
  const problems = title.trim() ? goalProblems(fields) : [];
  const iconOk = !icon || isGoalIcon(icon);

  /** Safe suggestions from the name, only for fields the user hasn't touched. */
  const suggest = () => {
    if (goal || !title.trim()) return;
    const d = inferGoalDraft(title, today);
    let used = false;
    if (!iconTouched) setIcon(suggestGoalIcon(title) ?? icon);
    if (!touched.has("measure") && d.progressType) {
      const m: Measure =
        d.progressType === "binary"
          ? "binary"
          : d.currency
            ? "money"
            : d.direction === "decrease"
              ? "decrease"
              : "number";
      setMeasure(m);
      used = true;
    }
    if (!touched.has("target") && d.targetValue) {
      setTarget(String(d.targetValue));
      used = true;
    }
    if (!touched.has("unit") && d.metric) setUnit(d.metric);
    if (!touched.has("currency") && d.currency) setCurrency(d.currency);
    if (!touched.has("period") && d.period) {
      setPreset(d.period);
      if (d.period === "custom" && d.to) {
        setFrom(today);
        setTo(d.to);
      }
      used = true;
    }
    setSuggested(used);
  };

  const submit = () => {
    if (problems.length || !iconOk || !fields.title || (preset === "custom" && !period)) return;
    const periodArgs = preset === "custom" ? { period: "custom", from, to } : { period: preset };
    const base = {
      title: fields.title,
      progressType: fields.progressType,
      direction: fields.direction,
      ...(fields.progressType === "numeric" ? { targetValue: fields.targetValue } : {}),
      ...(measure === "decrease" ? { startValue: fields.startValue } : {}),
      ...(fields.currentValue !== null ? { currentValue: fields.currentValue } : {}),
    };
    const habitArgs = habits.map((h) => ({ habit: h.id, useForProgress: canDrive && h.use }));
    if (!goal) {
      act(
        "goals.create",
        {
          ...base,
          ...(icon ? { icon } : {}),
          ...(fields.metric ? { metric: fields.metric } : {}),
          ...(fields.currency ? { currency: fields.currency } : {}),
          ...periodArgs,
          ...(deadline ? { targetDate: deadline } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(area.trim() ? { area: area.trim() } : {}),
          ...(visionIds.length ? { visions: visionIds } : {}),
          ...(habitArgs.length ? { habits: habitArgs } : {}),
          ...(parentId ? { parentGoal: parentId } : {}),
          progressMode: anyDriver ? "linked" : "manual",
        },
        onDone,
      );
      return;
    }
    const periodChanged =
      (period?.from ?? null) !== (goal.periodStart ?? null) ||
      (period?.to ?? null) !== (goal.periodEnd ?? null);
    act(
      "goals.update",
      {
        goal: goal.id,
        ...base,
        icon: icon || null,
        metric: fields.metric,
        currency: fields.currency,
        ...(periodChanged ? periodArgs : {}),
        ...(deadline ? { targetDate: deadline } : !followsPeriod ? { targetDate: null } : {}),
        description: description.trim() || null,
        area: area.trim() || null,
        visions: visionIds,
        habits: habitArgs,
        relatedGoals: relatedIds,
        parentGoal: parentId || null,
        // With habits driving it, the user picks linked or both; without, it is manual (server).
        ...(anyDriver ? { progressMode: mode === "manual" ? "linked" : mode } : {}),
      },
      onDone,
    );
  };

  const otherGoals = options.goals.filter((x) => x.id !== goal?.id);
  const periodText = period ? periodLabel(period, locale) : null;
  const addButton = (s: Section, label: string) =>
    sections.has(s) ? null : (
      <button
        key={s}
        type="button"
        onClick={() => show(s)}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border-strong px-3 text-[12.5px] text-muted hover:border-accent hover:text-fg"
      >
        <Plus className="size-3.5" aria-hidden />
        {label}
      </button>
    );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-3">
        <IconPicker
          id="goal-icon"
          value={icon}
          onChange={(v) => {
            setIcon(v);
            setIconTouched(true);
          }}
        />
        <div className="min-w-0 flex-1">
          <Field id="goal-name" label={f.name}>
            <Input
              id="goal-name"
              data-autofocus
              required
              maxLength={300}
              value={title}
              placeholder={f.namePlaceholder}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={suggest}
              className="h-11"
            />
          </Field>
        </div>
      </div>
      {!iconOk && <p className="text-[12.5px] text-danger-text">{f.iconInvalid}</p>}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12.5px] text-muted" id="goal-measure-label">
          {f.measure}
        </span>
        <div
          role="radiogroup"
          aria-labelledby="goal-measure-label"
          className="grid grid-cols-3 gap-1 rounded-2xl border border-border bg-bg p-1 sm:grid-cols-5"
        >
          {(["number", "money", "percentage", "decrease", "binary"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={measure === m}
              onClick={() => {
                setMeasure(m);
                touch("measure");
              }}
              className={cn(
                "h-9 rounded-xl px-2 text-[13px] transition-colors",
                measure === m
                  ? "bg-accent-soft font-medium text-accent-text"
                  : "text-muted hover:text-fg",
              )}
            >
              {f.measures[m]}
            </button>
          ))}
        </div>
        {suggested && <p className="text-[11.5px] text-faint">{f.suggested}</p>}
      </div>

      {measure !== "binary" && measure !== "percentage" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {measure === "decrease" && (
            <Field id="goal-start" label={f.start}>
              <Input
                id="goal-start"
                inputMode="decimal"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="font-mono"
              />
            </Field>
          )}
          <Field id="goal-target" label={f.target}>
            <Input
              id="goal-target"
              inputMode="decimal"
              value={target}
              placeholder="12"
              onChange={(e) => {
                setTarget(e.target.value);
                touch("target");
              }}
              className="font-mono"
            />
          </Field>
          {measure === "money" ? (
            <Field id="goal-currency" label={f.currency}>
              <Select
                id="goal-currency"
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  touch("currency");
                }}
              >
                {[...new Set([currency, ...CURRENCIES])].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field id="goal-unit" label={f.unit}>
              <Input
                id="goal-unit"
                maxLength={60}
                value={unit}
                placeholder={f.unitPlaceholder}
                onChange={(e) => {
                  setUnit(e.target.value);
                  touch("unit");
                }}
              />
            </Field>
          )}
          {goal && measure !== "decrease" && (
            <Field id="goal-current" label={f.current}>
              <Input
                id="goal-current"
                inputMode="decimal"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="font-mono"
              />
            </Field>
          )}
        </div>
      )}
      {measure === "percentage" && goal && (
        <Field id="goal-current" label={f.current}>
          <Input
            id="goal-current"
            inputMode="decimal"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="w-32 font-mono"
          />
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <Field id="goal-period" label={f.period} hint={periodText ?? undefined}>
          <Select
            id="goal-period"
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value as GoalPeriodPreset);
              touch("period");
            }}
          >
            {PERIOD_OPTIONS.map((p) => {
              const r = p === "custom" || p === "none" ? null : resolveGoalPeriod(p, today);
              const label = /^q[1-4]$/.test(p)
                ? `${quarterName(Number(p[1]), locale)} ${r?.from.slice(0, 4) ?? ""}`
                : g.periods[p];
              return (
                <option key={p} value={p}>
                  {label}
                  {r && !/^q[1-4]$/.test(p) ? ` · ${periodLabel(r, locale)}` : ""}
                </option>
              );
            })}
          </Select>
        </Field>
        {preset === "custom" && (
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label={f.from}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <Input
              type="date"
              aria-label={f.to}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* Optional, one tap away */}
      {sections.has("vision") && (
        <Field id="goal-visions" label={f.visions}>
          {visionIds.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {visionIds.map((id) => {
                const v = options.visions.find((x) => x.id === id);
                return (
                  <Chip
                    key={id}
                    label={v?.title ?? "…"}
                    icon={v?.icon}
                    removeLabel={f.remove(v?.title ?? "")}
                    onRemove={() => setVisionIds(visionIds.filter((x) => x !== id))}
                  />
                );
              })}
            </ul>
          )}
          <Combobox
            id="goal-visions"
            value=""
            placeholder={f.searchVision}
            emptyText={f.nothingFound}
            options={options.visions
              .filter((v) => !visionIds.includes(v.id))
              .map((v) => ({ value: v.id, label: `${v.icon ?? "◎"} ${v.title}` }))}
            onChange={(id) => setVisionIds([...visionIds, id])}
          />
        </Field>
      )}
      {sections.has("habits") && (
        <Field id="goal-habits" label={f.habits} hint={canDrive ? f.useHint : f.useDisabled}>
          {habits.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {habits.map((h) => {
                const habit = options.habits.find((x) => x.id === h.id);
                return (
                  <Chip
                    key={h.id}
                    label={habit?.name ?? "…"}
                    icon={habit?.icon}
                    removeLabel={f.remove(habit?.name ?? "")}
                    onRemove={() => setHabits(habits.filter((x) => x.id !== h.id))}
                  >
                    <label className="flex items-center gap-2 text-[12px] text-muted">
                      {f.useForProgress}
                      <Switch
                        checked={canDrive && h.use}
                        disabled={!canDrive}
                        aria-label={`${f.useForProgress}: ${habit?.name ?? ""}`}
                        onCheckedChange={(use) =>
                          setHabits(habits.map((x) => (x.id === h.id ? { ...x, use } : x)))
                        }
                      />
                    </label>
                  </Chip>
                );
              })}
            </ul>
          )}
          <Combobox
            id="goal-habits"
            value=""
            placeholder={f.searchHabit}
            emptyText={f.nothingFound}
            options={options.habits
              .filter((x) => !habits.some((h) => h.id === x.id))
              .map((x) => ({ value: x.id, label: `${x.icon ?? "•"} ${x.name}` }))}
            onChange={(id) => setHabits([...habits, { id, use: canDrive }])}
          />
        </Field>
      )}
      {goal && habits.length > 0 && anyDriver && (
        <Field id="goal-mode" label={f.source}>
          <Select
            id="goal-mode"
            value={mode === "manual" ? "linked" : mode}
            onChange={(e) => setMode(e.target.value as ProgressMode)}
          >
            {(["linked", "hybrid"] as const).map((m) => (
              <option key={m} value={m}>
                {f.sources[m]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {sections.has("description") && (
        <Field id="goal-description" label={f.description}>
          <textarea
            id="goal-description"
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={textareaClass}
          />
        </Field>
      )}
      {(sections.has("deadline") || sections.has("area")) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {sections.has("deadline") && (
            <Field id="goal-deadline" label={f.deadline} hint={f.deadlineHint}>
              <Input
                id="goal-deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </Field>
          )}
          {sections.has("area") && (
            <Field id="goal-area" label={f.area}>
              <Input
                id="goal-area"
                list="goal-areas"
                maxLength={60}
                value={area}
                placeholder={f.areaPlaceholder}
                onChange={(e) => setArea(e.target.value)}
              />
              <datalist id="goal-areas">
                {options.areas.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </Field>
          )}
        </div>
      )}
      {sections.has("parent") && (
        <Field id="goal-parent" label={f.parent}>
          <Select id="goal-parent" value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">{f.noParent}</option>
            {otherGoals.map((x) => (
              <option key={x.id} value={x.id}>
                {x.icon ? `${x.icon} ` : ""}
                {x.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {sections.has("related") && goal && (
        <Field id="goal-related" label={f.related}>
          {relatedIds.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {relatedIds.map((id) => {
                const x = options.goals.find((o) => o.id === id);
                return (
                  <Chip
                    key={id}
                    label={x?.title ?? "…"}
                    icon={x?.icon}
                    removeLabel={f.remove(x?.title ?? "")}
                    onRemove={() => setRelatedIds(relatedIds.filter((r) => r !== id))}
                  />
                );
              })}
            </ul>
          )}
          <Combobox
            id="goal-related"
            value=""
            placeholder={f.searchGoal}
            emptyText={f.nothingFound}
            options={otherGoals
              .filter((x) => !relatedIds.includes(x.id) && x.id !== parentId)
              .map((x) => ({ value: x.id, label: `${x.icon ?? "🎯"} ${x.title}` }))}
            onChange={(id) => setRelatedIds([...relatedIds, id])}
          />
        </Field>
      )}

      <div className="flex flex-wrap gap-1.5" aria-label={f.more}>
        {addButton("vision", f.add.vision)}
        {addButton("habits", f.add.habits)}
        {addButton("description", f.add.description)}
        {addButton("deadline", f.add.deadline)}
        {addButton("area", f.add.area)}
        {addButton("parent", f.add.parent)}
        {goal && addButton("related", f.add.related)}
      </div>

      {problems.length > 0 && (
        <ul className="text-[12.5px] text-danger-text" role="alert">
          {problems.map((p) => (
            <li key={p}>{f.problems[p]}</li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {f.cancel}
        </Button>
        <Button
          type="submit"
          disabled={
            pending ||
            !title.trim() ||
            problems.length > 0 ||
            !iconOk ||
            (preset === "custom" && !period)
          }
        >
          {goal ? f.save : f.create}
        </Button>
      </div>
    </form>
  );
}

// ── Vision ───────────────────────────────────────────────────────────────────

export function VisionDialog({
  open,
  onClose,
  vision,
  areas,
}: {
  open: boolean;
  onClose: () => void;
  vision?: Vision | null;
  areas: string[];
}) {
  const { t } = useI18n();
  const v = t.native.goals.visionForm;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={vision ? v.editTitle : v.newTitle}
      description={v.hint}
      className="border-border-strong bg-[var(--overlay-bg)] sm:max-w-xl"
    >
      <VisionForm vision={vision ?? null} areas={areas} onDone={onClose} />
    </Dialog>
  );
}

function VisionForm({
  vision,
  areas,
  onDone,
}: {
  vision: Vision | null;
  areas: string[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const v = t.native.goals.visionForm;
  const f = t.native.goals.form;
  const { act, pending } = useNative();
  const [title, setTitle] = useState(vision?.title ?? "");
  const [icon, setIcon] = useState(vision?.icon ?? "");
  const [touched, setTouched] = useState(Boolean(vision));
  const [description, setDescription] = useState(vision?.description ?? "");
  const [area, setArea] = useState(vision?.area ?? "");
  const iconOk = !icon || isGoalIcon(icon);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim() || !iconOk) return;
        if (vision)
          act(
            "goals.updateVision",
            {
              vision: vision.id,
              title: title.trim(),
              icon: icon || null,
              description: description.trim() || null,
              area: area.trim() || null,
            },
            onDone,
          );
        else
          act(
            "goals.createVision",
            {
              title: title.trim(),
              ...(icon ? { icon } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
              ...(area.trim() ? { area: area.trim() } : {}),
            },
            onDone,
          );
      }}
    >
      <div className="flex items-start gap-3">
        <IconPicker
          id="vision-icon"
          value={icon || (!touched ? (suggestGoalIcon(title) ?? "🧭") : "")}
          onChange={(x) => {
            setIcon(x);
            setTouched(true);
          }}
        />
        <div className="min-w-0 flex-1">
          <Field id="vision-statement" label={v.statement}>
            <textarea
              id="vision-statement"
              data-autofocus
              required
              maxLength={500}
              value={title}
              placeholder={v.statementPlaceholder}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => !touched && setIcon(suggestGoalIcon(title) ?? "🧭")}
              className={textareaClass}
            />
          </Field>
        </div>
      </div>
      {!iconOk && <p className="text-[12.5px] text-danger-text">{f.iconInvalid}</p>}
      <Field id="vision-description" label={v.description}>
        <textarea
          id="vision-description"
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={textareaClass}
        />
      </Field>
      <Field id="vision-area" label={v.area}>
        <Input
          id="vision-area"
          list="vision-areas"
          maxLength={60}
          value={area}
          placeholder={f.areaPlaceholder}
          onChange={(e) => setArea(e.target.value)}
        />
        <datalist id="vision-areas">
          {areas.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {f.cancel}
        </Button>
        <Button type="submit" disabled={pending || !title.trim() || !iconOk}>
          {vision ? v.save : v.create}
        </Button>
      </div>
    </form>
  );
}

// ── Quick progress update ────────────────────────────────────────────────────

/** "7 / 12" → a small editor: value (−/+), optional note, save. Popover; bottom sheet on mobile. */
export function ProgressEditor({
  goal,
  linkedValue,
  anchor,
  onClose,
}: {
  goal: Goal;
  /** What linked habits/tasks add on top of the manual value (hybrid goals). */
  linkedValue: number | null;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const p = t.native.goals.progress;
  const { act, pending } = useNative();
  const [value, setValue] = useState(String(goal.currentValue ?? goal.startValue ?? 0));
  const [note, setNote] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const [mobile] = useState(() => window.innerWidth < 640);
  const n = num(value);
  const step =
    Math.abs(goal.targetValue ?? 0) >= 1000 ? 100 : Math.abs(goal.targetValue ?? 0) >= 50 ? 5 : 1;
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
    Math.min(anchor.left + anchor.width / 2 - 150, window.innerWidth - 312),
  );
  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`${p.update}: ${goal.title}`}
      className={cn(
        "fixed z-50 flex flex-col gap-3 border border-border-strong bg-[var(--overlay-bg)] p-4 shadow-xl",
        mobile
          ? "inset-x-0 bottom-0 rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          : "w-[300px] rounded-2xl",
      )}
      style={
        mobile ? undefined : { top: Math.min(anchor.bottom + 8, window.innerHeight - 280), left }
      }
    >
      <p className="truncate text-[13px] font-medium">{goal.title}</p>
      {goal.progressType === "binary" ? (
        <Button
          onClick={() => act("goals.complete", { goal: goal.id }, onClose)}
          disabled={pending}
        >
          {p.markDone}
        </Button>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (n === null) return;
            act(
              "goals.updateProgress",
              { goal: goal.id, value: n, ...(note.trim() ? { note: note.trim() } : {}) },
              onClose,
            );
          }}
        >
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label="−"
              onClick={() => setValue(String((n ?? 0) - step))}
            >
              <Minus />
            </Button>
            <Input
              autoFocus
              aria-label={p.current}
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-10 text-center font-mono"
            />
            <Button
              size="sm"
              variant="secondary"
              aria-label="+"
              onClick={() => setValue(String((n ?? 0) + step))}
            >
              <Plus />
            </Button>
          </div>
          <p className="text-center text-[12px] text-muted">
            {goal.progressType === "percentage"
              ? `${n ?? 0}%`
              : `${n ?? 0} / ${goal.targetValue ?? "?"} ${goal.currency ?? goal.metric ?? ""}`}
            {linkedValue ? ` · ${p.linkedPart(String(linkedValue))}` : ""}
          </p>
          <Input
            aria-label={p.note}
            placeholder={p.notePlaceholder}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="h-9"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t.native.goals.form.cancel}
            </Button>
            <Button size="sm" type="submit" disabled={pending || n === null}>
              {p.save}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
