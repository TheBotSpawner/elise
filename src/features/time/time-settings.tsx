"use client";

import { ChevronDown, Play, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AUTO_START, SOUNDS, type TimePreferences } from "@/core/timers/model";
import type { TimerPayload } from "@/core/workspace/time";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { saveTimePrefs } from "./actions";
import { playChime } from "./sound";
import { activeTimers, timeStore, useTime } from "./store";
import { act, TimerSurfaceBody } from "./time-view";

const MIN = 60_000;

const PRESETS = [1, 3, 5, 10, 15, 30, 60] as const;

function TimerCard({ p }: { p: TimerPayload }) {
  return (
    <li className="flex flex-col gap-1 rounded-2xl border border-border bg-surface p-5">
      {p.label && <p className="truncate text-[14px]">{p.label}</p>}
      <TimerSurfaceBody p={p} size="medium" />
    </li>
  );
}

/**
 * Mi ELISE → Tiempos → Temporizadores (ADR-045, ADR-105): start one in a tap (or set your own),
 * the ones running as cards, and the pomodoro settings folded away.
 */
export function TimersPanel() {
  const t = useI18n().t.time;
  const s = useTime();
  const running = activeTimers(s.timers).filter((x) => x.kind !== "stopwatch");
  const recent = s.timers
    .filter((x) => x.state === "completed" && x.kind !== "stopwatch")
    .slice(0, 5);
  return (
    <div className="flex flex-col gap-6">
      <NewTimer pomodoro={s.prefs.pomodoro} />
      {running.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {running.map((x) => (
            <TimerCard key={x.id} p={x} />
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <section className="flex flex-col gap-1">
          <h2 className="type-label text-faint">{t.settings.recent}</h2>
          <ul className="flex flex-col divide-y divide-border text-[13.5px]">
            {recent.map((x) => (
              <li key={x.id} className="flex justify-between gap-3 py-2 text-muted">
                <span className="truncate">{x.label ?? t[x.kind]}</span>
                <span className="text-faint tabular-nums">
                  {x.completedAt
                    ? new Date(x.completedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.loaded && (
        <details className="group rounded-2xl border border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3.5 text-[14px] [&::-webkit-details-marker]:hidden">
            {t.settings.preferences}
            <ChevronDown
              className="size-4 text-muted transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="border-t border-border px-5 py-4">
            <Preferences key={JSON.stringify(s.prefs)} initial={s.prefs} />
          </div>
        </details>
      )}
    </div>
  );
}

type Start = Omit<Extract<Parameters<typeof act>[0], { tool: "start" }>, "tool">;

const digits = (v: string, max: number) => String(Math.min(max, Number(v.replace(/\D/g, "")) || 0));

function NewTimer({ pomodoro }: { pomodoro: TimePreferences["pomodoro"] }) {
  const t = useI18n().t.time;
  const n = t.settings.new;
  const [time, setTime] = useState({ h: "0", m: "5", s: "0" });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async (input: Start) => {
    setBusy(true);
    await act({ tool: "start", ...input, ...(label.trim() ? { label: label.trim() } : {}) });
    setBusy(false);
    setLabel("");
  };
  const minutes = Number(time.h) * 60 + Number(time.m);
  const seconds = Number(time.s);
  const field = (key: "h" | "m" | "s", max: number, unit: string) => (
    <label className="flex flex-col items-center gap-1">
      <input
        inputMode="numeric"
        aria-label={unit}
        value={time[key].padStart(2, "0")}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setTime({ ...time, [key]: digits(e.target.value.slice(-2), max) })}
        className="w-[2.6ch] rounded-xl bg-transparent text-center font-mono text-[56px] leading-none font-light tabular-nums focus:bg-surface-2 focus:outline-none"
      />
      <span className="text-[11px] tracking-[0.14em] text-faint uppercase">{unit}</span>
    </label>
  );
  const colon = (
    <span className="pt-1 font-mono text-[48px] leading-none font-light text-faint">:</span>
  );
  return (
    <section className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-surface px-5 py-6">
      <div className="flex items-start gap-1">
        {field("h", 23, n.hours)}
        {colon}
        {field("m", 59, n.minutes)}
        {colon}
        {field("s", 59, n.seconds)}
      </div>
      <div className="flex w-full max-w-md items-center gap-2">
        <Input
          maxLength={80}
          aria-label={n.label}
          placeholder={n.label}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Button
          disabled={busy || (!minutes && !seconds)}
          onClick={() => void start({ kind: "timer", minutes, seconds })}
        >
          <Play aria-hidden />
          {n.start}
        </Button>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            disabled={busy}
            onClick={() => void start({ kind: "timer", minutes: m })}
            className="rounded-full bg-surface-2 px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:text-fg"
          >
            {m === 60 ? n.hour : n.min(m)}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => void start({ kind: "pomodoro" })}
          className="rounded-full border border-accent-line px-3.5 py-1.5 text-[13px] text-accent-text"
        >
          {n.pomodoro(Math.round(pomodoro.focusMs / MIN), Math.round(pomodoro.shortBreakMs / MIN))}
        </button>
      </div>
    </section>
  );
}

/** Mi ELISE → Tiempos → Cronómetro (ADR-105): the running ones, large; one tap to start. */
export function StopwatchPanel() {
  const t = useI18n().t.time;
  const s = useTime();
  const running = activeTimers(s.timers).filter((x) => x.kind === "stopwatch");
  const start = () => void act({ tool: "start", kind: "stopwatch" });
  if (!running.length)
    return (
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-surface px-5 py-14">
        <p className="font-mono text-[56px] leading-none font-light text-faint tabular-nums">
          00:00
        </p>
        <Button size="lg" onClick={start}>
          <Play aria-hidden />
          {t.settings.new.start}
        </Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <ul className={cn("grid gap-3", running.length > 1 && "sm:grid-cols-2")}>
        {running.map((x) => (
          <TimerCard key={x.id} p={x} />
        ))}
      </ul>
      <Button variant="ghost" size="sm" className="self-start" onClick={start}>
        <Plus aria-hidden />
        {t.settings.new.another}
      </Button>
    </div>
  );
}

function Preferences({ initial }: { initial: TimePreferences }) {
  const t = useI18n().t.time.settings;
  const [p, setP] = useState(initial);
  const [saving, setSaving] = useState(false);
  const minutes = (key: "focusMs" | "shortBreakMs" | "longBreakMs", min: number, max: number) => (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={Math.round(p.pomodoro[key] / MIN)}
      onChange={(e) =>
        setP({
          ...p,
          pomodoro: {
            ...p.pomodoro,
            [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) * MIN,
          },
        })
      }
    />
  );
  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="flex flex-col gap-1.5">
          {t.sound}
          <Select
            value={p.sound}
            onChange={(e) => {
              const sound = e.target.value as TimePreferences["sound"];
              setP({ ...p, sound });
              playChime(sound);
            }}
          >
            {SOUNDS.map((x) => (
              <option key={x} value={x}>
                {t.sounds[x]}
              </option>
            ))}
          </Select>
        </Label>
        <div className="flex items-center justify-between gap-3 self-end py-2">
          <span className="text-[14px]">{t.notify}</span>
          <Switch
            checked={p.notify}
            onCheckedChange={(notify) => setP({ ...p, notify })}
            aria-label={t.notify}
          />
        </div>
        <Label className="flex flex-col gap-1.5">
          {t.focus}
          {minutes("focusMs", 1, 180)}
        </Label>
        <Label className="flex flex-col gap-1.5">
          {t.shortBreak}
          {minutes("shortBreakMs", 1, 60)}
        </Label>
        <Label className="flex flex-col gap-1.5">
          {t.longBreak}
          {minutes("longBreakMs", 0, 90)}
        </Label>
        <Label className="flex flex-col gap-1.5">
          {t.cycles}
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={12}
            value={p.pomodoro.cycles}
            onChange={(e) =>
              setP({
                ...p,
                pomodoro: {
                  ...p.pomodoro,
                  cycles: Math.min(12, Math.max(1, Number(e.target.value) || 1)),
                },
              })
            }
          />
        </Label>
        <Label className="flex flex-col gap-1.5 sm:col-span-2">
          {t.autoStart}
          <Select
            value={p.pomodoro.autoStart}
            onChange={(e) =>
              setP({
                ...p,
                pomodoro: {
                  ...p.pomodoro,
                  autoStart: e.target.value as TimePreferences["pomodoro"]["autoStart"],
                },
              })
            }
          >
            {AUTO_START.map((x) => (
              <option key={x} value={x}>
                {t.autoStarts[x]}
              </option>
            ))}
          </Select>
        </Label>
      </div>
      <p className="text-[12.5px] text-faint">{t.browserNote}</p>
      <div>
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            const r = await saveTimePrefs(p);
            setSaving(false);
            if (!r.ok) return void toast.error(r.error.message);
            timeStore.setPrefs(r.prefs);
            toast(t.saved);
          }}
        >
          {t.save}
        </Button>
      </div>
    </section>
  );
}
