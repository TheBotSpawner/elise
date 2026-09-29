"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import {
  BRIEF_BLOCKS,
  FUTURE_BRIEF_BLOCKS,
  type BriefBlock,
  type ScheduleInput,
} from "@/core/schedules/schedule";
import { addDays, todayIn } from "@/core/time";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { createScheduleAction, updateScheduleAction } from "./actions";
import { BrowserNotificationsPrompt } from "./browser-notifications";

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function defaultBrief(timezone: string, name: string): ScheduleInput {
  return {
    name,
    actionType: "morning_brief",
    definition: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" },
    timezone,
    configuration: {
      blocks: [...BRIEF_BLOCKS],
      sources: { calendar: "all", email: "all", tasks: "all" },
    },
    instructions: null,
    delivery: { notify: "in_app" },
  };
}

/** Plain form, no technical syntax: when, what to include, how to notify, own instructions. */
export function ScheduleForm({
  initial,
  scheduleId,
  onDone,
}: {
  initial: ScheduleInput;
  scheduleId?: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [v, setV] = useState(initial);
  const timezones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const once = v.definition.kind === "once";
  const time = v.definition.kind === "once" ? v.definition.at.slice(11, 16) : v.definition.time;
  const date =
    v.definition.kind === "once" ? v.definition.at.slice(0, 10) : addDays(todayIn(v.timezone), 1);

  const setWhen = (next: { once?: boolean; days?: number[]; time?: string; date?: string }) => {
    const isOnce = next.once ?? once;
    const tm = next.time ?? time;
    setV((s) => ({
      ...s,
      definition: isOnce
        ? { kind: "once", at: `${next.date ?? date}T${tm}` }
        : {
            kind: "weekly",
            days:
              next.days ?? (s.definition.kind === "weekly" ? s.definition.days : [1, 2, 3, 4, 5]),
            time: tm,
          },
    }));
  };

  const toggleBlock = (b: BriefBlock) =>
    setV((s) => {
      const blocks = s.configuration.blocks.includes(b)
        ? s.configuration.blocks.filter((x) => x !== b)
        : [...s.configuration.blocks, b];
      return { ...s, configuration: { ...s.configuration, blocks } };
    });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = scheduleId
        ? await updateScheduleAction(scheduleId, v)
        : await createScheduleAction(v);
      if (!result.ok) {
        toast.error(result.error.message || t.errors.codes[result.error.code]);
        return;
      }
      onDone();
    });
  }

  const days = v.definition.kind === "weekly" ? v.definition.days : [];

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5 rounded-2xl border border-border bg-surface p-5"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-name">{t.schedules.form.name}</Label>
        <Input
          id="schedule-name"
          value={v.name}
          maxLength={120}
          required
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
      </div>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-1.5 text-sm font-medium">{t.schedules.form.repeat}</legend>
        <div className="flex flex-wrap gap-1.5">
          {WEEK_ORDER.map((d) => {
            const on = !once && days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setWhen({
                    once: false,
                    days: on ? days.filter((x) => x !== d) : [...days, d],
                  })
                }
                className={cn(
                  "h-9 min-w-12 rounded-full border px-3 text-[13px] transition-colors",
                  on
                    ? "border-accent bg-accent-soft text-accent-text"
                    : "border-border-strong text-muted hover:text-fg",
                )}
              >
                {t.schedules.days[d]}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={once}
            onClick={() => setWhen({ once: !once })}
            className={cn(
              "h-9 rounded-full border px-3 text-[13px] transition-colors",
              once
                ? "border-accent bg-accent-soft text-accent-text"
                : "border-border-strong text-muted hover:text-fg",
            )}
          >
            {t.schedules.form.oneTime}
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {once && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schedule-date">{t.schedules.form.date}</Label>
              <Input
                id="schedule-date"
                type="date"
                value={date}
                required
                onChange={(e) => setWhen({ date: e.target.value })}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="schedule-time">{t.schedules.form.time}</Label>
            <Input
              id="schedule-time"
              type="time"
              value={time}
              required
              onChange={(e) => setWhen({ time: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="schedule-tz">{t.schedules.form.timezone}</Label>
            <Select
              id="schedule-tz"
              value={v.timezone}
              onChange={(e) => setV({ ...v, timezone: e.target.value })}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t.schedules.form.include}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {BRIEF_BLOCKS.map((b) => (
            <label
              key={b}
              className="flex h-11 cursor-pointer items-center gap-3 rounded-xl border border-border-strong px-3.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="checkbox"
                checked={v.configuration.blocks.includes(b)}
                onChange={() => toggleBlock(b)}
                className="accent-[var(--accent)]"
              />
              {t.schedules.blocks[b]}
            </label>
          ))}
          {FUTURE_BRIEF_BLOCKS.map((b) => (
            <span
              key={b}
              className="flex h-11 items-center justify-between rounded-xl border border-dashed border-border px-3.5 text-sm text-faint"
            >
              {t.schedules.blocks[b]}
              <span className="type-label">{t.schedules.form.soon}</span>
            </span>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-notify">{t.schedules.form.notify}</Label>
        <Select
          id="schedule-notify"
          value={v.delivery.notify}
          onChange={(e) =>
            setV({
              ...v,
              delivery: { notify: e.target.value as ScheduleInput["delivery"]["notify"] },
            })
          }
        >
          {(["in_app", "browser", "none"] as const).map((n) => (
            <option key={n} value={n}>
              {t.schedules.notify[n]}
            </option>
          ))}
        </Select>
        {v.delivery.notify === "browser" && <BrowserNotificationsPrompt />}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="schedule-instructions">{t.schedules.form.instructions}</Label>
        <textarea
          id="schedule-instructions"
          rows={3}
          maxLength={2000}
          value={v.instructions ?? ""}
          placeholder={t.schedules.form.instructionsPlaceholder}
          onChange={(e) => setV({ ...v, instructions: e.target.value || null })}
          className="rounded-xl border border-border-strong bg-transparent px-3.5 py-2.5 text-sm placeholder:text-faint focus:border-accent focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          {t.schedules.form.cancel}
        </Button>
        <Button
          type="submit"
          disabled={pending || v.configuration.blocks.length === 0 || (!once && days.length === 0)}
        >
          {scheduleId ? t.schedules.form.save : t.schedules.form.create}
        </Button>
      </div>
    </form>
  );
}
