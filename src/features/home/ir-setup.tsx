"use client";

import { Check, Loader2, Radio, Wifi } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  hvacLabel,
  IR_BUTTONS,
  IR_ESSENTIAL,
  presetKey,
  type HomeDevice,
  type HomeSnapshot,
  type IrCapability,
  type IrCommand,
  type IrKind,
} from "@/core/home/model";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { controlDeviceAction, createIrDeviceAction, irCommandAction } from "./actions";
import { ManualBroadlink } from "./device-discovery";
import { DeviceIcon } from "./device-icon";
import { useHomeRuntime } from "./runtime-context";

const KINDS: IrKind[] = ["tv", "ac", "fan", "other"];
const KIND_TYPE = { tv: "media_player", ac: "climate", fan: "fan", other: "switch" } as const;
const AC_MODES = ["cool", "heat", "dry", "fan_only", "auto"] as const;
const AC_FANS = ["auto", "low", "medium", "high"] as const;

const irOf = (d: HomeDevice | undefined) =>
  d?.capabilities.find((c): c is IrCapability => c.type === "ir");

/**
 * ADR-110: a TV, air conditioner or fan through a Broadlink. Choose the controller (or find out
 * why there isn't one), say what it controls, then teach it each button from the person's own
 * remote — learned, sent once, and kept only as "works" after they say the device reacted.
 */
export function IrSetup({
  snapshot,
  device,
  controllerId,
  onClose,
  onScan,
}: {
  snapshot: HomeSnapshot;
  /** Managing an infrared device that already exists (its buttons). */
  device?: HomeDevice | null;
  /** Started from a controller's own sheet. */
  controllerId?: string | null;
  onClose: () => void;
  /** The network search, where a Broadlink is added like any found device. */
  onScan: () => void;
}) {
  const { t } = useI18n();
  const x = t.smartHome.ir;
  const router = useRouter();
  const runtime = useHomeRuntime();
  const controllers = snapshot.devices.filter((d) => d.type === "ir_controller");
  const [step, setStep] = useState<"controller" | "device" | "buttons">(
    device ? "buttons" : controllerId || controllers.length === 1 ? "device" : "controller",
  );
  const [controller, setController] = useState(controllerId ?? controllers[0]?.id ?? "");
  const [kind, setKind] = useState<IrKind>("tv");
  const [name, setName] = useState<string>(x.defaultName.tv);
  const [roomId, setRoomId] = useState(
    controllers.find((c) => c.id === (controllerId ?? controllers[0]?.id))?.roomId ?? "",
  );
  const [created, setCreated] = useState<string | null>(device?.id ?? null);
  const [pending, start] = useTransition();
  const live = snapshot.devices.find((d) => d.id === created);

  const create = () =>
    start(async () => {
      const r = await createIrDeviceAction({
        name: name.trim(),
        kind,
        controllerId: controller,
        roomId: roomId || null,
      });
      if (!r.ok) return void toast.error(errorText(t, r.error));
      setCreated(r.value.id);
      setStep("buttons");
      router.refresh();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={device ? x.manageTitle(device.name) : x.title}
      busy={pending}
      size="form"
    >
      {step === "controller" &&
        (controllers.length ? (
          <div className="flex flex-col gap-3">
            <p className="text-[14px]">{x.controller}</p>
            <ul role="radiogroup" aria-label={x.controller} className="flex flex-col gap-2">
              {controllers.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={controller === c.id}
                    onClick={() => {
                      setController(c.id);
                      setRoomId(c.roomId ?? "");
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-2xl border px-3.5 py-3 text-left text-[14.5px]",
                      controller === c.id
                        ? "border-accent-line bg-accent-soft/40"
                        : "border-border",
                    )}
                  >
                    <Radio className="size-4 text-muted" aria-hidden />
                    <span className="flex-1 truncate">{c.name}</span>
                    {!c.available && (
                      <span className="text-[12.5px] text-danger-text">
                        {t.smartHome.unavailable}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <ManualBroadlink />
            <Button className="self-end" disabled={!controller} onClick={() => setStep("device")}>
              {x.next}
            </Button>
          </div>
        ) : (
          <NoController onScan={onScan} />
        ))}

      {step === "device" && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create();
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[14px]">{x.kind}</legend>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map((k) => (
                <label
                  key={k}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-2xl border px-3.5 py-3 text-[14px]",
                    kind === k ? "border-accent-line bg-accent-soft/40" : "border-border",
                  )}
                >
                  <input
                    type="radio"
                    name="ir-kind"
                    className="sr-only"
                    checked={kind === k}
                    onChange={() => {
                      // The suggested name follows the kind until the person types their own.
                      if (name === x.defaultName[kind]) setName(x.defaultName[k]);
                      setKind(k);
                    }}
                  />
                  <DeviceIcon type={KIND_TYPE[k]} className="size-4 text-muted" />
                  {x.kinds[k]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ir-name">{x.name}</Label>
            <Input
              id="ir-name"
              value={name}
              maxLength={80}
              required
              onChange={(e) => setName(e.target.value)}
              className="h-11"
            />
          </div>
          {snapshot.rooms.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ir-room">{t.smartHome.device.room}</Label>
              <Select
                id="ir-room"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="h-11"
              >
                <option value="">{t.smartHome.noRoom}</option>
                {snapshot.rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <p className="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] text-muted">{x.quick}</p>
          <div className="flex justify-between gap-2">
            {controllers.length > 1 && !controllerId ? (
              <Button type="button" variant="ghost" onClick={() => setStep("controller")}>
                {x.back}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending || !name.trim() || !controller}>
              {x.create}
            </Button>
          </div>
        </form>
      )}

      {step === "buttons" &&
        (live && irOf(live) ? (
          <IrButtons device={live} ir={irOf(live)!} canLearn={Boolean(runtime)} onDone={onClose} />
        ) : (
          <p className="flex items-center gap-2 text-[14px] text-muted">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          </p>
        ))}
    </Dialog>
  );
}

/** Network diagnostics, in the person's terms: why there's no Broadlink yet and what to do. */
function NoController({ onScan }: { onScan: () => void }) {
  const { t } = useI18n();
  const x = t.smartHome.ir;
  const runtime = useHomeRuntime();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px]">{x.noController}</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] text-muted">
        {x.checklist.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      {runtime ? (
        <>
          <Button className="self-start" onClick={onScan}>
            <Wifi />
            {x.scan}
          </Button>
          <ManualBroadlink />
        </>
      ) : (
        <p className="text-[13.5px] text-muted">{x.onlyDesktop}</p>
      )}
    </div>
  );
}

type Busy = { key: string; phase: "listening" | "testing" | "confirm" };

function IrButtons({
  device: d,
  ir,
  canLearn,
  onDone,
}: {
  device: HomeDevice;
  ir: IrCapability;
  canLearn: boolean;
  onDone: () => void;
}) {
  const { t, locale } = useI18n();
  const x = t.smartHome.ir;
  const router = useRouter();
  const runtime = useHomeRuntime();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [mode, setMode] = useState<string>("cool");
  const [temp, setTemp] = useState("24");
  const [fan, setFan] = useState("");
  const [custom, setCustom] = useState("");
  const byKey = new Map(ir.commands.map((c) => [c.key, c]));
  const standard = IR_BUTTONS[ir.kind];
  const essential = IR_ESSENTIAL[ir.kind];
  const extra = ir.commands.filter((c) => !standard.includes(c.key));
  const fail = (key: string, text: string) => {
    setBusy(null);
    setError({ key, text });
  };

  /** Sends it once: the person says whether the device reacted. */
  const test = async (key: string) => {
    setError(null);
    setBusy({ key, phase: "testing" });
    const r = await controlDeviceAction(d.id, [{ type: "button", value: key }]);
    if (!r.ok) return fail(key, errorText(t, r.error));
    if (!r.value.every((o) => o.status === "succeeded" || o.status === "pending"))
      return fail(key, x.errors.test);
    setBusy({ key, phase: "confirm" });
  };

  const learn = async (command: Omit<IrCommand, "verified">) => {
    if (!runtime) return;
    setError(null);
    setBusy({ key: command.key, phase: "listening" });
    const r = await runtime
      .learnIr(ir.controllerId, ir.device, command.key)
      .catch(() => ({ ok: false as const, error: "offline" as const }));
    if (!r.ok) return fail(command.key, x.errors[r.error]);
    const saved = await irCommandAction(d.id, {
      op: "save",
      command: { ...command, verified: false },
    });
    if (!saved.ok) return fail(command.key, errorText(t, saved.error));
    router.refresh();
    await test(command.key);
  };

  const verify = async (key: string, worked: boolean) => {
    setBusy(null);
    const r = await irCommandAction(d.id, { op: "verify", key, worked });
    if (!r.ok) return void toast.error(errorText(t, r.error));
    router.refresh();
  };

  const drop = async (key: string) => {
    const r = await irCommandAction(d.id, { op: "delete", key });
    if (!r.ok) return void toast.error(errorText(t, r.error));
    router.refresh();
  };

  const row = (key: string, label: string, preset?: IrCommand["preset"]) => {
    const c = byKey.get(key);
    const b = busy?.key === key ? busy : null;
    return (
      <li key={key} className="flex flex-col gap-2 rounded-2xl border border-border px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px]">{label}</span>
          <span
            className={cn(
              "text-[12.5px]",
              c?.verified ? "text-success" : c ? "text-approval" : "text-faint",
            )}
          >
            {c?.verified ? (
              <span className="flex items-center gap-1">
                <Check className="size-3.5" aria-hidden />
                {x.verified}
              </span>
            ) : c ? (
              x.unverified
            ) : (
              x.notLearned
            )}
          </span>
          {!b && (
            <span className="flex gap-1.5">
              {c && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(busy)}
                  onClick={() => void test(key)}
                >
                  {x.test}
                </Button>
              )}
              {canLearn && (
                <Button
                  size="sm"
                  variant={c ? "ghost" : "secondary"}
                  disabled={Boolean(busy)}
                  onClick={() => void learn({ key, label, ...(preset ? { preset } : {}) })}
                >
                  {c ? x.relearn : x.learn}
                </Button>
              )}
              {c && !standard.includes(key) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(busy)}
                  onClick={() => void drop(key)}
                >
                  {x.remove}
                </Button>
              )}
            </span>
          )}
        </div>
        {b?.phase === "listening" && (
          <p role="status" className="flex items-center gap-2 text-[13.5px] text-accent-text">
            <Loader2 className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />
            {x.listening(label)}
          </p>
        )}
        {b?.phase === "testing" && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
            {x.testing}
          </p>
        )}
        {b?.phase === "confirm" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-[13.5px]">{x.worked}</span>
            <Button size="sm" variant="ghost" onClick={() => void verify(key, false)}>
              {x.no}
            </Button>
            <Button size="sm" onClick={() => void verify(key, true)}>
              {x.yes}
            </Button>
          </div>
        )}
        {error?.key === key && (
          <p role="alert" className="text-[13px] text-danger-text">
            {error.text}
          </p>
        )}
      </li>
    );
  };

  const presetLabel = (p: NonNullable<IrCommand["preset"]>) =>
    [
      hvacLabel(p.hvacMode, locale),
      p.temperature !== undefined ? `${p.temperature} °C` : null,
      p.fanMode ? (x.ac.fans[p.fanMode] ?? p.fanMode) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const draftPreset = {
    hvacMode: mode,
    ...(mode !== "fan_only" && temp ? { temperature: Number(temp) } : {}),
    ...(fan ? { fanMode: fan } : {}),
  };

  return (
    <div className="flex flex-col gap-4">
      {!canLearn && <p className="text-[13.5px] text-muted">{x.learnOnDesktop}</p>}
      {ir.kind !== "ac" && <p className="text-[12.5px] text-faint">{x.toggleNote}</p>}

      <section className="flex flex-col gap-2">
        <h3 className="type-label text-faint">{x.essentials}</h3>
        <ul className="flex flex-col gap-2">
          {essential.map((k) => row(k, x.buttons[k] ?? k))}
          {ir.kind === "ac" &&
            ir.commands.filter((c) => c.preset).map((c) => row(c.key, c.label, c.preset))}
        </ul>
      </section>

      {ir.kind === "ac" && canLearn && (
        <section className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface p-3.5">
          <h3 className="text-[14px]">{x.ac.title}</h3>
          <p className="text-[12.5px] text-muted">{x.ac.hint}</p>
          <div className="grid grid-cols-3 gap-2">
            <Select
              aria-label={x.ac.mode}
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="h-10"
            >
              {AC_MODES.map((m) => (
                <option key={m} value={m}>
                  {hvacLabel(m, locale)}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              aria-label={x.ac.temperature}
              min={16}
              max={30}
              step={0.5}
              value={temp}
              disabled={mode === "fan_only"}
              onChange={(e) => setTemp(e.target.value)}
              className="h-10"
            />
            <Select
              aria-label={x.ac.fan}
              value={fan}
              onChange={(e) => setFan(e.target.value)}
              className="h-10"
            >
              <option value="">{x.ac.fanAny}</option>
              {AC_FANS.map((f) => (
                <option key={f} value={f}>
                  {x.ac.fans[f]}
                </option>
              ))}
            </Select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={
              Boolean(busy) || (mode !== "fan_only" && !(Number(temp) >= 16 && Number(temp) <= 30))
            }
            onClick={() =>
              void learn({
                key: presetKey(draftPreset),
                label: presetLabel(draftPreset).slice(0, 40),
                preset: draftPreset,
              })
            }
          >
            {x.ac.capture}
          </Button>
          {busy && !byKey.has(busy.key) && busy.key.startsWith("preset_") && (
            <ul>{row(busy.key, presetLabel(draftPreset), draftPreset)}</ul>
          )}
          {error && error.key.startsWith("preset_") && !byKey.has(error.key) && (
            <p role="alert" className="text-[13px] text-danger-text">
              {error.text}
            </p>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="type-label text-faint">{x.more}</h3>
        <ul className="flex flex-col gap-2">
          {standard.filter((k) => !essential.includes(k)).map((k) => row(k, x.buttons[k] ?? k))}
          {extra.filter((c) => !c.preset).map((c) => row(c.key, c.label))}
        </ul>
        {canLearn && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const label = custom.trim();
              if (!label) return;
              const slug = label
                .normalize("NFD")
                .replace(/\p{M}/gu, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_|_$/g, "")
                .slice(0, 32);
              setCustom("");
              void learn({
                key: `custom_${slug || Date.now().toString(36)}`,
                label: label.slice(0, 40),
              });
            }}
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="ir-custom">{x.custom.label}</Label>
              <Input
                id="ir-custom"
                value={custom}
                maxLength={40}
                placeholder={x.custom.title}
                onChange={(e) => setCustom(e.target.value)}
                className="h-10"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={Boolean(busy) || !custom.trim()}
            >
              {x.learn}
            </Button>
          </form>
        )}
      </section>

      <Button className="self-end" disabled={busy?.phase === "listening"} onClick={onDone}>
        {x.done}
      </Button>
    </div>
  );
}
