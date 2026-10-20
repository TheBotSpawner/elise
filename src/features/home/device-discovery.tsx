"use client";

import {
  Check,
  Eye,
  EyeOff,
  Lightbulb,
  Loader2,
  Plug,
  RotateCw,
  Router,
  Speaker,
  Tv,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { createElement, useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { DiscoveredDevice, DiscoveryField, DiscoveryStep } from "@/core/home/discovery";
import type { HomeDevice } from "@/core/home/model";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { adoptNewDevicesAction } from "./actions";
import { FoundDevices } from "./found-devices";
import { useHomeRuntime } from "./runtime-context";

const DONE_KEY = "elise.home.devicesStep";
const doneListeners = new Set<() => void>();

/** "Continuar" / "Omitir por ahora" on the devices step: Hogar opens even with no devices yet. */
export function useDevicesStepDone(): [boolean, () => void] {
  const done = useSyncExternalStore(
    (l) => (doneListeners.add(l), () => doneListeners.delete(l)),
    () => {
      try {
        return localStorage.getItem(DONE_KEY) === "1";
      } catch {
        return false;
      }
    },
    () => false,
  );
  const mark = () => {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      // Storage blocked: the step comes back next time.
    }
    doneListeners.forEach((l) => l());
  };
  return [done, mark];
}

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "added" }
  | { kind: "gone" }
  | { kind: "message"; text: string }
  | { kind: "form"; step: Extract<DiscoveryStep, { kind: "form" | "confirm" }> };

/** What a found device probably is, from its integration ("cast" → a TV): a hint, never a claim. */
const KIND_ICONS: [RegExp, LucideIcon][] = [
  [/cast|tv|roku|webos|bravia|vizio|androidtv|apple_tv|samsung|philips_js|dlna_dmr/, Tv],
  [/sonos|speaker|denon|yamaha|heos|bose|linkplay|soundtouch/, Speaker],
  [/hue|lifx|yeelight|wiz|nanoleaf|tradfri|govee|light/, Lightbulb],
  [/shelly|tplink|kasa|tuya|meross|plug|switch|wemo/, Plug],
  [/huawei|router|upnp|igd|fritz|netgear|asus|unifi|mikrotik|tplink_omada/, Router],
];
const kindIcon = (kind: string) => KIND_ICONS.find(([re]) => re.test(kind))?.[1] ?? Wifi;

/** "pin" → "PIN", "pairing_code" → "Código de vinculación"; unknown names get capitalized. */
function fieldLabel(name: string, known: Record<string, string>) {
  if (known[name]) return known[name];
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Re-asked while the screen is open: devices keep being found for a while. */
const MIN_SCAN_MS = 2200;
const POLL_MS = 10_000;

/**
 * Hogar's "Dispositivos" step (ADR-090): what the home engine found on the network, and the
 * person choosing what to add — a confirmation or a few fields (a pairing code) each. Only in
 * ELISE Desktop, where the engine runs; on the web it says where to do it.
 */
export function DeviceDiscovery({
  onDone,
  addedCount,
  found: onNetwork = [],
}: {
  /** Continue to Hogar (with or without devices). */
  onDone: () => void;
  /** Devices already in Hogar (the step can finish once there is one). */
  addedCount: number;
  /** ADR-103: devices the engine registered by itself, waiting for "Agregar". */
  found?: readonly HomeDevice[];
}) {
  const router = useRouter();
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const runtime = useHomeRuntime();
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const set = (id: string, s: Status) => setStatus((m) => ({ ...m, [id]: s }));

  /**
   * One search. A search the person sees (the first, "Buscar de nuevo") stays on screen a moment
   * even when the engine answers at once, so it reads as searching; background polls stay quiet.
   */
  const scan = useCallback(
    async (shown = true) => {
      if (!runtime) return;
      if (shown) setScanning(true);
      try {
        const [list] = await Promise.all([
          runtime.discoveries(),
          shown ? new Promise((r) => setTimeout(r, MIN_SCAN_MS)) : null,
        ]);
        setFound(list);
      } catch {
        setFound((f) => f ?? []);
      } finally {
        if (shown) setScanning(false);
      }
    },
    [runtime],
  );

  useEffect(() => {
    if (!runtime) return;
    // First search right after mount (not inside the effect itself), then while it's open.
    const first = setTimeout(() => void scan(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void scan(false);
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [runtime, scan]);

  const after = (id: string, step: DiscoveryStep) => {
    if (step.kind === "added") {
      // ADR-103: what the engine registers right after this is the device just added (the
      // agent resyncs after 4 s and 20 s); anything else it finds later waits for "Agregar".
      const since = new Date(Date.now() - 15_000).toISOString();
      for (const ms of [6_000, 23_000])
        setTimeout(
          () =>
            void adoptNewDevicesAction(since).then(
              (r) => r.ok && r.value.added && router.refresh(),
            ),
          ms,
        );
      return set(id, { kind: "added" });
    }
    if (step.kind === "confirm" || step.kind === "form") return set(id, { kind: "form", step });
    if (step.kind === "aborted")
      return set(id, {
        kind: "message",
        text: /already/i.test(step.reason) ? d.already : d.aborted,
      });
    set(id, { kind: "message", text: d.unsupported });
  };

  const add = async (device: DiscoveredDevice) => {
    if (!runtime) return;
    set(device.flowId, { kind: "busy" });
    try {
      after(device.flowId, await runtime.openDiscovery(device.flowId));
    } catch {
      set(device.flowId, { kind: "message", text: d.aborted });
    }
  };

  const answer = async (id: string, answers: Record<string, string | number | boolean>) => {
    if (!runtime) return;
    set(id, { kind: "busy" });
    try {
      after(id, await runtime.answerDiscovery(id, answers));
    } catch {
      set(id, { kind: "message", text: d.aborted });
    }
  };

  if (!runtime)
    return (
      <div className="flex flex-col gap-3">
        <p className="max-w-xl text-[15px] text-muted">{d.onlyDesktop}</p>
        <Button variant="ghost" className="self-start" onClick={onDone}>
          {d.later}
        </Button>
      </div>
    );

  const visible = (found ?? []).filter((x) => status[x.flowId]?.kind !== "gone");
  const anyAdded = addedCount > 0 || Object.values(status).some((s) => s.kind === "added");
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-xl text-[15px] text-muted">{d.body}</p>
      <FoundDevices devices={onNetwork} />
      <div
        className="flex flex-wrap items-center gap-2.5 text-[13.5px] text-muted"
        aria-live="polite"
      >
        <SearchPulse active={scanning} />
        <span>
          {scanning
            ? d.scanning
            : visible.length
              ? `${d.found(visible.length)} · ${d.stillLooking}`
              : d.noneShort}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={scanning}
          onClick={() => void scan()}
          className="ml-auto"
        >
          <RotateCw className={cn(scanning && "animate-spin")} />
          {found === null ? d.scan : d.scanAgain}
        </Button>
      </div>
      {scanning && !visible.length ? (
        <Scanning />
      ) : (
        found !== null &&
        !visible.length && (
          <p className="rounded-2xl border border-dashed border-border-strong px-4 py-3.5 text-[13.5px] text-muted">
            {d.none}
          </p>
        )
      )}
      {visible.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visible.map((device) => {
            const s = status[device.flowId] ?? { kind: "idle" };
            return (
              <li
                key={device.flowId}
                className={cn(
                  "flex flex-col gap-3 rounded-2xl border bg-surface px-3.5 py-3 transition-colors",
                  s.kind === "form"
                    ? "border-accent-line"
                    : s.kind === "added"
                      ? "border-success/40"
                      : "border-border",
                )}
              >
                <div className="flex items-center gap-3">
                  <DeviceKindIcon kind={device.kind} added={s.kind === "added"} />
                  <span className="min-w-0 flex-1 truncate text-[14.5px]">{device.name}</span>
                  {s.kind === "added" ? (
                    <span className="flex items-center gap-1 text-[13px] text-success">
                      <Check className="size-4" aria-hidden />
                      {d.added}
                    </span>
                  ) : s.kind === "idle" || s.kind === "message" ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          set(device.flowId, { kind: "gone" });
                          void runtime.ignoreDiscovery(device.flowId, device.name);
                        }}
                      >
                        {d.skip}
                      </Button>
                      <Button size="sm" onClick={() => void add(device)}>
                        {d.add}
                      </Button>
                    </>
                  ) : s.kind === "busy" ? (
                    <span className="flex items-center gap-1.5 text-[13px] text-muted">
                      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                      {d.adding}
                    </span>
                  ) : null}
                </div>
                {s.kind === "message" && <p className="text-[13px] text-muted">{s.text}</p>}
                {s.kind === "form" && (
                  <StepForm
                    name={device.name}
                    step={s.step}
                    onCancel={() => set(device.flowId, { kind: "idle" })}
                    onSubmit={(answers) => void answer(device.flowId, answers)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {anyAdded && <p className="text-[13px] text-faint">{d.appearing}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant={anyAdded ? "primary" : "ghost"} onClick={onDone}>
          {anyAdded ? d.continue : d.later}
        </Button>
      </div>
    </div>
  );
}

function StepForm({
  name,
  step,
  onCancel,
  onSubmit,
}: {
  name: string;
  step: Extract<DiscoveryStep, { kind: "form" | "confirm" }>;
  onCancel: () => void;
  onSubmit: (answers: Record<string, string | number | boolean>) => void;
}) {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const fields: DiscoveryField[] = step.kind === "form" ? step.fields : [];
  const errors = step.kind === "form" ? step.errors : {};
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(
      fields.flatMap((f) => (f.defaultValue !== undefined ? [[f.name, f.defaultValue]] : [])),
    ),
  );
  const generalError = errors.base;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values);
      }}
    >
      {step.kind === "confirm" && <p className="text-[14px]">{d.confirm(step.title ?? name)}</p>}
      {fields.map((f) => {
        const id = `discovery-${f.name}`;
        const error = errors[f.name];
        const label = fieldLabel(f.name, d.fields);
        return (
          <div key={f.name} className="flex flex-col gap-1.5">
            {f.type === "boolean" ? (
              <label className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={values[f.name] === true}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
                />
                {label}
              </label>
            ) : (
              <>
                <Label htmlFor={id}>{label}</Label>
                {f.type === "select" ? (
                  <Select
                    id={id}
                    required={f.required}
                    value={String(values[f.name] ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    className="h-10"
                  >
                    <option value="" />
                    {f.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : f.type === "password" ? (
                  <SecretInput
                    id={id}
                    required={f.required}
                    value={String(values[f.name] ?? "")}
                    onChange={(value) => setValues((v) => ({ ...v, [f.name]: value }))}
                  />
                ) : (
                  <Input
                    id={id}
                    required={f.required}
                    type={f.type === "number" ? "number" : "text"}
                    autoComplete="off"
                    value={String(values[f.name] ?? "")}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    className="h-10"
                  />
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-[12.5px] text-danger-text">
                {d.fieldError}
              </p>
            )}
          </div>
        );
      })}
      {generalError && (
        <p role="alert" className="text-[12.5px] text-danger-text">
          {d.aborted}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          {step.kind === "confirm" ? d.add : d.submit}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {d.cancel}
        </Button>
      </div>
    </form>
  );
}

function DeviceKindIcon({ kind, added }: { kind: string; added: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl",
        added ? "bg-success/15 text-success" : "bg-surface-2 text-muted",
      )}
    >
      {createElement(kindIcon(kind), { className: "size-[18px]", strokeWidth: 1.7 })}
    </span>
  );
}

/** A pairing code or password, hidden by default; the eye shows what was typed. */
function SecretInput({
  id,
  required,
  value,
  onChange,
}: {
  id: string;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        data-autofocus
        required={required}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 pr-11 font-mono tracking-wider"
      />
      <button
        type="button"
        aria-label={shown ? d.hideValue : d.showValue}
        aria-pressed={shown}
        aria-controls={id}
        onClick={() => setShown((v) => !v)}
        className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg"
      >
        {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

/** A small live dot: brighter, with a ripple, while a search is running. */
function SearchPulse({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="relative grid size-3 place-items-center">
      <span
        className={cn(
          "absolute size-3 rounded-full bg-accent/50",
          active ? "motion-safe:animate-ping" : "opacity-0",
        )}
      />
      <span
        className={cn(
          "relative size-2 rounded-full transition-colors",
          active ? "bg-accent" : "bg-accent/60",
        )}
      />
    </span>
  );
}

/** The first search: a radar sweeping the network, so waiting never looks stuck. */
function Scanning() {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-surface px-4 py-8 text-center">
      <span aria-hidden className="relative grid size-24 place-items-center">
        {[0, 0.6, 1.2].map((delay) => (
          <span
            key={delay}
            className="absolute inset-0 rounded-full border border-accent/40 motion-safe:animate-ping"
            style={{ animationDuration: "1.8s", animationDelay: `${delay}s` }}
          />
        ))}
        <span className="relative grid size-12 place-items-center rounded-full bg-accent-soft text-accent-text">
          <Wifi className="size-5" strokeWidth={1.7} />
        </span>
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[14.5px]">{d.scanning}</p>
        <p className="text-[12.5px] text-faint">{d.scanHint}</p>
      </div>
    </div>
  );
}
