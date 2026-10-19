"use client";

import { Check, RotateCw, Wifi } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { DiscoveredDevice, DiscoveryField, DiscoveryStep } from "@/core/home/discovery";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

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

/** Re-asked while the screen is open: devices keep being found for a while. */
const POLL_MS = 10_000;

/**
 * Hogar's "Dispositivos" step (ADR-090): what the home engine found on the network, and the
 * person choosing what to add — a confirmation or a few fields (a pairing code) each. Only in
 * ELISE Desktop, where the engine runs; on the web it says where to do it.
 */
export function DeviceDiscovery({
  onDone,
  addedCount,
}: {
  /** Continue to Hogar (with or without devices). */
  onDone: () => void;
  /** Devices already in Hogar (the step can finish once there is one). */
  addedCount: number;
}) {
  const { t } = useI18n();
  const d = t.smartHome.setup.discover;
  const runtime = useHomeRuntime();
  const [found, setFound] = useState<DiscoveredDevice[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const set = (id: string, s: Status) => setStatus((m) => ({ ...m, [id]: s }));

  const scan = useCallback(async () => {
    if (!runtime) return;
    setScanning(true);
    try {
      setFound(await runtime.discoveries());
    } catch {
      setFound((f) => f ?? []);
    } finally {
      setScanning(false);
    }
  }, [runtime]);

  useEffect(() => {
    if (!runtime) return;
    // First search right after mount (not inside the effect itself), then while it's open.
    const first = setTimeout(() => void scan(), 0);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void scan();
    }, POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [runtime, scan]);

  const after = (id: string, step: DiscoveryStep) => {
    if (step.kind === "added") return set(id, { kind: "added" });
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
      <div
        className="flex flex-wrap items-center gap-2 text-[13.5px] text-muted"
        aria-live="polite"
      >
        {scanning && found === null ? (
          <span>{d.scanning}</span>
        ) : (
          <span>{visible.length ? d.found(visible.length) : d.none}</span>
        )}
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
      {visible.length > 0 && (
        <ul className="flex flex-col gap-2">
          {visible.map((device) => {
            const s = status[device.flowId] ?? { kind: "idle" };
            return (
              <li
                key={device.flowId}
                className="flex flex-col gap-3 rounded-2xl border border-border px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <Wifi className="size-4 shrink-0 text-muted" aria-hidden />
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
                    <span className="text-[13px] text-muted">{d.adding}</span>
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
        return (
          <div key={f.name} className="flex flex-col gap-1.5">
            {f.type === "boolean" ? (
              <label className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={values[f.name] === true}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.checked }))}
                />
                {f.name.replace(/_/g, " ")}
              </label>
            ) : (
              <>
                <Label htmlFor={id}>{f.name.replace(/_/g, " ")}</Label>
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
                ) : (
                  <Input
                    id={id}
                    required={f.required}
                    type={
                      f.type === "password" ? "password" : f.type === "number" ? "number" : "text"
                    }
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
