"use client";

import { Copy, Globe, Monitor, Play, Plus, Settings2, Square, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ALARM_LIMITS,
  defaultDestinations,
  deliveryCheck,
  type Alarm,
  type AlarmDestination,
  type DestinationStatus,
} from "@/core/timers/alarms";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ring, unlockAlarmAudio, type Ringing } from "./alarm-sound";
import {
  alarmOp,
  browserEndpoint,
  chooseThisBrowser,
  loadAlarms,
  stopUsingThisBrowser,
  useAlarms,
  type AlarmsState,
} from "./alarms-client";

type T = ReturnType<typeof useI18n>["t"]["time"]["alarms"];

/** "Lun · Mié", "Todos los días", "De lunes a viernes", or the date. */
function when(a: Pick<Alarm, "date" | "weekdays">, t: T, locale: string) {
  if (a.date)
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${a.date}T12:00:00Z`));
  if (a.weekdays.length === 7) return t.everyDay;
  if (a.weekdays.join() === "1,2,3,4,5") return t.weekdays;
  return a.weekdays.map((d) => t.days[d]).join(" · ");
}

function nextLabel(iso: string | null, timezone: string, locale: string) {
  if (!iso) return null;
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

/** One preview at a time, anywhere on the page. */
let preview: { key: string; handle: Ringing } | null = null;
function usePreview() {
  const [playing, setPlaying] = useState<string | null>(null);
  const toggle = async (key: string, volume: number) => {
    preview?.handle.stop();
    if (preview?.key === key) {
      preview = null;
      setPlaying(null);
      return;
    }
    await unlockAlarmAudio();
    const handle = await ring(key, volume, false);
    preview = { key, handle };
    setPlaying(key);
    window.setTimeout(() => {
      if (preview?.key === key) {
        preview = null;
        setPlaying(null);
      }
    }, 4000);
  };
  return { playing, toggle };
}

/** Where alarms ring when nobody says (ADR-105): never none while a device is known. */
const defaultsOf = (s: AlarmsState) =>
  defaultDestinations(s.prefs?.alarmDestinations ?? [], s.destinations);

const same = (a: AlarmDestination, b: AlarmDestination) => a.kind === b.kind && a.id === b.id;

/** A sound file the user picked, uploaded; its key, or null when it was refused. */
async function uploadSound(f: File, a: T): Promise<string | null> {
  const duration = await new Promise<number>((res) => {
    const audio = new Audio(URL.createObjectURL(f));
    audio.onloadedmetadata = () => res(Math.round(audio.duration * 1000) || 0);
    audio.onerror = () => res(0);
  });
  const form = new FormData();
  form.append("file", f);
  form.append("name", f.name);
  form.append("durationMs", String(duration));
  const r = await fetch("/api/time/alarms", { method: "POST", body: form });
  const d = (await r.json().catch(() => ({}))) as {
    key?: string;
    error?: { message?: string };
  };
  await loadAlarms();
  if (!r.ok) {
    toast.error(d.error?.message ?? "Error");
    return null;
  }
  toast.success(a.uploaded);
  return d.key ?? null;
}

function SoundFile({ onFile }: { onFile: (f: File) => void }) {
  const a = useI18n().t.time.alarms;
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={file}
        type="file"
        accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.ogg,.wav,.m4a"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        title={a.uploadHint}
        onClick={() => file.current?.click()}
        className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-muted hover:text-accent-text"
      >
        <Upload className="size-3.5" aria-hidden />
        {a.upload}
      </button>
    </>
  );
}

const DeviceIcon = ({ d }: { d: Pick<DestinationStatus, "kind"> }) =>
  d.kind === "desktop" ? (
    <Monitor className="size-4 shrink-0" aria-hidden />
  ) : (
    <Globe className="size-4 shrink-0" aria-hidden />
  );

// ── The page (Mi ELISE → Tiempos) ────────────────────────────────────────────

/**
 * Alarms as a clock app shows them (ADR-105): the hour, what it's for, the days, a switch.
 * Everything else — sound, snooze, devices — lives in the alarm; the defaults, in Ajustes.
 */
export function AlarmsPanel() {
  const { t, locale } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const [editing, setEditing] = useState<Partial<Alarm> | null>(null);
  const [settings, setSettings] = useState(false);
  if (!s.loaded) return null;
  const toggle = async (x: Alarm, enabled: boolean) => {
    try {
      await alarmOp({ op: "change", id: x.id, patch: { enabled } });
    } catch (e) {
      toast.error((e as Error).message);
    }
    await loadAlarms();
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSettings(true)}>
          <Settings2 aria-hidden />
          {a.settings}
        </Button>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus aria-hidden />
          {a.new}
        </Button>
      </div>
      {!s.destinations.length && <NoDevices />}
      {s.alarms.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {s.alarms.map((x) => {
            const d = deliveryCheck(x.destinations, s.destinations);
            const live =
              x.state === "ringing" ? a.ringing : x.state === "snoozed" ? a.snoozed : null;
            const next = x.enabled && !live ? nextLabel(x.nextFireAt, s.timezone, locale) : null;
            const nowhere = x.enabled && !d.ready.length && !d.offline.length;
            return (
              <li
                key={x.id}
                className={cn(
                  "flex items-center gap-4 rounded-2xl border bg-surface px-5 py-4 transition-colors",
                  live ? "border-accent-line" : "border-border",
                )}
              >
                <button
                  type="button"
                  onClick={() => setEditing(x)}
                  aria-label={`${a.edit} ${x.time}`}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className={cn(
                      "block font-mono text-[40px] leading-none font-light tracking-tight tabular-nums",
                      !x.enabled && "text-faint",
                    )}
                  >
                    {x.time}
                  </span>
                  <span
                    className={cn(
                      "mt-2 block truncate text-[13px]",
                      x.enabled ? "text-muted" : "text-faint",
                    )}
                  >
                    {[x.label, x.state === "done" ? a.done : when(x, a, locale)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {(live || nowhere || next) && (
                    <span
                      className={cn(
                        "mt-0.5 block truncate text-[12px]",
                        live ? "text-accent-text" : nowhere ? "text-approval-text" : "text-faint",
                      )}
                    >
                      {live ?? (nowhere ? a.noDestination : next ? a.next(next) : "")}
                    </span>
                  )}
                </button>
                <Switch
                  checked={x.enabled}
                  onCheckedChange={(enabled) => void toggle(x, enabled)}
                  aria-label={a.enabled}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <p className="font-mono text-[40px] leading-none font-light text-faint">--:--</p>
          <p className="max-w-sm text-[14px] text-muted">{a.none}</p>
        </div>
      )}
      {editing && <AlarmEditor initial={editing} onClose={() => setEditing(null)} />}
      {settings && <AlarmSettings onClose={() => setSettings(false)} />}
    </div>
  );
}

/** No device can ring yet: the one step that fixes it. */
function NoDevices() {
  const a = useI18n().t.time.alarms;
  const isDesktop = typeof window !== "undefined" && "eliseDesktop" in window;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-approval-line bg-approval-bg px-4 py-3">
      <p className="text-[13.5px] text-approval-text">{a.noDevices}</p>
      {!isDesktop && <UseThisBrowser />}
    </div>
  );
}

function UseThisBrowser() {
  const a = useI18n().t.time.alarms;
  return (
    <Button
      size="sm"
      onClick={async () => {
        await unlockAlarmAudio();
        if ("Notification" in window && Notification.permission === "default")
          await Notification.requestPermission().catch(() => undefined);
        await chooseThisBrowser().catch((e: Error) => toast.error(e.message));
      }}
    >
      <Globe aria-hidden />
      {a.useThisBrowser}
    </Button>
  );
}

function Segmented<V extends string | boolean>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (v: V) => void;
}) {
  return (
    <div role="radiogroup" className="flex rounded-full border border-border bg-surface-2 p-1">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "flex-1 rounded-full px-3 py-1.5 text-[13px] transition-colors",
            value === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const SNOOZE_CHOICES = [5, 9, 10, 15, 20, 30] as const;

function AlarmEditor({ initial, onClose }: { initial: Partial<Alarm>; onClose: () => void }) {
  const { t } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const confirm = useConfirm();
  const { playing, toggle } = usePreview();
  const [form, setForm] = useState(() => ({
    label: initial.label ?? "",
    time: initial.time ?? "07:00",
    repeat: (initial.weekdays?.length ?? 0) > 0,
    // Tomorrow in the user's timezone (en-CA formats as YYYY-MM-DD).
    // A one-off that already rang starts again from tomorrow.
    date:
      (initial.state === "done" ? null : initial.date) ??
      new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone }).format(Date.now() + 86_400_000),
    weekdays: initial.weekdays?.length ? initial.weekdays : [1, 2, 3, 4, 5],
    sound: initial.sound ?? "",
    snoozeMinutes: initial.snoozeMinutes ?? ALARM_LIMITS.defaultSnooze,
    // An alarm that had nowhere to ring gets the default device (ADR-105).
    destinations: initial.destinations?.length ? initial.destinations : defaultsOf(s),
  }));
  const [saving, setSaving] = useState(false);
  const defaultName = s.sounds.find((x) => x.key === s.prefs?.alarmSound)?.name ?? "Brisa";
  const volume = s.prefs?.alarmVolume ?? 80;
  const run = async (body: Record<string, unknown>, done?: string) => {
    setSaving(true);
    try {
      await alarmOp(body);
      await loadAlarms();
      if (done) toast.success(done);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const alarm = () => ({
    label: form.label.trim() || null,
    time: form.time,
    date: form.repeat ? null : form.date,
    weekdays: form.repeat ? form.weekdays : [],
    sound: form.sound || null,
    snoozeMinutes: form.snoozeMinutes,
    destinations: form.destinations,
  });
  const has = (d: AlarmDestination) => form.destinations.some((x) => same(x, d));
  return (
    <Dialog open onClose={onClose} title={initial.id ? a.edit : a.new} busy={saving} size="form">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            initial.id
              ? { op: "change", id: initial.id, patch: { ...alarm(), enabled: true } }
              : { op: "create", alarm: alarm() },
            a.saved,
          );
        }}
      >
        <input
          type="time"
          required
          aria-label={a.time}
          value={form.time}
          onChange={(e) => setForm({ ...form, time: e.target.value })}
          data-autofocus
          className="mx-auto w-full max-w-[260px] rounded-2xl bg-surface-2 py-2 text-center font-mono text-[52px] leading-none font-light tabular-nums focus:ring-2 focus:ring-accent-line focus:outline-none"
        />
        <Input
          maxLength={80}
          aria-label={a.label}
          placeholder={a.labelPlaceholder}
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <div className="flex flex-col gap-3">
          <Segmented
            value={form.repeat}
            options={[
              [false, a.once],
              [true, a.repeats],
            ]}
            onChange={(repeat) => setForm({ ...form, repeat })}
          />
          {form.repeat ? (
            <div className="flex justify-between gap-1">
              {a.days.map((d, i) => {
                const on = form.weekdays.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setForm({
                        ...form,
                        weekdays: on
                          ? form.weekdays.filter((x) => x !== i)
                          : [...form.weekdays, i].sort(),
                      })
                    }
                    className={cn(
                      "size-10 rounded-full text-[12.5px] transition-colors",
                      on ? "bg-accent text-[var(--on-accent)]" : "bg-surface-2 text-muted",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          ) : (
            <Input
              type="date"
              required
              aria-label={a.date}
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="alarm-sound">{a.soundFor}</Label>
          <div className="flex items-center gap-2">
            <Select
              id="alarm-sound"
              className="flex-1"
              value={form.sound}
              onChange={(e) => setForm({ ...form, sound: e.target.value })}
            >
              <option value="">{a.useDefault(defaultName)}</option>
              {s.sounds.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
            </Select>
            <IconBtn
              label={playing ? a.stopPreview : a.preview}
              onClick={() => void toggle(form.sound || s.prefs?.alarmSound || "brisa", volume)}
            >
              {playing ? <Square className="size-4" /> : <Play className="size-4" />}
            </IconBtn>
          </div>
          <SoundFile
            onFile={async (f) => {
              const key = await uploadSound(f, a);
              if (key) setForm((x) => ({ ...x, sound: key }));
            }}
          />
        </div>
        <Label className="flex flex-col gap-1.5">
          {a.snoozeFor}
          <Select
            value={form.snoozeMinutes}
            onChange={(e) => setForm({ ...form, snoozeMinutes: Number(e.target.value) })}
          >
            {[...new Set([...SNOOZE_CHOICES, form.snoozeMinutes])]
              .sort((x, y) => x - y)
              .map((m) => (
                <option key={m} value={m}>
                  {a.minutes(m)}
                </option>
              ))}
          </Select>
        </Label>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px]">{a.devices}</legend>
          {s.destinations.length ? (
            <div className="flex flex-wrap gap-2">
              {s.destinations.map((d) => {
                const on = has(d);
                // Always at least one: the last one chosen can't be turned off (ADR-105).
                const last = on && form.destinations.length === 1;
                return (
                  <button
                    key={`${d.kind}:${d.id}`}
                    type="button"
                    aria-pressed={on}
                    disabled={last}
                    title={last ? a.atLeastOne : undefined}
                    onClick={() =>
                      setForm({
                        ...form,
                        destinations: on
                          ? form.destinations.filter((x) => !same(x, d))
                          : [...form.destinations, { kind: d.kind, id: d.id }],
                      })
                    }
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition-colors disabled:cursor-default",
                      on
                        ? "border-accent-line bg-accent-soft text-accent-text"
                        : "border-border text-muted hover:text-fg",
                    )}
                  >
                    <DeviceIcon d={d} />
                    {d.name}
                    {!d.online && <span className="text-[11.5px] text-faint">· {a.offline}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[13px] text-approval-text">{a.noDevices}</p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2" data-sheet-actions>
          {initial.id && (
            <>
              <IconBtn
                label={a.delete}
                onClick={async () => {
                  if (
                    await confirm({
                      title: a.deleteConfirm,
                      confirmLabel: a.delete,
                      destructive: true,
                    })
                  )
                    void run({ op: "delete", id: initial.id });
                }}
              >
                <Trash2 className="size-4" />
              </IconBtn>
              <IconBtn
                label={a.duplicate}
                onClick={() => void run({ op: "create", alarm: alarm() }, a.saved)}
              >
                <Copy className="size-4" />
              </IconBtn>
            </>
          )}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            {a.cancel}
          </Button>
          <Button
            type="submit"
            disabled={saving || (form.repeat && !form.weekdays.length) || !form.destinations.length}
          >
            {a.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

/** The defaults, out of the way (ADR-105): where new alarms ring, their sound, your sounds. */
function AlarmSettings({ onClose }: { onClose: () => void }) {
  const a = useI18n().t.time.alarms;
  const s = useAlarms();
  const { playing, toggle } = usePreview();
  const volume = s.prefs?.alarmVolume ?? 80;
  const isDesktop = typeof window !== "undefined" && "eliseDesktop" in window;
  const mine = isDesktop ? null : browserEndpoint();
  const defaults = defaultsOf(s);
  const uploads = s.sounds.filter((x) => x.kind === "upload");
  const defaultSound = s.prefs?.alarmSound ?? "brisa";
  const op = async (body: Record<string, unknown>) => {
    const r = await alarmOp(body).catch((e: Error) => {
      toast.error(e.message);
      return null;
    });
    await loadAlarms();
    return r;
  };
  return (
    <Dialog open onClose={onClose} title={a.settings} size="form">
      <div className="flex flex-col gap-7">
        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-medium">{a.devices}</h3>
          <p className="text-[12.5px] text-muted">
            {s.destinations.length === 1 ? a.onlyDevice : a.devicesHint}
          </p>
          {s.destinations.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
              {s.destinations.map((d) => {
                const on = defaults.some((x) => same(x, d));
                const last = on && defaults.length === 1;
                return (
                  <li key={`${d.kind}:${d.id}`} className="flex items-center gap-3 px-4 py-3">
                    <span className="text-muted">
                      <DeviceIcon d={d} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">
                        {d.name}
                        {d.kind === "browser" && d.id === mine && (
                          <span className="text-faint"> · {a.thisBrowser}</span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "block text-[12px]",
                          d.online ? "text-accent-text" : "text-faint",
                        )}
                      >
                        {d.online ? a.online : a.offline}
                      </span>
                    </span>
                    <Switch
                      checked={on}
                      disabled={last}
                      title={last ? a.atLeastOne : undefined}
                      aria-label={d.name}
                      onCheckedChange={() =>
                        void op({
                          op: "defaultDestinations",
                          destinations: on
                            ? defaults.filter((x) => !same(x, d))
                            : [...defaults, { kind: d.kind, id: d.id }],
                        })
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {!isDesktop &&
            (mine ? (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => void stopUsingThisBrowser()}
              >
                {a.stopUsingBrowser}
              </Button>
            ) : (
              <div className="self-start">
                <UseThisBrowser />
              </div>
            ))}
          <p className="text-[12px] text-faint">{isDesktop ? a.desktopLimit : a.browserLimit}</p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-medium">{a.defaultSoundTitle}</h3>
          <div className="flex items-center gap-2">
            <Select
              aria-label={a.defaultSoundTitle}
              className="flex-1"
              value={defaultSound}
              onChange={(e) => void op({ op: "defaultSound", sound: e.target.value })}
            >
              {s.sounds.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.name}
                </option>
              ))}
            </Select>
            <IconBtn
              label={playing ? a.stopPreview : a.preview}
              onClick={() => void toggle(defaultSound, volume)}
            >
              {playing ? <Square className="size-4" /> : <Play className="size-4" />}
            </IconBtn>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-[14px] font-medium">{a.yourSounds}</h3>
          {uploads.length > 0 && (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border">
              {uploads.map((x) => (
                <li key={x.key} className="flex items-center gap-2 px-2 py-1.5">
                  <IconBtn
                    label={playing === x.key ? a.stopPreview : a.preview}
                    onClick={() => void toggle(x.key, volume)}
                  >
                    {playing === x.key ? (
                      <Square className="size-4" />
                    ) : (
                      <Play className="size-4" />
                    )}
                  </IconBtn>
                  <span className="min-w-0 flex-1 truncate text-[14px]">{x.name}</span>
                  <IconBtn
                    label={a.removeSound}
                    onClick={async () => {
                      const r = await op({ op: "deleteSound", id: x.key.slice("upload:".length) });
                      const res = r as { alarmsChanged: number; wasDefault: boolean } | null;
                      if (res) toast(a.soundRemoved(res.alarmsChanged, res.wasDefault));
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconBtn>
                </li>
              ))}
            </ul>
          )}
          <SoundFile onFile={(f) => void uploadSound(f, a)} />
          <p className="text-[12px] text-faint">{a.uploadHint}</p>
        </section>
      </div>
    </Dialog>
  );
}

// ── The Surface / chat card ─────────────────────────────────────────────────

/** What a conversation shows: the alarms it set or listed, or the sounds to try (ADR-100). */
export function AlarmsBody({ p }: { p: SurfacePayloads["alarms"] }) {
  const { t, locale } = useI18n();
  const a = t.time.alarms;
  const { playing, toggle } = usePreview();
  if (p.sounds?.length)
    return (
      <ul className="-mx-1 flex flex-col">
        {p.sounds.map((x) => (
          <li key={x.key} className="flex items-center gap-2 px-1 py-1">
            <IconBtn
              label={playing === x.key ? a.stopPreview : a.preview}
              onClick={() => void toggle(x.key, 80)}
            >
              {playing === x.key ? <Square className="size-4" /> : <Play className="size-4" />}
            </IconBtn>
            <span className="flex-1 text-[14px]">{x.name}</span>
            {p.defaultSound === x.key ? (
              <span className="text-[12px] text-accent-text">{a.defaultSound}</span>
            ) : (
              <button
                type="button"
                className="text-[12.5px] text-muted hover:text-accent-text"
                onClick={async () => {
                  await alarmOp({ op: "defaultSound", sound: x.key }).catch(() => undefined);
                  await loadAlarms();
                }}
              >
                {a.setDefault}
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  if (!p.alarms.length) return <p className="text-[14px] text-muted">{a.none}</p>;
  return (
    <ul className="flex flex-col divide-y divide-border">
      {p.alarms.map((x) => {
        const offline = x.destinations.filter((d) => !d.online);
        const next = nextLabel(x.nextFireAt, p.timezone, locale);
        return (
          <li key={x.id} className="flex items-center gap-3 py-2">
            <span className={cn("font-mono text-xl", !x.enabled && "text-faint")}>{x.time}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px]">{x.label ?? when(x, a, locale)}</span>
              <span className="block text-[12px] text-muted">
                {x.label ? `${when(x, a, locale)} · ` : ""}
                {!x.enabled ? a.off : next ? a.next(next) : ""} · {x.soundName}
              </span>
              <span className="block text-[12px] text-faint">
                {x.destinations.length ? (
                  x.destinations.map((d) => d.name ?? d.kind).join(", ")
                ) : (
                  <span className="text-approval-text">{a.noDestination}</span>
                )}
                {offline.length > 0 && (
                  <span className="text-approval-text">
                    {" "}
                    · {a.offlineNow(offline.map((d) => d.name ?? d.kind).join(", "))}
                  </span>
                )}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
