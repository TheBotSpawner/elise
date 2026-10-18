"use client";

import { Check, Minus, Pencil, Play, Plus, Search, Star, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { relativeWhen } from "@/core/history/links";
import {
  COLORS,
  describeState,
  hvacLabel,
  type HomeActionInput,
  type HomeCapability,
  type HomeCommandOutcome,
  type HomeDevice,
  type HomeDeviceType,
  type HomeScene,
  type HomeSetupState,
  type HomeSnapshot,
} from "@/core/home/model";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  controlDeviceAction,
  createPairingCodeAction,
  createRoomAction,
  deleteSceneAction,
  runSceneAction,
  saveSceneAction,
  updateDeviceAction,
} from "./actions";
import { DeviceIcon } from "./device-icon";

const CARD = "rounded-2xl border border-border bg-surface";
const SWATCHES = [
  "rojo",
  "naranja",
  "amarillo",
  "verde",
  "celeste",
  "azul",
  "violeta",
  "rosa",
  "blanco",
] as const;
const cap = <T extends HomeCapability["type"]>(d: HomeDevice, t: T) =>
  d.capabilities.find((c): c is Extract<HomeCapability, { type: T }> => c.type === t);

/** A command's outcome, in one toast (never a fake success). */
function useCommand() {
  const { t } = useI18n();
  const r = t.smartHome.result;
  const router = useRouter();
  const [pending, start] = useTransition();
  const report = (outcomes: HomeCommandOutcome[], mode?: string) => {
    if (outcomes.some((o) => o.status === "offline")) return toast.error(r.hubOffline);
    const failed = outcomes
      .filter((o) => ["failed", "expired", "unavailable"].includes(o.status))
      .map((o) => o.name);
    if (mode) {
      if (failed.length) toast.warning(r.modePartial(mode, failed.join(", ")));
      else toast.success(r.modeOn(mode));
    } else if (failed.length) toast.error(r.notResponding(failed.join(", ")));
    else if (outcomes.some((o) => o.status === "pending")) toast(r.unconfirmed);
    router.refresh();
  };
  return {
    pending,
    control: (device: HomeDevice, actions: HomeActionInput[]) =>
      start(async () => {
        const res = await controlDeviceAction(device.id, actions);
        if (!res.ok) return void toast.error(errorText(t, res.error));
        report(res.value);
      }),
    runScene: (scene: HomeScene) =>
      start(async () => {
        const res = await runSceneAction(scene.id);
        if (!res.ok) return void toast.error(errorText(t, res.error));
        report(res.value, scene.name);
      }),
  };
}

/**
 * ELISE Home (ADR-079/080). Until the home's hub — ELISE Desktop on a PC — is connected, the
 * screen guides setup from its authenticated presence (never from guessing what's installed);
 * then it's the dashboard: modes, rooms, devices, each with only the controls it supports.
 */
export function HomeView({
  snapshot,
  workspaceId,
  timezone,
}: {
  snapshot: HomeSnapshot;
  workspaceId: string;
  timezone: string;
}) {
  // Devices, the hub's presence and command results arrive live: setup advances by itself.
  useRealtimeRefresh(workspaceId, ["home_devices", "home_hubs", "home_commands"]);
  const setup: HomeSetupState = snapshot.hub?.setup ?? "desktop_not_configured";
  if (setup !== "hub_ready" || !snapshot.devices.length)
    return <SetupPanel snapshot={snapshot} state={setup} timezone={timezone} />;
  return <Dashboard snapshot={snapshot} timezone={timezone} />;
}

// ── Setup ────────────────────────────────────────────────────────────────────

const STEP_OF: Record<HomeSetupState, number> = {
  desktop_not_configured: 0,
  desktop_offline: 0,
  desktop_update_required: 0,
  hub_error: 1,
  hub_initializing: 1,
  desktop_online: 2,
  hub_ready: 2,
};

function SetupPanel({
  snapshot,
  state,
  timezone,
}: {
  snapshot: HomeSnapshot;
  state: HomeSetupState;
  timezone: string;
}) {
  const { t, locale } = useI18n();
  const s = t.smartHome.setup;
  const [triedOpen, setTriedOpen] = useState(false);
  const step = STEP_OF[state];
  const lastSeen = snapshot.hub?.lastSeenAt
    ? s.lastSeen(relativeWhen(snapshot.hub.lastSeenAt, new Date(), locale, timezone))
    : null;
  const open = () => {
    // A convenience: the authoritative signal is the hub's heartbeat, never this link.
    window.location.href = "elise://home";
    window.setTimeout(() => setTriedOpen(true), 1500);
  };
  const content: Record<
    HomeSetupState,
    { title: string; body: string | null; action: "download" | "open" | null }
  > = {
    desktop_not_configured: {
      title: s.notConfiguredTitle,
      body: s.notConfiguredBody,
      action: "download",
    },
    desktop_offline: {
      title: s.offlineTitle,
      body: [s.offlineBody, lastSeen].filter(Boolean).join(" "),
      action: "open",
    },
    desktop_update_required: { title: s.updateTitle, body: s.updateBody, action: "open" },
    hub_initializing: { title: s.initializingTitle, body: s.initializingBody, action: null },
    hub_error: { title: s.errorTitle, body: s.errorBody, action: "open" },
    desktop_online: { title: s.detected, body: s.searching, action: null },
    hub_ready: { title: s.detected, body: s.searching, action: null },
  };
  const c = content[state];
  return (
    <div className="flex flex-col gap-5">
      <ol aria-label={t.smartHome.title} className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        {s.steps.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5",
              i < step ? "text-success" : i === step ? "text-fg" : "text-faint",
            )}
          >
            {i < step ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <span aria-hidden>{i + 1}.</span>
            )}
            {label}
          </li>
        ))}
      </ol>
      <section className={cn(CARD, "flex flex-col items-start gap-3 px-5 py-6")} aria-live="polite">
        <h2 className="text-[19px] font-medium">{c.title}</h2>
        {c.body && <p className="max-w-xl text-[14px] text-muted">{c.body}</p>}
        {(state === "hub_initializing" || state === "desktop_online") && (
          <span className="h-1 w-40 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full w-1/3 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          </span>
        )}
        <div className="flex flex-wrap gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
          {c.action === "download" && (
            <Link href="/download/desktop?from=home" className={buttonVariants()}>
              {s.download}
            </Link>
          )}
          {c.action === "open" && <Button onClick={open}>{s.openDesktop}</Button>}
          {c.action === "download" && (
            <Button variant="secondary" onClick={() => toast(s.haveItBody)}>
              {s.haveIt}
            </Button>
          )}
        </div>
        {triedOpen && (
          <p className="text-[13px] text-muted">
            {s.notOpened}{" "}
            <Link href="/download/desktop?from=home" className="text-accent-text hover:underline">
              {s.download}
            </Link>
          </p>
        )}
      </section>
      <DevPairing />
    </div>
  );
}

/** For the development agent (and future ELISE hardware): a one-time pairing code. */
function DevPairing() {
  const { t, locale } = useI18n();
  const s = t.smartHome.setup;
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <details className="text-[13px] text-muted">
      <summary className="cursor-pointer select-none">{s.devTitle}</summary>
      <div className="mt-2 flex flex-col items-start gap-2">
        <p>{s.devBody}</p>
        {code ? (
          <>
            <p className="font-mono text-[18px] tracking-[0.12em] text-fg">{code.code}</p>
            <p className="text-[12px] text-faint">
              {new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
                new Date(code.expiresAt),
              )}{" "}
              · {s.devCommand}
            </p>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await createPairingCodeAction();
                if (r.ok) setCode(r.value);
                else toast.error(errorText(t, r.error));
              })
            }
          >
            {s.devGenerate}
          </Button>
        )}
      </div>
    </details>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ snapshot, timezone }: { snapshot: HomeSnapshot; timezone: string }) {
  const { t, locale } = useI18n();
  const h = t.smartHome;
  const command = useCommand();
  const [room, setRoom] = useState<string | null>(null);
  const [type, setType] = useState<HomeDeviceType | "">("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<HomeDevice | null>(null);
  const [editing, setEditing] = useState<HomeScene | "new" | null>(null);
  const [adding, setAdding] = useState<"menu" | "room" | null>(null);
  const hub = snapshot.hub!;
  const types = [...new Set(snapshot.devices.map((d) => d.type))];
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const shown = useMemo(
    () =>
      snapshot.devices
        .filter((d) => (room ? d.roomId === room : true))
        .filter((d) => (type ? d.type === type : true))
        .filter((d) => (q ? fold(`${d.name} ${d.aliases.join(" ")}`).includes(fold(q)) : true))
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)),
    [snapshot.devices, room, type, q],
  );
  const roomName = (id: string | null) => snapshot.rooms.find((r) => r.id === id)?.name ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-[13.5px]">
          <span
            aria-hidden
            className={cn(
              "size-2 rounded-full",
              hub.status === "online"
                ? "bg-success"
                : hub.status === "degraded"
                  ? "bg-approval"
                  : "bg-danger",
            )}
          />
          {h.hub[hub.status]}
        </span>
        <span className="text-[12.5px] text-faint">
          {[
            hub.lastSyncAt
              ? h.hub.lastSync(relativeWhen(hub.lastSyncAt, new Date(), locale, timezone))
              : null,
            h.hub.devices(snapshot.devices.length),
            snapshot.rooms.length ? h.hub.rooms(snapshot.rooms.length) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          onClick={() => setAdding("menu")}
          aria-label={h.add.label}
        >
          <Plus />
          <span className="max-sm:sr-only">{h.add.label}</span>
        </Button>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="type-label text-faint">{h.modes}</h2>
        <div className="flex flex-wrap gap-2">
          {snapshot.scenes.map((s) => (
            <span key={s.id} className={cn(CARD, "flex items-center rounded-full")}>
              <button
                type="button"
                disabled={command.pending}
                onClick={() => command.runScene(s)}
                aria-label={h.scene.run(s.name)}
                className="flex min-h-10 items-center gap-1.5 rounded-l-full pr-1.5 pl-3.5 text-[13.5px] hover:bg-active"
              >
                <Play className="size-3.5 text-accent-text" aria-hidden />
                {s.name}
              </button>
              <button
                type="button"
                onClick={() => setEditing(s)}
                aria-label={`${h.scene.edit}: ${s.name}`}
                className="grid size-10 place-items-center rounded-r-full text-faint hover:bg-active hover:text-fg"
              >
                <Pencil className="size-3.5" aria-hidden />
              </button>
            </span>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
            <Plus />
            {h.scene.new}
          </Button>
        </div>
        {!snapshot.scenes.length && <p className="text-[12.5px] text-faint">{h.noModes}</p>}
      </section>

      {snapshot.rooms.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{h.rooms}</h2>
          <div
            role="radiogroup"
            aria-label={h.rooms}
            className="-mx-4 no-scrollbar flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0"
          >
            {[{ id: null, name: h.allRooms }, ...snapshot.rooms].map((r) => (
              <button
                key={r.id ?? "all"}
                type="button"
                role="radio"
                aria-checked={room === r.id}
                onClick={() => setRoom(r.id)}
                className={cn(
                  "min-h-10 shrink-0 rounded-full border px-3.5 text-[13.5px] transition-colors",
                  room === r.id
                    ? "border-accent bg-accent-soft text-accent-text"
                    : "border-border text-muted hover:text-fg",
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto type-label text-faint">{h.devices}</h2>
          <label className="relative flex-1 sm:max-w-64">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={h.search}
              aria-label={h.search}
              className="h-10 pl-9"
            />
          </label>
          {types.length > 1 && (
            <Select
              aria-label={h.allTypes}
              value={type}
              onChange={(e) => setType(e.target.value as HomeDeviceType | "")}
              className="h-10 w-auto"
            >
              <option value="">{h.allTypes}</option>
              {types.map((x) => (
                <option key={x} value={x}>
                  {h.types[x]}
                </option>
              ))}
            </Select>
          )}
        </div>
        {shown.length ? (
          <ul
            className={cn(
              CARD,
              "divide-y divide-border overflow-hidden md:grid md:grid-cols-2 md:gap-px md:divide-y-0 md:bg-border",
            )}
          >
            {shown.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                room={room ? null : roomName(d.roomId)}
                stale={hub.status === "offline"}
                timezone={timezone}
                onOpen={() => setOpen(d)}
                onToggle={(on) => command.control(d, [{ type: "power", value: on }])}
                pending={command.pending}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-muted">{h.noMatches}</p>
        )}
      </section>

      {open && (
        <DeviceSheet
          device={snapshot.devices.find((d) => d.id === open.id) ?? open}
          rooms={snapshot.rooms}
          timezone={timezone}
          onClose={() => setOpen(null)}
        />
      )}
      {editing && (
        <SceneEditor
          scene={editing === "new" ? null : editing}
          devices={snapshot.devices}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog open={adding === "menu"} onClose={() => setAdding(null)} title={h.add.label}>
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => setAdding("room")}>
            {h.add.room}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(null);
              setEditing("new");
            }}
          >
            {h.add.mode}
          </Button>
        </div>
      </Dialog>
      {adding === "room" && <NewRoom onClose={() => setAdding(null)} />}
    </div>
  );
}

function DeviceRow({
  device: d,
  room,
  stale,
  timezone,
  onOpen,
  onToggle,
  pending,
}: {
  device: HomeDevice;
  room: string | null;
  stale: boolean;
  timezone: string;
  onOpen: () => void;
  onToggle: (on: boolean) => void;
  pending: boolean;
}) {
  const { t, locale } = useI18n();
  const h = t.smartHome;
  const power = cap(d, "power") && d.available && !stale;
  return (
    <li className="flex items-center gap-3 bg-surface px-4 py-2.5">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2",
            d.state.on && d.available ? "text-accent-text" : "text-muted",
          )}
        >
          <DeviceIcon type={d.type} className="size-4.5" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[14px]">
            <span className="truncate">{d.name}</span>
            {d.favorite && (
              <Star className="size-3 shrink-0 fill-current text-approval" aria-hidden />
            )}
          </span>
          <span
            className={cn(
              "block truncate text-[12px]",
              d.available ? "text-faint" : "text-danger-text",
            )}
          >
            {!d.available && <span aria-hidden>● </span>}
            {[room, describeState(d, locale)].filter(Boolean).join(" · ")}
            {stale &&
              d.stateUpdatedAt &&
              ` · ${h.device.stale(relativeWhen(d.stateUpdatedAt, new Date(), locale, timezone))}`}
          </span>
        </span>
      </button>
      {power && (
        <Switch
          checked={Boolean(d.state.on)}
          disabled={pending}
          aria-label={h.toggle(d.name)}
          onCheckedChange={onToggle}
        />
      )}
    </li>
  );
}

/** Commit-on-release slider: one command per gesture, never one per pixel. */
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  const commit = () => v !== value && onCommit(v);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[13px]">
        <span>{label}</span>
        <span className="font-mono text-muted">
          {v}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="h-8 w-full accent-[var(--accent)]"
      />
    </div>
  );
}

function DeviceSheet({
  device: d,
  rooms,
  timezone,
  onClose,
}: {
  device: HomeDevice;
  rooms: HomeSnapshot["rooms"];
  timezone: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const h = t.smartHome;
  const x = h.device;
  const router = useRouter();
  const command = useCommand();
  const [name, setName] = useState(d.name);
  const [aliases, setAliases] = useState(d.aliases.join(", "));
  const [roomId, setRoomId] = useState(d.roomId ?? "");
  const [saving, startSave] = useTransition();
  const s = d.state;
  const live = d.available;
  const temp = cap(d, "temperature");
  const hvac = cap(d, "hvac_mode");
  const fanMode = cap(d, "fan_mode");
  const humidity = cap(d, "humidity");
  const tone = cap(d, "color_temp");
  const source = cap(d, "source");
  const send = (actions: HomeActionInput[]) => command.control(d, actions);
  const save = (patch: Record<string, unknown>) =>
    startSave(async () => {
      const r = await updateDeviceAction(d.id, patch);
      if (!r.ok) return void toast.error(errorText(t, r.error));
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} title={d.name} description={describeState(d, locale)}>
      {!live && <p className="text-[13px] text-danger-text">● {h.unavailable}</p>}
      {d.stateUpdatedAt && (
        <p className="-mt-2 text-[12px] text-faint">
          {relativeWhen(d.stateUpdatedAt, new Date(), locale, timezone)}
        </p>
      )}
      <section className="flex flex-col gap-4" aria-label={x.controls}>
        {cap(d, "power") && (
          <label className="flex items-center justify-between gap-3 text-[14px]">
            {s.on ? h.turnOff : h.turnOn}
            <Switch
              checked={Boolean(s.on)}
              disabled={!live || command.pending}
              aria-label={h.toggle(d.name)}
              onCheckedChange={(on) => send([{ type: "power", value: on }])}
            />
          </label>
        )}
        {cap(d, "brightness") && (
          <Slider
            label={x.brightness}
            value={Math.round(s.brightness ?? 100)}
            min={1}
            max={100}
            suffix="%"
            disabled={!live}
            onCommit={(v) => send([{ type: "brightness", value: v }])}
          />
        )}
        {cap(d, "color") && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px]">{x.color}</span>
            <div className="flex flex-wrap gap-2">
              {SWATCHES.map((c) => {
                const rgb = COLORS[c]!;
                return (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    title={c}
                    disabled={!live || command.pending}
                    onClick={() => send([{ type: "color", value: c }])}
                    className="size-9 rounded-full border border-border-strong"
                    style={{ background: `rgb(${rgb.r} ${rgb.g} ${rgb.b})` }}
                  />
                );
              })}
            </div>
          </div>
        )}
        {tone && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px]">{x.tone}</span>
            <div className="flex gap-2">
              {(["warm", "neutral", "cool"] as const).map((w) => (
                <Button
                  key={w}
                  size="sm"
                  variant="secondary"
                  disabled={!live || command.pending}
                  onClick={() => send([{ type: "color_temp", value: w }])}
                >
                  {x.tones[w]}
                </Button>
              ))}
            </div>
          </div>
        )}
        {temp && (
          <div className="flex items-center justify-between gap-3">
            <span className="flex flex-col text-[14px]">
              {x.temperature}
              {s.currentTemperature !== undefined && (
                <span className="text-[12px] text-faint">
                  {x.current(`${s.currentTemperature} °C`)}
                </span>
              )}
            </span>
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                aria-label={`${x.temperature} −`}
                disabled={!live || command.pending}
                onClick={() => send([{ type: "temperature", value: -temp.step, relative: true }])}
              >
                <Minus />
              </Button>
              <span className="w-16 text-center font-mono text-[18px]">
                {s.targetTemperature ?? "—"}°
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`${x.temperature} +`}
                disabled={!live || command.pending}
                onClick={() => send([{ type: "temperature", value: temp.step, relative: true }])}
              >
                <Plus />
              </Button>
            </span>
          </div>
        )}
        {hvac && (
          <label className="flex items-center justify-between gap-3 text-[14px]">
            {x.mode}
            <Select
              value={s.hvacMode ?? ""}
              disabled={!live}
              onChange={(e) => send([{ type: "hvac_mode", value: e.target.value }])}
              className="h-10 w-auto"
            >
              {hvac.modes.map((m) => (
                <option key={m} value={m}>
                  {hvacLabel(m, locale)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {fanMode && (
          <label className="flex items-center justify-between gap-3 text-[14px]">
            {x.fanMode}
            <Select
              value={s.fanMode ?? ""}
              disabled={!live}
              onChange={(e) => send([{ type: "fan_mode", value: e.target.value }])}
              className="h-10 w-auto"
            >
              {fanMode.modes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
        )}
        {cap(d, "fan_speed") && (
          <Slider
            label={x.speed}
            value={Math.round(s.fanSpeed ?? 50)}
            min={0}
            max={100}
            suffix="%"
            disabled={!live}
            onCommit={(v) => send([{ type: "fan_speed", value: v }])}
          />
        )}
        {humidity && (
          <Slider
            label={x.humidity}
            value={Math.round(s.targetHumidity ?? 50)}
            min={humidity.min}
            max={humidity.max}
            suffix="%"
            disabled={!live}
            onCommit={(v) => send([{ type: "humidity", value: v }])}
          />
        )}
        {cap(d, "volume") && (
          <Slider
            label={x.volume}
            value={Math.round(s.volume ?? 20)}
            min={0}
            max={100}
            suffix="%"
            disabled={!live}
            onCommit={(v) => send([{ type: "volume", value: v }])}
          />
        )}
        {cap(d, "media") && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!live}
              onClick={() => send([{ type: "media", value: "play" }])}
            >
              {x.play}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!live}
              onClick={() => send([{ type: "media", value: "pause" }])}
            >
              {x.pause}
            </Button>
          </div>
        )}
        {source && (
          <label className="flex items-center justify-between gap-3 text-[14px]">
            {x.source}
            <Select
              value={s.source ?? ""}
              disabled={!live}
              onChange={(e) => send([{ type: "source", value: e.target.value }])}
              className="h-10 w-auto max-w-48"
            >
              {source.sources.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
        )}
        {d.type === "sensor" && s.readings?.length ? (
          <ul className="flex flex-col gap-1 text-[14px]">
            {s.readings.map((r) => (
              <li key={r.quantity} className="flex justify-between">
                <span className="text-muted">{r.quantity}</span>
                <span className="font-mono">
                  {r.value}
                  {r.unit ? ` ${r.unit}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-4" aria-label={x.settings}>
        <h3 className="type-label text-faint">{x.settings}</h3>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="home-device-name">{x.name}</Label>
          <Input
            id="home-device-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="home-device-aliases">{x.aliases}</Label>
          <Input
            id="home-device-aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            className="h-11"
          />
          <p className="text-[12px] text-faint">{x.aliasesHint}</p>
        </div>
        {rooms.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="home-device-room">{x.room}</Label>
            <Select
              id="home-device-room"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="h-11"
            >
              <option value="">{h.noRoom}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <label className="flex items-center justify-between text-[14px]">
          {x.favorite}
          <Switch
            checked={d.favorite}
            aria-label={x.favorite}
            onCheckedChange={(v) => save({ favorite: v })}
          />
        </label>
        <div data-sheet-actions className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => save({ hidden: true })}>
            {x.hide}
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              save({
                displayName: name.trim() && name.trim() !== d.name ? name.trim() : undefined,
                aliases: aliases
                  .split(",")
                  .map((a) => a.trim())
                  .filter(Boolean),
                ...(roomId !== (d.roomId ?? "") ? { roomId: roomId || null } : {}),
              })
            }
          >
            {x.save}
          </Button>
        </div>
      </section>
    </Dialog>
  );
}

function NewRoom({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const a = t.smartHome.add;
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={a.room} busy={pending}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          start(async () => {
            const r = await createRoomAction(name.trim());
            if (!r.ok) return void toast.error(errorText(t, r.error));
            router.refresh();
            onClose();
          });
        }}
      >
        <Label htmlFor="home-room-name">{a.roomName}</Label>
        <Input
          id="home-room-name"
          data-autofocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-11"
        />
        <div data-sheet-actions className="flex justify-end">
          <Button type="submit" disabled={pending || !name.trim()}>
            {a.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Modes ────────────────────────────────────────────────────────────────────

type Draft = {
  deviceId: string;
  power: "" | "on" | "off";
  brightness: string;
  color: string;
  temperature: string;
  humidity: string;
  volume: string;
};

const toDraft = (a: HomeScene["actions"][number]): Draft => {
  const get = (t: string) => a.actions.find((x) => x.type === t)?.value;
  const p = get("power");
  return {
    deviceId: a.deviceId,
    power: p === undefined ? "" : p === true || p === "on" ? "on" : "off",
    brightness: get("brightness") !== undefined ? String(get("brightness")) : "",
    color: typeof get("color") === "string" ? String(get("color")) : "",
    temperature: get("temperature") !== undefined ? String(get("temperature")) : "",
    humidity: get("humidity") !== undefined ? String(get("humidity")) : "",
    volume: get("volume") !== undefined ? String(get("volume")) : "",
  };
};

const fromDraft = (d: Draft): HomeScene["actions"][number] => ({
  deviceId: d.deviceId,
  actions: [
    ...(d.power ? [{ type: "power" as const, value: d.power === "on" }] : []),
    ...(d.brightness ? [{ type: "brightness" as const, value: Number(d.brightness) }] : []),
    ...(d.color ? [{ type: "color" as const, value: d.color }] : []),
    ...(d.temperature ? [{ type: "temperature" as const, value: Number(d.temperature) }] : []),
    ...(d.humidity ? [{ type: "humidity" as const, value: Number(d.humidity) }] : []),
    ...(d.volume ? [{ type: "volume" as const, value: Number(d.volume) }] : []),
  ],
});

/** A mode as typed device settings: only the controls each device has (no JSON, ever). */
function SceneEditor({
  scene,
  devices,
  onClose,
}: {
  scene: HomeScene | null;
  devices: HomeDevice[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const h = t.smartHome;
  const x = h.scene;
  const router = useRouter();
  const confirm = useConfirm();
  const [name, setName] = useState(scene?.name ?? "");
  const [rows, setRows] = useState<Draft[]>(scene?.actions.map(toDraft) ?? []);
  const [pick, setPick] = useState("");
  const [pending, start] = useTransition();
  const controllable = devices.filter((d) => d.type !== "sensor");
  const byId = new Map(devices.map((d) => [d.id, d]));
  const set = (i: number, patch: Partial<Draft>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid = name.trim() && rows.length && rows.every((r) => fromDraft(r).actions.length);
  return (
    <Dialog open onClose={onClose} title={scene ? x.edit : x.new} busy={pending} size="form">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          start(async () => {
            const r = await saveSceneAction({
              ...(scene ? { id: scene.id } : {}),
              name: name.trim(),
              icon: null,
              actions: rows.map(fromDraft),
            });
            if (!r.ok) return void toast.error(errorText(t, r.error));
            router.refresh();
            onClose();
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="home-scene-name">{x.name}</Label>
          <Input
            id="home-scene-name"
            data-autofocus
            value={name}
            maxLength={80}
            placeholder={x.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
            className="h-11"
          />
        </div>
        <ul className="flex flex-col gap-3">
          {rows.map((r, i) => {
            const d = byId.get(r.deviceId);
            if (!d) return null;
            return (
              <li key={r.deviceId} className={cn(CARD, "flex flex-col gap-2.5 px-4 py-3")}>
                <div className="flex items-center gap-2">
                  <DeviceIcon type={d.type} className="size-4 text-muted" />
                  <span className="flex-1 truncate text-[14px]">{d.name}</span>
                  <button
                    type="button"
                    aria-label={x.remove(d.name)}
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    className="grid size-9 place-items-center rounded-full text-faint hover:bg-active hover:text-fg"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {cap(d, "power") && (
                    <Select
                      aria-label={`${d.name}: ${h.turnOn}`}
                      value={r.power}
                      onChange={(e) => set(i, { power: e.target.value as Draft["power"] })}
                      className="h-10"
                    >
                      <option value="">{x.keep}</option>
                      <option value="on">{x.on}</option>
                      <option value="off">{x.off}</option>
                    </Select>
                  )}
                  {cap(d, "brightness") && (
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      inputMode="numeric"
                      aria-label={`${d.name}: ${h.device.brightness} %`}
                      placeholder={`${h.device.brightness} %`}
                      value={r.brightness}
                      onChange={(e) => set(i, { brightness: e.target.value })}
                      className="h-10"
                    />
                  )}
                  {cap(d, "color") && (
                    <Select
                      aria-label={`${d.name}: ${h.device.color}`}
                      value={r.color}
                      onChange={(e) => set(i, { color: e.target.value })}
                      className="h-10"
                    >
                      <option value="">{`${h.device.color}: ${x.keep}`}</option>
                      {SWATCHES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  )}
                  {cap(d, "temperature") && (
                    <Input
                      type="number"
                      step={cap(d, "temperature")!.step}
                      min={cap(d, "temperature")!.min}
                      max={cap(d, "temperature")!.max}
                      aria-label={`${d.name}: ${h.device.temperature} °C`}
                      placeholder={`${h.device.temperature} °C`}
                      value={r.temperature}
                      onChange={(e) => set(i, { temperature: e.target.value })}
                      className="h-10"
                    />
                  )}
                  {cap(d, "humidity") && (
                    <Input
                      type="number"
                      min={cap(d, "humidity")!.min}
                      max={cap(d, "humidity")!.max}
                      aria-label={`${d.name}: ${h.device.humidity} %`}
                      placeholder={`${h.device.humidity} %`}
                      value={r.humidity}
                      onChange={(e) => set(i, { humidity: e.target.value })}
                      className="h-10"
                    />
                  )}
                  {cap(d, "volume") && (
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      aria-label={`${d.name}: ${h.device.volume} %`}
                      placeholder={`${h.device.volume} %`}
                      value={r.volume}
                      onChange={(e) => set(i, { volume: e.target.value })}
                      className="h-10"
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2">
          <Select
            aria-label={x.addDevice}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-10 flex-1"
          >
            <option value="">{x.chooseDevice}</option>
            {controllable
              .filter((d) => !rows.some((r) => r.deviceId === d.id))
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            disabled={!pick}
            onClick={() => {
              setRows([
                ...rows,
                {
                  deviceId: pick,
                  power: "on",
                  brightness: "",
                  color: "",
                  temperature: "",
                  humidity: "",
                  volume: "",
                },
              ]);
              setPick("");
            }}
          >
            <Plus />
            {x.addDevice}
          </Button>
        </div>
        {!rows.length && <p className="text-[12.5px] text-faint">{x.empty}</p>}
        <div data-sheet-actions className="flex flex-wrap justify-between gap-2">
          {scene ? (
            <Button
              type="button"
              variant="ghost"
              className="hover:text-danger-text"
              disabled={pending}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: x.deleteTitle(scene.name),
                    body: x.deleteBody,
                    confirmLabel: x.delete,
                    destructive: true,
                  }))
                )
                  return;
                start(async () => {
                  const r = await deleteSceneAction(scene.id);
                  if (!r.ok) return void toast.error(errorText(t, r.error));
                  router.refresh();
                  onClose();
                });
              }}
            >
              {x.delete}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" disabled={pending || !valid}>
            {x.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
