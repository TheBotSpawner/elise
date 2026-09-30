"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { Habit, HabitFrequency, HabitProgress } from "@/core/capabilities/habits";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ImportPanel } from "./import-panel";
import { useNative } from "./use-native";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function NewHabit({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { act, pending } = useNative();
  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState<HabitFrequency>("weekly");
  const [target, setTarget] = useState("3");
  const [unit, setUnit] = useState("");
  const [days, setDays] = useState<number[]>([]);
  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          "habits.create",
          {
            name,
            frequency,
            target: Number(target) || 1,
            ...(unit.trim() ? { unit: unit.trim() } : {}),
            ...(frequency === "specific_days" ? { preferredDays: days } : {}),
          },
          onDone,
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
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
          />
        </div>
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
            type="number"
            min="0.1"
            step="any"
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t.native.cancel}
        </Button>
        <Button
          type="submit"
          disabled={pending || !name.trim() || (frequency === "specific_days" && !days.length)}
        >
          {t.native.create}
        </Button>
      </div>
    </form>
  );
}

function HabitRow({ habit, progress }: { habit: Habit; progress: HabitProgress }) {
  const { t, locale } = useI18n();
  const { act, pending } = useNative();
  const dayName = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  const measured = Boolean(habit.unit);

  function toggle(date: string, value: number, met: boolean) {
    if (measured) {
      const answer = window.prompt(
        t.native.habits.logValue(habit.unit ?? ""),
        value ? String(value) : "",
      );
      if (answer === null) return;
      const n = Number(answer.replace(",", "."));
      if (!answer.trim() || n === 0)
        act("habits.checkIn", { habit: habit.id, date, status: "undo" });
      else if (Number.isFinite(n) && n > 0)
        act("habits.checkIn", { habit: habit.id, date, value: n, mode: "set" });
      return;
    }
    act("habits.checkIn", { habit: habit.id, date, status: met ? "undo" : "done" });
  }

  const unit = habit.unit ? ` ${habit.unit}` : "";
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4",
        !habit.active && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-medium">{habit.name}</p>
          <p className="text-[13px] text-muted">
            {habit.frequency === "weekly"
              ? `${habit.target}${unit} ${t.native.habits.perWeek}`
              : `${habit.target}${unit} ${t.native.habits.perDay}`}
            {habit.frequency === "specific_days" &&
              ` · ${habit.preferredDays.map((d) => t.schedules.days[d]).join(", ")}`}
            {!habit.active && ` · ${t.native.habits.paused}`}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-[15px]">
            {t.native.habits.week(
              `${progress.week.done}${habit.frequency === "weekly" ? unit : ""}`,
              `${progress.week.goal}${habit.frequency === "weekly" ? unit : ""}`,
            )}
          </p>
          <p
            className={cn(
              "text-[12.5px]",
              progress.week.atRisk ? "text-approval-text" : "text-faint",
            )}
          >
            {progress.week.atRisk
              ? t.native.habits.atRisk
              : progress.streak.count > 0
                ? t.native.habits.streak(progress.streak.count, progress.streak.unit)
                : ""}
          </p>
        </div>
      </div>
      <ol className="grid grid-cols-7 gap-1.5">
        {progress.week.days.map((d) => (
          <li key={d.date}>
            <button
              type="button"
              disabled={pending || d.future || !habit.active}
              onClick={() => toggle(d.date, d.value, d.met)}
              aria-pressed={d.met}
              aria-label={`${d.date}${d.met ? " ✓" : ""}`}
              className={cn(
                "flex h-11 w-full flex-col items-center justify-center rounded-xl border text-[12px] transition-colors",
                d.met
                  ? "border-accent bg-accent-soft text-accent-text"
                  : d.value > 0
                    ? "border-accent-line text-accent-text"
                    : d.scheduled
                      ? "border-border-strong text-muted hover:border-accent-line"
                      : "border-dashed border-border text-faint",
                d.date === progress.today.date && "ring-1 ring-accent-line",
                d.future && "opacity-40",
              )}
            >
              <span>{dayName.format(new Date(`${d.date}T00:00:00Z`))}</span>
              <span className="font-mono text-[11px]">
                {d.met ? "✓" : d.value > 0 ? d.value : "·"}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => act("habits.pause", { habit: habit.id, resume: !habit.active })}
        >
          {habit.active ? t.native.habits.pause : t.native.habits.resume}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="hover:text-danger-text"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t.native.archiveConfirm(habit.name)))
              act("habits.archive", { habit: habit.id });
          }}
        >
          {t.native.archive}
        </Button>
      </div>
    </li>
  );
}

/** The week at a glance: Mon–Sun per habit, done / target, streak — counted by ELISE. */
export function HabitsView({
  habits,
  progress,
  workspaceId,
}: {
  habits: Habit[];
  progress: HabitProgress[];
  workspaceId: string;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"new" | "import" | null>(null);
  useRealtimeRefresh(workspaceId, ["habits", "habit_entries"]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setPanel(panel === "import" ? null : "import")}>
          {t.native.importCsv}
        </Button>
        <Button onClick={() => setPanel(panel === "new" ? null : "new")}>
          <Plus />
          {t.native.habits.new}
        </Button>
      </div>
      {panel === "new" && <NewHabit onDone={() => setPanel(null)} />}
      {panel === "import" && <ImportPanel kind="habits" onDone={() => setPanel(null)} />}
      {habits.length === 0 ? (
        <p className="text-[14px] text-muted">{t.native.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {habits.map((h) => (
            <HabitRow key={h.id} habit={h} progress={progress.find((p) => p.habitId === h.id)!} />
          ))}
        </ul>
      )}
    </div>
  );
}
