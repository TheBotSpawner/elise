"use client";

import {
  ChevronDown,
  ChevronUp,
  Droplets,
  Fan,
  House,
  Menu,
  Minus,
  Pause,
  Play,
  Plus,
  Power,
  SkipBack,
  SkipForward,
  Snowflake,
  Sparkles,
  Sun,
  Undo2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { hvacLabel, type HomeActionInput, type HomeDevice } from "@/core/home/model";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Key = { key: string; label: string };

/** What a remote's buttons are, in ELISE's meanings (ADR-110 commands, ADR-118 Tuya keys). */
export function remoteKeys(d: Pick<HomeDevice, "capabilities">): Key[] {
  for (const c of d.capabilities) {
    if (c.type === "tuya_ir") return c.keys;
    if (c.type === "ir") return c.commands.filter((x) => x.verified);
  }
  return [];
}

/** An infrared device: a Smart Life remote or a Broadlink one. */
export const isRemote = (d: Pick<HomeDevice, "capabilities">) =>
  d.capabilities.some((c) => c.type === "tuya_ir" || c.type === "ir");

const MODE_ICON: Record<string, LucideIcon> = {
  cool: Snowflake,
  heat: Sun,
  auto: Sparkles,
  fan_only: Fan,
  dry: Droplets,
};
const NAV: [string, LucideIcon][] = [
  ["back", Undo2],
  ["home", House],
  ["menu", Menu],
  ["previous", SkipBack],
  ["play", Play],
  ["pause", Pause],
  ["next", SkipForward],
];

/**
 * A device's remote, laid out like one (ADR-128): power first; volume and channel as rockers;
 * navigation as icons; an air conditioner as power, a temperature stepper, mode and fan. Only the
 * buttons this remote really has appear; the rest are one tap away under "Más botones".
 */
export function RemoteControl({
  device: d,
  disabled,
  send,
}: {
  device: HomeDevice;
  disabled: boolean;
  send: (actions: HomeActionInput[]) => void;
}) {
  const { t, locale } = useI18n();
  const r = t.smartHome.remote;
  const keys = remoteKeys(d);
  const s = d.state;
  const tuya = d.capabilities.find((c) => c.type === "tuya_ir");
  const ac = tuya?.kind === "ac" && tuya.ac?.modes.length ? tuya.ac : null;
  const used = new Set<string>();
  const find = (k: string) => {
    const hit = keys.find((x) => x.key === k);
    if (hit) used.add(k);
    return hit;
  };
  const press = (k: Key) => send([{ type: "button", value: k.key }]);

  if (ac) {
    const mode = ac.modes.find((m) => m.mode === s.hvacMode) ?? ac.modes[0]!;
    const temp = s.targetTemperature;
    const at = temp === undefined ? -1 : mode.temps.indexOf(temp);
    const step = (dir: 1 | -1) => {
      const next = at < 0 ? mode.temps[dir > 0 ? 0 : mode.temps.length - 1] : mode.temps[at + dir];
      if (next !== undefined) send([{ type: "temperature", value: next }]);
    };
    ["power_on", "power_off", "power_toggle"].forEach(find);
    return (
      <div className="flex flex-col gap-5">
        <Segmented label={r.power}>
          {[true, false].map((on) => (
            <Choice
              key={String(on)}
              selected={s.on === on}
              disabled={disabled}
              onClick={() => send([{ type: "power", value: on }])}
            >
              <Power aria-hidden className="size-4" />
              {on ? r.on : r.off}
            </Choice>
          ))}
        </Segmented>
        {mode.temps.length > 0 && (
          <div
            className="flex items-center justify-center gap-6"
            role="group"
            aria-label={r.temperature}
          >
            <RoundButton
              label={r.tempDown}
              disabled={disabled || at === 0}
              onClick={() => step(-1)}
            >
              <Minus />
            </RoundButton>
            <p className="w-24 text-center" aria-live="polite">
              <span className="text-[40px] leading-none font-light tracking-tight tabular-nums">
                {temp ?? "—"}
              </span>
              <span className="align-top text-[16px] text-muted">°C</span>
            </p>
            <RoundButton
              label={r.tempUp}
              disabled={disabled || (at >= 0 && at === mode.temps.length - 1)}
              onClick={() => step(1)}
            >
              <Plus />
            </RoundButton>
          </div>
        )}
        {ac.modes.length > 1 && (
          <Segmented label={r.mode}>
            {ac.modes.map((m) => {
              const Icon = MODE_ICON[m.mode] ?? Sparkles;
              return (
                <Choice
                  key={m.mode}
                  selected={m.mode === s.hvacMode}
                  disabled={disabled}
                  onClick={() => send([{ type: "hvac_mode", value: m.mode }])}
                  vertical
                >
                  <Icon aria-hidden className="size-4" />
                  {hvacLabel(m.mode, locale)}
                </Choice>
              );
            })}
          </Segmented>
        )}
        {mode.fans.length > 0 && (
          <Segmented label={r.fan}>
            {mode.fans.map((f) => (
              <Choice
                key={f}
                selected={f === s.fanMode}
                disabled={disabled}
                onClick={() => send([{ type: "fan_mode", value: f }])}
              >
                {t.smartHome.ir.ac.fans[f] ?? f}
              </Choice>
            ))}
          </Segmented>
        )}
        <MoreKeys keys={keys.filter((k) => !used.has(k.key))} disabled={disabled} onPress={press} />
      </div>
    );
  }

  const power = find("power_toggle") ?? find("power_on");
  const off = find("power_off");
  const mute = find("mute");
  const volume = [find("volume_up"), find("volume_down")] as const;
  const channel = [find("channel_up"), find("channel_down")] as const;
  const input = find("input");
  const nav = NAV.flatMap(([k, icon]) => {
    const hit = find(k);
    return hit ? [{ ...hit, icon }] : [];
  });
  const rest = keys.filter((k) => !used.has(k.key));
  const laidOut = used.size > 0;

  return (
    <div className="mx-auto flex w-full max-w-64 flex-col gap-5">
      {(power || off || mute || input) && (
        <div className="flex items-center justify-center gap-8">
          <div className="flex gap-2">
            {power && (
              <RoundButton
                label={power.label}
                disabled={disabled}
                onClick={() => press(power)}
                tone="power"
              >
                <Power />
              </RoundButton>
            )}
            {off && (
              <RoundButton label={off.label} disabled={disabled} onClick={() => press(off)}>
                <Power />
              </RoundButton>
            )}
          </div>
          <div className="flex gap-2">
            {input && (
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => press(input)}
              >
                {r.input}
              </Button>
            )}
            {mute && (
              <RoundButton label={mute.label} disabled={disabled} onClick={() => press(mute)}>
                <VolumeX />
              </RoundButton>
            )}
          </div>
        </div>
      )}
      {(volume.some(Boolean) || channel.some(Boolean)) && (
        <div className="flex justify-center gap-6">
          <Rocker
            label={r.volume}
            volume
            up={volume[0]}
            down={volume[1]}
            disabled={disabled}
            onPress={press}
          />
          <Rocker
            label={r.channel}
            up={channel[0]}
            down={channel[1]}
            disabled={disabled}
            onPress={press}
          />
        </div>
      )}
      {nav.length > 0 && (
        <div className="flex flex-wrap justify-center gap-2">
          {nav.map(({ icon: Icon, ...k }) => (
            <RoundButton key={k.key} label={k.label} disabled={disabled} onClick={() => press(k)}>
              <Icon />
            </RoundButton>
          ))}
        </div>
      )}
      {laidOut ? (
        <MoreKeys keys={rest} disabled={disabled} onPress={press} />
      ) : (
        <KeyGrid keys={rest} disabled={disabled} onPress={press} />
      )}
    </div>
  );
}

function RoundButton({
  label,
  disabled,
  onClick,
  tone,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  tone?: "power";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-12 place-items-center rounded-full border transition-colors disabled:opacity-40 [&_svg]:size-5",
        tone === "power"
          ? "border-danger/30 text-danger-text hover:bg-danger/10"
          : "border-border bg-surface text-fg hover:bg-active",
      )}
    >
      {children}
    </button>
  );
}

/** Volume or channel: one pill, up on top and down below, its name in the middle. */
function Rocker({
  label,
  volume = false,
  up,
  down,
  disabled,
  onPress,
}: {
  label: string;
  /** Volume shows + / −; channel, up / down arrows. */
  volume?: boolean;
  up: Key | undefined;
  down: Key | undefined;
  disabled: boolean;
  onPress: (k: Key) => void;
}) {
  if (!up && !down) return null;
  const half =
    "grid h-12 w-16 place-items-center transition-colors hover:bg-active disabled:opacity-40";
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col items-center overflow-hidden rounded-full border border-border bg-surface"
    >
      <button
        type="button"
        aria-label={up?.label ?? `${label} +`}
        title={up?.label}
        disabled={disabled || !up}
        onClick={() => up && onPress(up)}
        className={half}
      >
        {volume ? (
          <Plus className="size-5" aria-hidden />
        ) : (
          <ChevronUp className="size-5" aria-hidden />
        )}
      </button>
      <span className="py-1 text-[11px] tracking-wide text-faint uppercase" aria-hidden>
        {label}
      </span>
      <button
        type="button"
        aria-label={down?.label ?? `${label} −`}
        title={down?.label}
        disabled={disabled || !down}
        onClick={() => down && onPress(down)}
        className={half}
      >
        {volume ? (
          <Minus className="size-5" aria-hidden />
        ) : (
          <ChevronDown className="size-5" aria-hidden />
        )}
      </button>
    </div>
  );
}

function Segmented({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="type-label text-faint">{label}</span>
      <div
        role="group"
        aria-label={label}
        className="grid grid-cols-[repeat(auto-fit,minmax(4.75rem,1fr))] gap-1 rounded-2xl bg-surface-2 p-1"
      >
        {children}
      </div>
    </div>
  );
}

function Choice({
  selected,
  disabled,
  onClick,
  vertical,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  vertical?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-w-0 items-center justify-center gap-1.5 rounded-xl px-1.5 text-[13px] transition-colors disabled:opacity-40",
        vertical ? "flex-col py-2" : "h-10",
        selected ? "bg-bg font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function KeyGrid({
  keys,
  disabled,
  onPress,
}: {
  keys: Key[];
  disabled: boolean;
  onPress: (k: Key) => void;
}) {
  if (!keys.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {keys.map((k) => (
        <button
          key={k.key}
          type="button"
          title={k.label}
          disabled={disabled}
          onClick={() => onPress(k)}
          className="h-10 truncate rounded-xl border border-border bg-surface px-3 text-[13px] transition-colors hover:bg-active disabled:opacity-40"
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}

function MoreKeys(props: { keys: Key[]; disabled: boolean; onPress: (k: Key) => void }) {
  const { t } = useI18n();
  if (!props.keys.length) return null;
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-center gap-1 text-[13px] text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        {t.smartHome.remote.more(props.keys.length)}
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-3">
        <KeyGrid {...props} />
      </div>
    </details>
  );
}
