"use client";

import {
  DoorOpen,
  HouseWifi,
  Minus,
  Pencil,
  Play,
  Plus,
  Radar,
  Search,
  Sparkles,
  Star,
  Wifi,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { OverflowMenu, type MenuAction } from "@/components/ui/sheet-menu";
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
  type HomeSnapshot,
} from "@/core/home/model";
import type { DesktopPresence } from "@/core/platform/presence";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  controlDeviceAction,
  createRoomAction,
  deleteSceneAction,
  runSceneAction,
  saveSceneAction,
  updateDeviceAction,
} from "./actions";
import { DeviceDiscovery, useDevicesStepDone } from "./device-discovery";
import { DeviceIcon } from "./device-icon";
import { HomeSetup, type DesktopDownload } from "./home-setup";
import { useHomeRuntime } from "./runtime-context";

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
  desktops = [],
  download = null,
  platform = null,
  devTools = false,
}: {
  snapshot: HomeSnapshot;
  workspaceId: string;
  timezone: string;
  /** This person's computers (ADR-081/082): setup advances from their presence. */
  desktops?: readonly DesktopPresence[];
  download?: DesktopDownload | null;
  platform?: "windows" | "macos" | null;
  devTools?: boolean;
}) {
  // Devices, presence and command results arrive live: setup advances by itself.
  useRealtimeRefresh(workspaceId, [
    "home_devices",
    "home_hubs",
    "home_commands",
    "desktop_installations",
  ]);
  const runtime = useHomeRuntime();
  // In Desktop, this computer's Home Hub must be ready too (ADR-082).
  const localPending = Boolean(runtime?.state && runtime.state.runtime.phase !== "ready");
  // ADR-090: devices, or the person chose to continue without them for now.
  const [devicesStepDone] = useDevicesStepDone();
  if (
    snapshot.hub?.setup !== "hub_ready" ||
    (!snapshot.devices.length && !devicesStepDone) ||
    localPending
  )
    return (
      <HomeSetup
        snapshot={snapshot}
        desktops={desktops}
        download={download}
        platform={platform}
        devTools={devTools}
        timezone={timezone}
      />
    );
  return <Dashboard snapshot={snapshot} timezone={timezone} />;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ snapshot, timezone }: { snapshot: HomeSnapshot; timezone: string }) {
  const { t } = useI18n();
  const h = t.smartHome;
  const command = useCommand();
  const [room, setRoom] = useState<string | null>(null);
  const [type, setType] = useState<HomeDeviceType | "">("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<HomeDevice | null>(null);
  const [editing, setEditing] = useState<HomeScene | "new" | null>(null);
  const [adding, setAdding] = useState<"room" | "devices" | null>(null);
  const hub = snapshot.hub!;
  const hasDevices = snapshot.devices.length > 0;
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
  const addItems: MenuAction[] = [
    { label: h.setup.discover.scan, icon: Wifi, onClick: () => setAdding("devices") },
    { label: h.add.room, icon: DoorOpen, onClick: () => setAdding("room") },
    { label: h.add.mode, icon: Sparkles, onClick: () => setEditing("new"), disabled: !hasDevices },
  ];
  return (
    <div className="flex flex-col gap-8">
      <HubCard snapshot={snapshot} timezone={timezone} addItems={addItems} />

      <section aria-labelledby="home-modes" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id="home-modes" className="mr-auto type-label text-faint">
            {h.modes}
          </h2>
          {hasDevices && snapshot.scenes.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setEditing("new")}>
              <Plus />
              {h.scene.new}
            </Button>
          )}
        </div>
        {snapshot.scenes.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {snapshot.scenes.map((s) => (
              <li key={s.id}>
                <ModeTile
                  scene={s}
                  disabled={command.pending}
                  onRun={() => command.runScene(s)}
                  onEdit={() => setEditing(s)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <button
            type="button"
            disabled={!hasDevices}
            onClick={() => setEditing("new")}
            className="group flex items-center gap-3.5 rounded-2xl border border-dashed border-border-strong px-4 py-4 text-left transition-colors enabled:hover:border-accent-line enabled:hover:bg-accent-soft/40 disabled:cursor-default"
          >
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted transition-colors group-enabled:group-hover:text-accent-text"
            >
              <Sparkles className="size-[18px]" strokeWidth={1.7} />
            </span>
            <span className="min-w-0 flex-1">
              {hasDevices && <span className="block text-[14.5px]">{h.scene.new}</span>}
              <span className="block text-[13px] text-muted">
                {hasDevices ? h.noModes : h.modesNeedDevices}
              </span>
            </span>
            {hasDevices && <Plus className="size-4 shrink-0 text-faint" aria-hidden />}
          </button>
        )}
      </section>

      <section aria-labelledby="home-devices" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="home-devices" className="type-label text-faint max-sm:w-full sm:mr-auto">
            {h.devices}
          </h2>
          {hasDevices && (
            <>
              <label className="relative flex-1 sm:max-w-64">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={h.search}
                  aria-label={h.search}
                  className="h-10 rounded-full pl-9"
                />
              </label>
              {types.length > 1 && (
                <Select
                  aria-label={h.allTypes}
                  value={type}
                  onChange={(e) => setType(e.target.value as HomeDeviceType | "")}
                  className="h-10 w-auto rounded-full"
                >
                  <option value="">{h.allTypes}</option>
                  {types.map((x) => (
                    <option key={x} value={x}>
                      {h.types[x]}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
        </div>
        {snapshot.rooms.length > 0 && hasDevices && (
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
                  "h-10 shrink-0 rounded-full border px-3.5 text-[14px] transition-colors md:h-8 md:px-3 md:text-[13px]",
                  room === r.id
                    ? "border-accent-line bg-accent-soft text-accent-text"
                    : "border-border text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {r.name}
              </button>
            ))}
          </div>
        )}
        {!hasDevices ? (
          <EmptyDevices onScan={() => setAdding("devices")} />
        ) : shown.length ? (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((d) => (
              <li key={d.id}>
                <DeviceTile
                  device={d}
                  room={room ? null : roomName(d.roomId)}
                  stale={hub.status === "offline"}
                  timezone={timezone}
                  onOpen={() => setOpen(d)}
                  onToggle={(on) => command.control(d, [{ type: "power", value: on }])}
                  pending={command.pending}
                />
              </li>
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
      {adding === "room" && <NewRoom onClose={() => setAdding(null)} />}
      <Dialog
        open={adding === "devices"}
        onClose={() => setAdding(null)}
        title={h.setup.discover.title}
      >
        <DeviceDiscovery onDone={() => setAdding(null)} addedCount={snapshot.devices.length} />
      </Dialog>
    </div>
  );
}

/** The hub at a glance: is ELISE Home reachable, when it last synced, what's on. */
function HubCard({
  snapshot,
  timezone,
  addItems,
}: {
  snapshot: HomeSnapshot;
  timezone: string;
  addItems: MenuAction[];
}) {
  const { t, locale } = useI18n();
  const h = t.smartHome;
  const hub = snapshot.hub!;
  const online = hub.status === "online";
  const dot = online ? "bg-success" : hub.status === "degraded" ? "bg-approval" : "bg-danger";
  const stats = [
    { label: h.devices, value: snapshot.devices.length },
    { label: h.onNow, value: snapshot.devices.filter((d) => d.available && d.state.on).length },
    { label: h.rooms, value: snapshot.rooms.length },
  ];
  return (
    <section
      aria-label={h.hub[hub.status]}
      className="relative rounded-3xl border border-border bg-surface p-4 md:p-5"
    >
      {online && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl"
        >
          <div className="absolute -top-28 -right-20 size-72 rounded-full bg-accent/10 blur-3xl" />
        </div>
      )}
      <div className="relative flex items-center gap-3.5">
        <span
          aria-hidden
          className={cn(
            "relative grid size-11 shrink-0 place-items-center rounded-2xl",
            online ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted",
          )}
        >
          <HouseWifi className="size-5" strokeWidth={1.7} />
          <span className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-surface">
            {online && (
              <span className="absolute size-2 rounded-full bg-success opacity-60 motion-safe:animate-ping" />
            )}
            <span className={cn("relative size-2 rounded-full", dot)} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium">{h.hub[hub.status]}</p>
          {hub.lastSyncAt && (
            <p className="truncate text-[12.5px] text-faint">
              {h.hub.lastSync(relativeWhen(hub.lastSyncAt, new Date(), locale, timezone))}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <OverflowMenu
            label={h.add.label}
            items={addItems}
            trigger={
              <>
                <Plus className="size-4" aria-hidden />
                <span className="max-sm:sr-only">{h.add.label}</span>
              </>
            }
            className="flex size-auto h-10 gap-2 border border-border-strong px-3.5 text-[14px] font-medium text-fg md:size-auto md:h-9"
          />
        </div>
      </div>
      <dl className="relative mt-4 grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl bg-surface-2/60 px-3 py-2.5 md:px-4">
            <dt className="truncate text-[12px] text-faint">{s.label}</dt>
            <dd className="text-[22px] leading-tight font-light tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ModeTile({
  scene,
  disabled,
  onRun,
  onEdit,
}: {
  scene: HomeScene;
  disabled: boolean;
  onRun: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const h = t.smartHome;
  return (
    <div className="relative h-full">
      <button
        type="button"
        disabled={disabled}
        onClick={onRun}
        aria-label={h.scene.run(scene.name)}
        className="flex h-full w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-3.5 text-left transition-colors hover:border-accent-line hover:bg-accent-soft/40 disabled:opacity-60"
      >
        <span
          aria-hidden
          className="grid size-9 place-items-center rounded-full bg-accent-soft text-accent-text"
        >
          <Play className="size-3.5 translate-x-px fill-current" />
        </span>
        <span className="max-w-full min-w-0 pr-8">
          <span className="block truncate text-[14.5px] font-medium">{scene.name}</span>
          <span className="block text-[12.5px] text-faint">
            {h.hub.devices(scene.actions.length)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`${h.scene.edit}: ${scene.name}`}
        className="absolute top-2 right-2 grid size-9 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg"
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

function EmptyDevices({ onScan }: { onScan: () => void }) {
  const { t } = useI18n();
  const e = t.smartHome.empty;
  return (
    <div className="relative flex flex-col items-center gap-4 overflow-hidden rounded-3xl border border-border bg-surface px-6 py-10 text-center">
      <div aria-hidden className="canvas-dots pointer-events-none absolute inset-0 opacity-60" />
      <span
        aria-hidden
        className="relative grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-text"
      >
        <Radar className="size-6" strokeWidth={1.6} />
      </span>
      <div className="relative flex max-w-md flex-col gap-1.5">
        <h3 className="text-[18px] font-light tracking-[-0.01em]">{e.title}</h3>
        <p className="text-[14px] text-muted">{e.body}</p>
      </div>
      <Button className="relative" onClick={onScan}>
        <Wifi />
        {e.scan}
      </Button>
    </div>
  );
}

function DeviceTile({
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
  const lit = Boolean(d.state.on) && d.available;
  return (
    <div
      className={cn(
        "flex h-full items-center gap-3 rounded-2xl border bg-surface px-3.5 py-3 transition-colors",
        lit ? "border-accent-line" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl transition-colors",
            lit ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-muted",
          )}
        >
          <DeviceIcon type={d.type} className="size-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-[14.5px]">
            <span className="truncate">{d.name}</span>
            {d.favorite && (
              <Star className="size-3 shrink-0 fill-current text-approval" aria-hidden />
            )}
          </span>
          <span
            className={cn(
              "block truncate text-[12.5px]",
              !d.available ? "text-danger-text" : lit ? "text-accent-text" : "text-faint",
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
    </div>
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
      {!live && (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-danger-text">● {h.unavailable}</p>
          {d.type === "media_player" && <p className="text-[13px] text-muted">{h.unavailableTv}</p>}
        </div>
      )}
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
  const [pending, start] = useTransition();
  const controllable = devices.filter((d) => d.type !== "sensor");
  const remaining = controllable.filter((d) => !rows.some((r) => r.deviceId === d.id));
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
        {remaining.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="type-label text-faint">{x.addDevice}</span>
            <ul className="flex flex-wrap gap-2">
              {remaining.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setRows([
                        ...rows,
                        {
                          deviceId: d.id,
                          power: "on",
                          brightness: "",
                          color: "",
                          temperature: "",
                          humidity: "",
                          volume: "",
                        },
                      ])
                    }
                    className="flex h-10 items-center gap-2 rounded-full border border-border bg-surface pr-3.5 pl-2.5 text-[13.5px] transition-colors hover:border-accent-line hover:bg-accent-soft/40"
                  >
                    <Plus className="size-3.5 text-accent-text" aria-hidden />
                    <DeviceIcon type={d.type} className="size-4 text-muted" />
                    {d.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
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
