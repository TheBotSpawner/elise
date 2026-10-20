"use client";

import { Copy, Pencil, Play, Plus, Square, Trash2, Upload, Monitor, Globe } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ALARM_LIMITS,
  deliveryCheck,
  type Alarm,
  type AlarmDestination,
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

// ── The page (Mi ELISE → Tiempos) ────────────────────────────────────────────

export function AlarmsPanel() {
  const { t, locale } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Partial<Alarm> | null>(null);
  const run = async (body: Record<string, unknown>) => {
    try {
      await alarmOp(body);
      await loadAlarms();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!s.loaded) return null;
  const known = s.destinations;
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-medium">{a.title}</h2>
          <Button size="sm" onClick={() => setEditing({})}>
            <Plus className="size-4" aria-hidden />
            {a.new}
          </Button>
        </div>
        {!known.length && <p className="text-[13px] text-approval-text">{a.noDevices}</p>}
        {s.alarms.length ? (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
            {s.alarms.map((x) => {
              const d = deliveryCheck(x.destinations, known);
              const next = nextLabel(x.nextFireAt, s.timezone, locale);
              return (
                <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className={cn("font-mono text-2xl", !x.enabled && "text-faint")}>
                        {x.time}
                      </span>
                      <span className="truncate text-[14px]">{x.label}</span>
                    </p>
                    <p className="text-[12.5px] text-muted">
                      {when(x, a, locale)}
                      {" · "}
                      {x.state === "ringing"
                        ? a.ringing
                        : x.state === "snoozed"
                          ? a.snoozed
                          : !x.enabled
                            ? a.off
                            : x.state === "done"
                              ? a.done
                              : next
                                ? a.next(next)
                                : ""}
                    </p>
                    <p className="text-[12px] text-faint">
                      {d.ready.map((r) => r.name).join(", ")}
                      {!x.destinations.length && (
                        <span className="text-approval-text">{a.noDestination}</span>
                      )}
                      {d.offline.length > 0 && (
                        <span className="text-approval-text">
                          {d.ready.length ? " · " : ""}
                          {a.offlineNow(d.offline.map((o) => o.name).join(", "))}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Switch
                      checked={x.enabled}
                      onCheckedChange={(enabled) =>
                        void run({ op: "change", id: x.id, patch: { enabled } })
                      }
                      aria-label={a.enabled}
                    />
                    <IconBtn label={a.edit} onClick={() => setEditing(x)}>
                      <Pencil className="size-4" />
                    </IconBtn>
                    <IconBtn
                      label={a.duplicate}
                      onClick={() => setEditing({ ...x, id: undefined, date: x.date })}
                    >
                      <Copy className="size-4" />
                    </IconBtn>
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
                          void run({ op: "delete", id: x.id });
                      }}
                    >
                      <Trash2 className="size-4" />
                    </IconBtn>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[14px] text-muted">{a.none}</p>
        )}
      </section>
      <SoundsSection />
      <DevicesSection />
      {editing && <AlarmEditor initial={editing} onClose={() => setEditing(null)} />}
    </div>
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
      className="grid size-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}

function AlarmEditor({ initial, onClose }: { initial: Partial<Alarm>; onClose: () => void }) {
  const { t } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const [form, setForm] = useState(() => ({
    label: initial.label ?? "",
    time: initial.time ?? "07:00",
    repeat: (initial.weekdays?.length ?? 0) > 0,
    // Tomorrow in the user's timezone (en-CA formats as YYYY-MM-DD).
    date:
      initial.date ??
      new Intl.DateTimeFormat("en-CA", { timeZone: s.timezone }).format(Date.now() + 86_400_000),
    weekdays: initial.weekdays?.length ? initial.weekdays : [1, 2, 3, 4, 5],
    sound: initial.sound ?? "",
    snoozeMinutes: initial.snoozeMinutes ?? ALARM_LIMITS.defaultSnooze,
    destinations: (initial.destinations ?? s.prefs?.alarmDestinations ?? []) as AlarmDestination[],
  }));
  const [saving, setSaving] = useState(false);
  const defaultName = s.sounds.find((x) => x.key === s.prefs?.alarmSound)?.name ?? "Brisa";
  const save = async () => {
    setSaving(true);
    const alarm = {
      label: form.label.trim() || null,
      time: form.time,
      date: form.repeat ? null : form.date,
      weekdays: form.repeat ? form.weekdays : [],
      sound: form.sound || null,
      snoozeMinutes: form.snoozeMinutes,
      destinations: form.destinations,
    };
    try {
      await alarmOp(
        initial.id ? { op: "change", id: initial.id, patch: alarm } : { op: "create", alarm },
      );
      await loadAlarms();
      toast.success(a.saved);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const has = (d: AlarmDestination) =>
    form.destinations.some((x) => x.kind === d.kind && x.id === d.id);
  return (
    <Dialog open onClose={onClose} title={initial.id ? a.edit : a.new} busy={saving} size="form">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Label className="flex flex-col gap-1.5">
            {a.time}
            <Input
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
              data-autofocus
            />
          </Label>
          <Label className="flex flex-col gap-1.5">
            {a.label}
            <Input
              maxLength={80}
              placeholder={a.labelPlaceholder}
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </Label>
        </div>
        <div className="flex gap-2" role="radiogroup">
          {([false, true] as const).map((r) => (
            <button
              key={String(r)}
              type="button"
              role="radio"
              aria-checked={form.repeat === r}
              onClick={() => setForm({ ...form, repeat: r })}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[13px]",
                form.repeat === r
                  ? "border-accent-line bg-accent-soft text-accent-text"
                  : "border-border",
              )}
            >
              {r ? a.repeats : a.once}
            </button>
          ))}
        </div>
        {form.repeat ? (
          <div className="flex flex-wrap gap-1.5">
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
                    "size-10 rounded-full border text-[12.5px]",
                    on
                      ? "border-accent-line bg-accent-soft text-accent-text"
                      : "border-border text-muted",
                  )}
                >
                  {d}
                </button>
              );
            })}
          </div>
        ) : (
          <Label className="flex flex-col gap-1.5">
            {a.date}
            <Input
              type="date"
              required
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </Label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Label className="flex flex-col gap-1.5">
            {a.soundFor}
            <Select
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
          </Label>
          <Label className="flex flex-col gap-1.5">
            {a.snoozeMinutes}
            <Input
              type="number"
              min={ALARM_LIMITS.minSnooze}
              max={ALARM_LIMITS.maxSnooze}
              value={form.snoozeMinutes}
              onChange={(e) =>
                setForm({
                  ...form,
                  snoozeMinutes: Math.min(
                    ALARM_LIMITS.maxSnooze,
                    Math.max(ALARM_LIMITS.minSnooze, Number(e.target.value) || 9),
                  ),
                })
              }
            />
          </Label>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px]">{a.devices}</legend>
          {s.destinations.length ? (
            s.destinations.map((d) => (
              <label key={`${d.kind}:${d.id}`} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={has(d)}
                  onChange={() =>
                    setForm({
                      ...form,
                      destinations: has(d)
                        ? form.destinations.filter((x) => !(x.kind === d.kind && x.id === d.id))
                        : [...form.destinations, { kind: d.kind, id: d.id }],
                    })
                  }
                />
                {d.kind === "desktop" ? (
                  <Monitor className="size-4 text-muted" />
                ) : (
                  <Globe className="size-4 text-muted" />
                )}
                {d.name}
                <span className={cn("text-[12px]", d.online ? "text-accent-text" : "text-faint")}>
                  {d.online ? a.online : a.offline}
                </span>
              </label>
            ))
          ) : (
            <p className="text-[13px] text-approval-text">{a.noDevices}</p>
          )}
        </fieldset>
        <div className="flex justify-end gap-2" data-sheet-actions>
          <Button variant="secondary" onClick={onClose}>
            {a.cancel}
          </Button>
          <Button type="submit" disabled={saving || (form.repeat && !form.weekdays.length)}>
            {a.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SoundsSection() {
  const { t } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const { playing, toggle } = usePreview();
  const file = useRef<HTMLInputElement>(null);
  const volume = s.prefs?.alarmVolume ?? 80;
  const upload = async (f: File) => {
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
    const d = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!r.ok) toast.error(d.error?.message ?? "Error");
    else toast.success(a.uploaded);
    await loadAlarms();
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">{a.sounds}</h2>
      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
        {s.sounds.map((x) => {
          const isDefault = s.prefs?.alarmSound === x.key;
          return (
            <li key={x.key} className="flex items-center gap-3 px-4 py-2.5">
              <IconBtn
                label={playing === x.key ? a.stopPreview : a.preview}
                onClick={() => void toggle(x.key, volume)}
              >
                {playing === x.key ? <Square className="size-4" /> : <Play className="size-4" />}
              </IconBtn>
              <span className="min-w-0 flex-1 truncate text-[14px]">{x.name}</span>
              {isDefault ? (
                <span className="text-[12px] text-accent-text">{a.defaultSound}</span>
              ) : (
                <button
                  type="button"
                  className="text-[12.5px] text-muted hover:text-accent-text"
                  onClick={async () => {
                    await alarmOp({ op: "defaultSound", sound: x.key }).catch((e: Error) =>
                      toast.error(e.message),
                    );
                    await loadAlarms();
                  }}
                >
                  {a.setDefault}
                </button>
              )}
              {x.kind === "upload" && (
                <IconBtn
                  label={a.removeSound}
                  onClick={async () => {
                    const r = await alarmOp<{ alarmsChanged: number; wasDefault: boolean }>({
                      op: "deleteSound",
                      id: x.key.slice("upload:".length),
                    }).catch((e: Error) => {
                      toast.error(e.message);
                      return null;
                    });
                    if (r) toast(a.soundRemoved(r.alarmsChanged, r.wasDefault));
                    await loadAlarms();
                  }}
                >
                  <Trash2 className="size-4" />
                </IconBtn>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={file}
          type="file"
          accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.ogg,.wav,.m4a"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => file.current?.click()}>
          <Upload className="size-4" aria-hidden />
          {a.upload}
        </Button>
        <span className="text-[12px] text-faint">{a.uploadHint}</span>
      </div>
    </section>
  );
}

function DevicesSection() {
  const { t } = useI18n();
  const a = t.time.alarms;
  const s = useAlarms();
  const isDesktop = typeof window !== "undefined" && "eliseDesktop" in window;
  const mine = isDesktop ? null : browserEndpoint();
  const defaults = s.prefs?.alarmDestinations ?? [];
  const isDefault = (kind: string, id: string) =>
    defaults.some((d) => d.kind === kind && d.id === id);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[15px] font-medium">{a.devices}</h2>
      {s.destinations.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          {s.destinations.map((d) => (
            <li key={`${d.kind}:${d.id}`} className="flex items-center gap-3 px-4 py-2.5">
              {d.kind === "desktop" ? (
                <Monitor className="size-4 text-muted" />
              ) : (
                <Globe className="size-4 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate text-[14px]">
                {d.name}
                {d.kind === "browser" && d.id === mine && (
                  <span className="text-faint"> · {a.thisBrowser}</span>
                )}
              </span>
              <span className={cn("text-[12px]", d.online ? "text-accent-text" : "text-faint")}>
                {d.online ? a.online : a.offline}
              </span>
              <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <input
                  type="checkbox"
                  checked={isDefault(d.kind, d.id)}
                  onChange={async () => {
                    const next = isDefault(d.kind, d.id)
                      ? defaults.filter((x) => !(x.kind === d.kind && x.id === d.id))
                      : [...defaults, { kind: d.kind, id: d.id }];
                    await alarmOp({ op: "defaultDestinations", destinations: next });
                    await loadAlarms();
                  }}
                />
                {a.defaultDevices}
              </label>
            </li>
          ))}
        </ul>
      )}
      {!isDesktop &&
        (mine ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => void stopUsingThisBrowser()}
          >
            {a.stopUsingBrowser}
          </Button>
        ) : (
          <Button
            size="sm"
            className="self-start"
            onClick={async () => {
              await unlockAlarmAudio();
              if ("Notification" in window && Notification.permission === "default")
                await Notification.requestPermission().catch(() => undefined);
              await chooseThisBrowser().catch((e: Error) => toast.error(e.message));
            }}
          >
            <Globe className="size-4" aria-hidden />
            {a.useThisBrowser}
          </Button>
        ))}
      <ul className="flex flex-col gap-1 text-[12.5px] text-faint">
        <li>{a.browserLimit}</li>
        <li>{a.desktopLimit}</li>
        <li>{a.future}</li>
      </ul>
    </section>
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
