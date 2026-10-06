"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AUTO_START, SOUNDS, type TimePreferences } from "@/core/timers/model";
import { useI18n } from "@/lib/i18n/client";

import { saveTimePrefs } from "./actions";
import { playChime } from "./sound";
import { activeTimers, timeStore, useTime } from "./store";
import { TimerSurfaceBody } from "./time-view";

const MIN = 60_000;

/** My Elise → Time (ADR-045): what's running, what finished today, and a few preferences. */
export function TimeSettings() {
  const t = useI18n().t.time;
  const s = useTime();
  const active = activeTimers(s.timers);
  const recent = s.timers.filter((x) => x.state === "completed").slice(0, 6);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-[15px] font-medium">{t.settings.active}</h2>
        {active.length ? (
          <ul className="grid gap-3 sm:grid-cols-2">
            {active.map((x) => (
              <li key={x.id} className="rounded-2xl border border-border bg-surface p-4">
                <p className="mb-2 truncate text-[14px] text-muted">{x.label ?? t[x.kind]}</p>
                <TimerSurfaceBody p={x} size="small" />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-muted">{t.settings.none}</p>
        )}
      </section>
      {recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-[15px] font-medium">{t.settings.recent}</h2>
          <ul className="flex flex-col divide-y divide-border text-[14px]">
            {recent.map((x) => (
              <li key={x.id} className="flex justify-between py-2">
                <span>{x.label ?? t[x.kind]}</span>
                <span className="text-faint">
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
      {s.loaded && <Preferences key={JSON.stringify(s.prefs)} initial={s.prefs} />}
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
      <h2 className="text-[15px] font-medium">{t.preferences}</h2>
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
