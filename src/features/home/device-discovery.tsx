"use client";

import {
  Check,
  Eye,
  EyeOff,
  Lightbulb,
  Loader2,
  Plug,
  Radio,
  RotateCw,
  Router,
  Speaker,
  Tv,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { DiscoveredDevice, DiscoveryField, DiscoveryStep } from "@/core/home/discovery";
import type { HomeDevice, HomeRoom } from "@/core/home/model";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { adoptNewDevicesAction } from "./actions";
import { FoundDevices } from "./found-devices";
import { useHomeRuntime } from "./runtime-context";
import { TuyaConnect } from "./tuya-connect";

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
  [/broadlink/, Radio],
];
const kindIcon = (kind: string) => KIND_ICONS.find(([re]) => re.test(kind))?.[1] ?? Wifi;

/** "pin" → "PIN", "pairing_code" → "Código de vinculación"; unknown names get capitalized. */
function fieldLabel(name: string, known: Record<string, string>) {
  if (known[name]) return known[name];
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A search the person sees stays on screen a moment, even when the engine answers at once. */
const MIN_SCAN_MS = 2200;
/** The engine didn't answer: the search ends as failed, never "still looking" forever. */
const SCAN_TIMEOUT_MS = 15_000;
/** Current results shown before "Ver todos": the list never takes over the dialog. */
const SHOWN = 5;

/**
 * One search (ADR-128). "Detectados ahora" is only what the engine reports in THIS search; what
 * it registered some other time is "Encontrados anteriormente" (FoundDevices, folded). A new
 * search clears only the previous search's results; an answer that arrives after a newer search
 * started — or after the dialog closed — is dropped.
 */
type ScanState =
  | { status: "idle" | "scanning" | "failed"; results: [] }
  | { status: "completed"; results: DiscoveredDevice[] };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Hogar's "Agregar dispositivos" (ADR-090, ADR-128): this network's devices found now, with what
 * was seen before folded apart; then connected services (Smart Life). Searching the network
 * needs ELISE Desktop, where the engine runs; on the web it says so and Smart Life still works.
 */
export function DeviceDiscovery({
  onDone,
  addedCount,
  found: previous = [],
  irControllers = 0,
  onIrDevice,
  rooms = [],
  skippable = true,
}: {
  /** ADR-119: the home's rooms, to place Smart Life remotes as they're added. */
  rooms?: readonly HomeRoom[];
  /** ADR-117: infrared controllers in the home: TVs and ACs are added from here too. */
  irControllers?: number;
  onIrDevice?: () => void;
  /** Continue to Hogar (with or without devices). */
  onDone: () => void;
  /** Devices already in Hogar (the step can finish once there is one). */
  addedCount: number;
  /** ADR-103: devices the engine registered some other time, waiting for "Agregar". */
  found?: readonly HomeDevice[];
  /** Onboarding offers "Omitir por ahora"; in a dialog its × already does that. */
  skippable?: boolean;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const runtime = useHomeRuntime();
  const [scan, setScan] = useState<ScanState>({ status: "idle", results: [] });
  const [showAll, setShowAll] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const generation = useRef(0);
  const previousCount = useRef(previous.length);
  useEffect(() => {
    previousCount.current = previous.length;
  }, [previous.length]);
  const set = (id: string, s: Status) => setStatus((m) => ({ ...m, [id]: s }));

  const search = useCallback(async () => {
    if (!runtime) return;
    const id = ++generation.current;
    const started = Date.now();
    setScan({ status: "scanning", results: [] });
    setShowAll(false);
    try {
      const [list] = await Promise.all([
        withTimeout(runtime.discoveries(), SCAN_TIMEOUT_MS),
        new Promise((r) => setTimeout(r, MIN_SCAN_MS)),
      ]);
      if (id !== generation.current) return;
      setScan({ status: "completed", results: list });
      // Local diagnostics only: counts, timing and integrations — no names, ids or addresses.
      console.info("[home-discovery]", {
        ms: Date.now() - started,
        current: list.length,
        previous: previousCount.current,
        integrations: [...new Set(list.map((x) => x.kind))],
      });
    } catch (e) {
      if (id !== generation.current) return;
      setScan({ status: "failed", results: [] });
      console.info("[home-discovery]", {
        ms: Date.now() - started,
        error: e instanceof Error && e.message === "timeout" ? "timeout" : "engine",
      });
    }
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    // Search right after mount (not inside the effect itself); closing drops a late answer.
    const first = setTimeout(() => void search(), 0);
    const searches = generation;
    return () => {
      clearTimeout(first);
      searches.current++;
    };
  }, [runtime, search]);

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

  const current = scan.results.filter((x) => status[x.flowId]?.kind !== "gone");
  const shown = showAll ? current : current.slice(0, SHOWN);
  const anyAdded = addedCount > 0 || Object.values(status).some((s) => s.kind === "added");
  const scanning = scan.status === "scanning" || scan.status === "idle";
  const footer =
    anyAdded || skippable ? (
      <div className="flex flex-wrap gap-2">
        <Button variant={anyAdded ? "primary" : "ghost"} onClick={onDone}>
          {anyAdded ? d.continue : d.later}
        </Button>
      </div>
    ) : null;

  if (!runtime)
    return (
      <div className="flex flex-col gap-5">
        <section aria-labelledby="discover-network" className="flex flex-col gap-2">
          <h3 id="discover-network" className="type-label text-faint">
            {d.networkTitle}
          </h3>
          <p className="text-[13.5px] text-muted">{d.onlyDesktop}</p>
          <FoundDevices devices={previous} />
        </section>
        {/* ADR-118: Smart Life goes through Tuya's cloud: it works from the web too. */}
        <Services rooms={rooms} />
        {footer}
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="discover-network" className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2.5">
          <h3 id="discover-network" className="type-label text-faint">
            {d.networkTitle}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={scanning}
            onClick={() => void search()}
            className="ml-auto"
          >
            <RotateCw className={cn(scanning && "motion-safe:animate-spin")} aria-hidden />
            {d.scanAgain}
          </Button>
        </div>
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2.5 text-[13.5px] text-muted"
        >
          <SearchPulse active={scanning} />
          <span>
            {scanning
              ? d.scanning
              : scan.status === "failed"
                ? d.scanFailed
                : current.length
                  ? d.foundNow(current.length)
                  : d.noneNow}
          </span>
        </p>
        {(scanning || (scan.status === "completed" && !current.length)) && (
          <p className="text-[12.5px] text-faint">{scanning ? d.scanHint : d.noneHint}</p>
        )}
        {shown.length > 0 && (
          <ul className="flex flex-col gap-2">
            {shown.map((device) => {
              const s = status[device.flowId] ?? { kind: "idle" };
              return (
                <li
                  key={device.flowId}
                  className={cn(
                    "flex flex-col gap-3 rounded-2xl border bg-surface px-3.5 py-2.5 transition-colors",
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
                  {device.note === "locked" && s.kind !== "added" && (
                    <p className="text-[13px] text-approval-text">{d.locked}</p>
                  )}
                  {device.kind === "broadlink" && s.kind === "added" && (
                    <p className="text-[13px] text-muted">{d.irAdded}</p>
                  )}
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
        {current.length > shown.length && (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setShowAll(true)}>
            {d.showAll(current.length)}
          </Button>
        )}
        {/* ADR-117: one place to add everything — infrared TVs and ACs through a Broadlink too. */}
        {onIrDevice &&
          (irControllers > 0 ||
            current.some((x) => x.kind === "broadlink" && status[x.flowId]?.kind === "added")) && (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-3.5 py-2.5">
              <DeviceKindIcon kind="broadlink" added={false} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14.5px]">{d.irTitle}</span>
                <span className="text-[12.5px] text-muted">{d.irHint}</span>
              </span>
              <Button size="sm" onClick={onIrDevice}>
                {d.add}
              </Button>
            </div>
          )}
        <FoundDevices devices={previous} />
        {anyAdded && <p className="text-[12.5px] text-faint">{d.appearing}</p>}
      </section>
      <Services rooms={rooms} />
      <ManualBroadlink />
      {footer}
    </div>
  );
}

/** Block 2: connected services (cloud accounts), apart from what this network answered. */
function Services({ rooms }: { rooms: readonly HomeRoom[] }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="discover-services" className="flex flex-col gap-2.5">
      <h3 id="discover-services" className="type-label text-faint">
        {t.smartHome.setup.discover.servicesTitle}
      </h3>
      <TuyaConnect rooms={rooms} />
    </section>
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

/**
 * ADR-110: a Broadlink the engine didn't find by itself (discovery blocked, another subnet):
 * added by its address on the home network. The rest of its setup (unlock, name) is the same
 * step form as a found device's.
 */
export function ManualBroadlink() {
  const router = useRouter();
  const { t } = useI18n();
  const m = t.smartHome.ir.manual;
  const runtime = useHomeRuntime();
  const [host, setHost] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  if (!runtime) return null;
  const after = (step: DiscoveryStep) => {
    if (step.kind === "added") {
      const since = new Date(Date.now() - 15_000).toISOString();
      for (const ms of [6_000, 23_000])
        setTimeout(
          () =>
            void adoptNewDevicesAction(since).then(
              (r) => r.ok && r.value.added && router.refresh(),
            ),
          ms,
        );
      return setStatus({ kind: "added" });
    }
    if (step.kind === "confirm" || step.kind === "form") return setStatus({ kind: "form", step });
    setStatus({
      kind: "message",
      text:
        step.kind === "aborted" && step.reason === "invalid_host"
          ? m.invalid
          : step.kind === "aborted" && /already/.test(step.reason)
            ? m.already
            : m.failed,
    });
  };
  const run = async (op: () => Promise<DiscoveryStep>) => {
    setStatus({ kind: "busy" });
    try {
      after(await op());
    } catch {
      setStatus({ kind: "message", text: m.failed });
    }
  };
  return (
    <details className="text-[14px]">
      <summary className="cursor-pointer text-[13px] text-faint hover:text-muted">
        {m.title}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {status.kind === "added" ? (
          <p className="flex items-center gap-1.5 text-success">
            <Check className="size-4" aria-hidden />
            {m.added}
          </p>
        ) : status.kind === "form" ? (
          <StepForm
            name="Broadlink"
            step={status.step}
            onCancel={() => setStatus({ kind: "idle" })}
            onSubmit={(answers) =>
              void run(() => runtime.answerDiscovery(status.step.flowId, answers))
            }
          />
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => runtime.addBroadlink(host));
            }}
          >
            <p className="text-[13px] text-muted">{m.hint}</p>
            <Label htmlFor="broadlink-host">{m.host}</Label>
            <div className="flex gap-2">
              <Input
                id="broadlink-host"
                value={host}
                required
                maxLength={253}
                inputMode="decimal"
                autoComplete="off"
                placeholder="192.168.1.40"
                onChange={(e) => setHost(e.target.value)}
                className="h-10 flex-1"
              />
              <Button type="submit" size="sm" disabled={status.kind === "busy" || !host.trim()}>
                {status.kind === "busy" ? (
                  <Loader2 className="motion-safe:animate-spin" aria-hidden />
                ) : null}
                {m.add}
              </Button>
            </div>
            {status.kind === "message" && (
              <p role="alert" className="text-[13px] text-danger-text">
                {status.text}
              </p>
            )}
          </form>
        )}
      </div>
    </details>
  );
}
