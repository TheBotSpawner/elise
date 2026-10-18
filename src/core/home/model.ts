import { z } from "zod";

/**
 * ELISE Home (ADR-079): the home as part of ELISE's world. Provider-independent: devices,
 * rooms, groups and modes are ELISE's; the physical connection (Home Assistant today, Matter
 * or a native ELISE Hub later) lives behind a provider adapter that never leaks its ids,
 * services or payloads here. Execution is deterministic: the model says what the user wants,
 * this module decides whether the device can do it and with which exact values.
 */

export const HOME_DEVICE_TYPES = [
  "light",
  "switch",
  "climate",
  "fan",
  "humidifier",
  "media_player",
  "sensor",
] as const;
export type HomeDeviceType = (typeof HOME_DEVICE_TYPES)[number];

/** What a device can do, in ELISE's terms (never a provider service name). */
export const homeCapabilitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("power") }),
  /** Percent, 0–100. */
  z.object({ type: z.literal("brightness") }),
  z.object({ type: z.literal("color") }),
  /** Kelvin range. */
  z.object({
    type: z.literal("color_temp"),
    min: z.number().int().min(1000),
    max: z.number().int().max(12000),
  }),
  /** Target temperature (°C) the device accepts. */
  z.object({
    type: z.literal("temperature"),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().default(0.5),
  }),
  z.object({ type: z.literal("hvac_mode"), modes: z.array(z.string().max(30)).max(12) }),
  z.object({ type: z.literal("fan_mode"), modes: z.array(z.string().max(30)).max(12) }),
  /** Percent, 0–100. */
  z.object({ type: z.literal("fan_speed") }),
  z.object({ type: z.literal("humidity"), min: z.number(), max: z.number() }),
  /** Percent, 0–100. */
  z.object({ type: z.literal("volume") }),
  /** Play / pause / next / previous. */
  z.object({ type: z.literal("media") }),
  z.object({ type: z.literal("source"), sources: z.array(z.string().max(80)).max(40) }),
]);
export type HomeCapability = z.infer<typeof homeCapabilitySchema>;
export type HomeCapabilityType = HomeCapability["type"];

/** The normalized state ELISE caches (with freshness): never the provider's raw object. */
export const homeStateSchema = z
  .object({
    on: z.boolean().optional(),
    brightness: z.number().min(0).max(100).optional(),
    color: z
      .object({ r: z.number().int(), g: z.number().int(), b: z.number().int() })
      .nullable()
      .optional(),
    colorTemp: z.number().optional(),
    currentTemperature: z.number().optional(),
    targetTemperature: z.number().optional(),
    hvacMode: z.string().max(30).optional(),
    fanMode: z.string().max(30).optional(),
    fanSpeed: z.number().min(0).max(100).optional(),
    humidity: z.number().optional(),
    targetHumidity: z.number().optional(),
    volume: z.number().min(0).max(100).optional(),
    playing: z.boolean().optional(),
    source: z.string().max(80).optional(),
    /** Sensors: the reading and its unit. */
    reading: z
      .object({
        value: z.union([z.number(), z.string().max(60)]),
        unit: z.string().max(12).optional(),
      })
      .optional(),
    quantity: z.string().max(30).optional(),
    /** Every useful reading of a sensor device (temperature and humidity of one sensor). */
    readings: z
      .array(
        z.object({
          quantity: z.string().max(30),
          value: z.union([z.number(), z.string().max(60)]),
          unit: z.string().max(12).optional(),
        }),
      )
      .max(6)
      .optional(),
  })
  .strict();
export type HomeState = z.infer<typeof homeStateSchema>;

export interface HomeRoom {
  id: string;
  name: string;
  aliases: string[];
  icon: string | null;
  favorite: boolean;
}

export interface HomeDevice {
  id: string;
  name: string;
  aliases: string[];
  roomId: string | null;
  type: HomeDeviceType;
  capabilities: HomeCapability[];
  state: HomeState;
  available: boolean;
  stateUpdatedAt: string | null;
  favorite: boolean;
}

export interface HomeGroup {
  id: string;
  name: string;
  aliases: string[];
  deviceIds: string[];
}

/** What the model may ask for: a type and a value, absolute or relative ("más tenue"). */
export const HOME_ACTION_TYPES = [
  "power",
  "brightness",
  "color",
  "color_temp",
  "temperature",
  "hvac_mode",
  "fan_mode",
  "fan_speed",
  "humidity",
  "volume",
  "media",
  "source",
] as const;
export type HomeActionType = (typeof HOME_ACTION_TYPES)[number];

export const homeActionInputSchema = z
  .object({
    type: z.enum(HOME_ACTION_TYPES),
    /**
     * power: true/false · brightness, fan_speed, volume: 0–100 · temperature: °C · humidity: % ·
     * color: a name ("verde", "warm white") or #RRGGBB · color_temp: kelvin, or "warm" / "neutral"
     * / "cool" · hvac_mode, fan_mode, source: one of the device's own · media: play / pause /
     * next / previous.
     */
    value: z.union([z.boolean(), z.number(), z.string().trim().min(1).max(40)]),
    /** true: value is a change ("+10", "-2"), applied to the current state and clamped. */
    relative: z.boolean().optional(),
  })
  .strict();
export type HomeActionInput = z.infer<typeof homeActionInputSchema>;

/** An action ELISE validated against the device: exact, in range, supported. */
export type HomeAction =
  | { type: "power"; on: boolean }
  | { type: "brightness"; value: number }
  | { type: "color"; rgb: { r: number; g: number; b: number } }
  | { type: "color_temp"; kelvin: number }
  | { type: "temperature"; value: number }
  | { type: "hvac_mode"; mode: string }
  | { type: "fan_mode"; mode: string }
  | { type: "fan_speed"; value: number }
  | { type: "humidity"; value: number }
  | { type: "volume"; value: number }
  | { type: "media"; command: "play" | "pause" | "next" | "previous" }
  | { type: "source"; source: string };

export const homeActionSchema: z.ZodType<HomeAction> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("power"), on: z.boolean() }),
  z.object({ type: z.literal("brightness"), value: z.number().min(0).max(100) }),
  z.object({
    type: z.literal("color"),
    rgb: z.object({
      r: z.number().int().min(0).max(255),
      g: z.number().int().min(0).max(255),
      b: z.number().int().min(0).max(255),
    }),
  }),
  z.object({ type: z.literal("color_temp"), kelvin: z.number().int().min(1000).max(12000) }),
  z.object({ type: z.literal("temperature"), value: z.number().min(5).max(40) }),
  z.object({ type: z.literal("hvac_mode"), mode: z.string().min(1).max(30) }),
  z.object({ type: z.literal("fan_mode"), mode: z.string().min(1).max(30) }),
  z.object({ type: z.literal("fan_speed"), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal("humidity"), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal("volume"), value: z.number().min(0).max(100) }),
  z.object({ type: z.literal("media"), command: z.enum(["play", "pause", "next", "previous"]) }),
  z.object({ type: z.literal("source"), source: z.string().min(1).max(80) }),
]);

export type HomeValidation =
  | { ok: true; action: HomeAction }
  | { ok: false; code: "unsupported" | "out_of_range" | "bad_value"; message: string };

const has = <T extends HomeCapabilityType>(d: Pick<HomeDevice, "capabilities">, t: T) =>
  d.capabilities.find((c): c is Extract<HomeCapability, { type: T }> => c.type === t);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Colors by name (es/en), for "poné la luz en verde". */
export const COLORS: Record<string, { r: number; g: number; b: number }> = {
  rojo: { r: 255, g: 0, b: 0 },
  red: { r: 255, g: 0, b: 0 },
  verde: { r: 0, g: 255, b: 0 },
  green: { r: 0, g: 255, b: 0 },
  azul: { r: 0, g: 0, b: 255 },
  blue: { r: 0, g: 0, b: 255 },
  amarillo: { r: 255, g: 220, b: 0 },
  yellow: { r: 255, g: 220, b: 0 },
  naranja: { r: 255, g: 120, b: 0 },
  orange: { r: 255, g: 120, b: 0 },
  violeta: { r: 140, g: 0, b: 255 },
  morado: { r: 140, g: 0, b: 255 },
  purple: { r: 140, g: 0, b: 255 },
  rosa: { r: 255, g: 80, b: 160 },
  pink: { r: 255, g: 80, b: 160 },
  celeste: { r: 80, g: 200, b: 255 },
  cian: { r: 0, g: 255, b: 255 },
  cyan: { r: 0, g: 255, b: 255 },
  turquesa: { r: 0, g: 210, b: 180 },
  blanco: { r: 255, g: 255, b: 255 },
  white: { r: 255, g: 255, b: 255 },
};

const WARMTH: Record<string, number> = {
  warm: 2700,
  calida: 2700,
  calido: 2700,
  neutral: 4000,
  neutro: 4000,
  cool: 6000,
  fria: 6000,
  frio: 6000,
};

const num = (v: HomeActionInput["value"]) =>
  typeof v === "number"
    ? v
    : typeof v === "string" && /^[-+]?\d+(\.\d+)?$/.test(v)
      ? Number(v)
      : NaN;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const step = (n: number, s: number) => Math.round(n / s) * s;

function percent(
  type: "brightness" | "fan_speed" | "volume",
  input: HomeActionInput,
  current: number | undefined,
): HomeValidation {
  const v = num(input.value);
  if (!Number.isFinite(v)) return bad(`${type} needs a number`);
  if (input.relative) {
    const base = current ?? (type === "brightness" ? 100 : 50);
    return { ok: true, action: { type, value: Math.round(clamp(base + v, 0, 100)) } };
  }
  if (v < 0 || v > 100) return range(`${type} is 0–100%`);
  return { ok: true, action: { type, value: Math.round(v) } };
}

const bad = (message: string): HomeValidation => ({ ok: false, code: "bad_value", message });
const range = (message: string): HomeValidation => ({ ok: false, code: "out_of_range", message });
const unsupported = (d: Pick<HomeDevice, "name">, what: string): HomeValidation => ({
  ok: false,
  code: "unsupported",
  message: `${d.name} can't change ${what}`,
});

/**
 * One requested action → the exact action for this device, or why not. Absolute values out of
 * the device's range fail (never silently changed); relative ones apply to the current state
 * and are clamped to the range. A mode is changed only when asked for.
 */
export function validateAction(
  device: Pick<HomeDevice, "name" | "capabilities" | "state">,
  input: HomeActionInput,
): HomeValidation {
  const s = device.state;
  switch (input.type) {
    case "power": {
      if (!has(device, "power")) return unsupported(device, "power");
      const v = input.value;
      const on =
        v === true || v === 1 || (typeof v === "string" && /^(on|true|encend|prend|1)/i.test(v));
      const off =
        v === false || v === 0 || (typeof v === "string" && /^(off|false|apag|0)/i.test(v));
      if (!on && !off) return bad("power is on or off");
      return { ok: true, action: { type: "power", on } };
    }
    case "brightness":
      if (!has(device, "brightness")) return unsupported(device, "brightness");
      return percent("brightness", input, s.brightness);
    case "fan_speed":
      if (!has(device, "fan_speed")) return unsupported(device, "speed");
      return percent("fan_speed", input, s.fanSpeed);
    case "volume":
      if (!has(device, "volume")) return unsupported(device, "volume");
      return percent("volume", input, s.volume);
    case "color": {
      if (!has(device, "color")) return unsupported(device, "color");
      const v = typeof input.value === "string" ? fold(input.value) : "";
      const hex = /^#?([0-9a-f]{6})$/.exec(v)?.[1];
      const rgb = hex
        ? {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
          }
        : COLORS[v];
      if (!rgb) return bad(`unknown color "${input.value}"`);
      return { ok: true, action: { type: "color", rgb } };
    }
    case "color_temp": {
      const cap = has(device, "color_temp");
      if (!cap) return unsupported(device, "white tone");
      const named = typeof input.value === "string" ? WARMTH[fold(input.value)] : undefined;
      const v = named ?? num(input.value);
      if (!Number.isFinite(v)) return bad("color_temp is kelvin or warm/neutral/cool");
      const k = input.relative && !named ? (s.colorTemp ?? 4000) + v : v;
      if (named || input.relative)
        return {
          ok: true,
          action: { type: "color_temp", kelvin: Math.round(clamp(k, cap.min, cap.max)) },
        };
      if (k < cap.min || k > cap.max) return range(`white tone is ${cap.min}–${cap.max} K`);
      return { ok: true, action: { type: "color_temp", kelvin: Math.round(k) } };
    }
    case "temperature": {
      const cap = has(device, "temperature");
      if (!cap) return unsupported(device, "temperature");
      const v = num(input.value);
      if (!Number.isFinite(v)) return bad("temperature needs a number");
      if (input.relative) {
        const base = s.targetTemperature ?? s.currentTemperature;
        if (base === undefined) return bad("the current target temperature is unknown");
        return {
          ok: true,
          action: { type: "temperature", value: step(clamp(base + v, cap.min, cap.max), cap.step) },
        };
      }
      if (v < cap.min || v > cap.max)
        return range(`${device.name} accepts ${cap.min}–${cap.max} °C`);
      return { ok: true, action: { type: "temperature", value: step(v, cap.step) } };
    }
    case "humidity": {
      const cap = has(device, "humidity");
      if (!cap) return unsupported(device, "humidity");
      const v = num(input.value);
      if (!Number.isFinite(v)) return bad("humidity needs a number");
      if (input.relative) {
        const base = s.targetHumidity ?? 50;
        return {
          ok: true,
          action: { type: "humidity", value: Math.round(clamp(base + v, cap.min, cap.max)) },
        };
      }
      if (v < cap.min || v > cap.max) return range(`${device.name} accepts ${cap.min}–${cap.max}%`);
      return { ok: true, action: { type: "humidity", value: Math.round(v) } };
    }
    case "hvac_mode":
    case "fan_mode": {
      const cap = has(device, input.type);
      if (!cap) return unsupported(device, input.type === "hvac_mode" ? "mode" : "fan mode");
      const want = fold(String(input.value));
      const mode = cap.modes.find((m) => fold(m) === want) ?? HVAC_WORDS[want];
      if (!mode || !cap.modes.includes(mode))
        return bad(`${device.name} modes: ${cap.modes.join(", ")}`);
      return input.type === "hvac_mode"
        ? { ok: true, action: { type: "hvac_mode", mode } }
        : { ok: true, action: { type: "fan_mode", mode } };
    }
    case "media": {
      if (!has(device, "media")) return unsupported(device, "playback");
      const v = fold(String(input.value));
      const command = /^(play|reproduc|seguir|resume)/.test(v)
        ? "play"
        : /^(pause|paus|stop|deten|para)/.test(v)
          ? "pause"
          : /^(next|siguiente)/.test(v)
            ? "next"
            : /^(prev|anterior)/.test(v)
              ? "previous"
              : null;
      if (!command) return bad("media is play, pause, next or previous");
      return { ok: true, action: { type: "media", command } };
    }
    case "source": {
      const cap = has(device, "source");
      if (!cap) return unsupported(device, "source");
      const want = fold(String(input.value));
      const source =
        cap.sources.find((x) => fold(x) === want) ??
        cap.sources.find((x) => fold(x).includes(want));
      if (!source) return bad(`${device.name} sources: ${cap.sources.slice(0, 12).join(", ")}`);
      return { ok: true, action: { type: "source", source } };
    }
  }
}

/** Spanish words for climate modes, mapped to the provider-independent names devices report. */
const HVAC_WORDS: Record<string, string> = {
  frio: "cool",
  calor: "heat",
  auto: "auto",
  automatico: "auto",
  ventilacion: "fan_only",
  ventilar: "fan_only",
  seco: "dry",
  deshumidificar: "dry",
  apagado: "off",
};

/**
 * Broad commands ("apagá todo el living", "apagá todo") only touch low-risk classes. Locks,
 * alarms, garage doors and anything not modeled here are never part of a broad action — they
 * aren't controllable at all in this version.
 */
export const BROAD_SAFE_TYPES: readonly HomeDeviceType[] = [
  "light",
  "switch",
  "fan",
  "media_player",
  "humidifier",
];

/** The devices a broad action applies to: compatible and low-risk (climate only if named). */
export function broadTargets(
  devices: readonly HomeDevice[],
  actionTypes: readonly HomeActionType[],
  options: { includeClimate?: boolean; type?: HomeDeviceType } = {},
): HomeDevice[] {
  return devices.filter(
    (d) =>
      (options.type ? d.type === options.type : true) &&
      (BROAD_SAFE_TYPES.includes(d.type) || (d.type === "climate" && options.includeClimate)) &&
      actionTypes.every((t) => d.capabilities.some((c) => capabilityFor(t) === c.type)),
  );
}

const capabilityFor = (t: HomeActionType): HomeCapabilityType =>
  t === "media" ? "media" : (t as HomeCapabilityType);

/** One line of state, for the model and compact surfaces ("Encendida · 30%"). */
export function describeState(d: HomeDevice, locale: "es" | "en"): string {
  const es = locale === "es";
  const s = d.state;
  if (!d.available) return es ? "No responde" : "Not responding";
  const parts: string[] = [];
  if (d.type === "sensor" && s.reading)
    return `${s.reading.value}${s.reading.unit ? ` ${s.reading.unit}` : ""}`;
  if (s.on !== undefined)
    parts.push(
      s.on
        ? es
          ? d.type === "light"
            ? "Encendida"
            : "Encendido"
          : "On"
        : es
          ? d.type === "light"
            ? "Apagada"
            : "Apagado"
          : "Off",
    );
  if (s.on !== false) {
    if (s.brightness !== undefined && d.type === "light")
      parts.push(`${Math.round(s.brightness)}%`);
    if (s.targetTemperature !== undefined) parts.push(`${s.targetTemperature} °C`);
    if (s.hvacMode && s.hvacMode !== "off") parts.push(hvacLabel(s.hvacMode, locale));
    if (s.targetHumidity !== undefined) parts.push(`${Math.round(s.targetHumidity)}%`);
    if (s.fanSpeed !== undefined && d.type === "fan") parts.push(`${Math.round(s.fanSpeed)}%`);
    if (s.playing !== undefined)
      parts.push(s.playing ? (es ? "Reproduciendo" : "Playing") : es ? "En pausa" : "Paused");
  }
  if (s.currentTemperature !== undefined && d.type === "climate")
    parts.push(es ? `${s.currentTemperature} °C actual` : `${s.currentTemperature} °C now`);
  return parts.join(" · ") || "—";
}

export function hvacLabel(mode: string, locale: "es" | "en"): string {
  const es: Record<string, string> = {
    cool: "Frío",
    heat: "Calor",
    auto: "Automático",
    heat_cool: "Frío/Calor",
    dry: "Seco",
    fan_only: "Ventilación",
    off: "Apagado",
  };
  return locale === "es" ? (es[mode] ?? mode) : mode.replace(/_/g, " ");
}

/** The state an action leads to (optimistic, until the hub reports the real one). */
export function applyAction(state: HomeState, a: HomeAction): HomeState {
  switch (a.type) {
    case "power":
      return { ...state, on: a.on };
    case "brightness":
      return { ...state, brightness: a.value, on: a.value > 0 };
    case "color":
      return { ...state, color: a.rgb, on: true };
    case "color_temp":
      return { ...state, colorTemp: a.kelvin, on: true };
    case "temperature":
      return { ...state, targetTemperature: a.value };
    case "hvac_mode":
      return { ...state, hvacMode: a.mode, on: a.mode !== "off" };
    case "fan_mode":
      return { ...state, fanMode: a.mode };
    case "fan_speed":
      return { ...state, fanSpeed: a.value, on: a.value > 0 };
    case "humidity":
      return { ...state, targetHumidity: a.value };
    case "volume":
      return { ...state, volume: a.value };
    case "media":
      return a.command === "play" || a.command === "pause"
        ? { ...state, playing: a.command === "play" }
        : state;
    case "source":
      return { ...state, source: a.source };
  }
}

// ── Commands and the hub (the provider-independent protocol) ─────────────────

/** Version of the ELISE ↔ Hub protocol; the agent reports its own. */
export const HOME_PROTOCOL_VERSION = 1;

/** A physical command lives this long: "prendé la luz" never runs hours later. */
export const HOME_COMMAND_TTL_MS = 30_000;

/** A hub silent for longer than this is offline (heartbeats every ~20 s). */
export const HUB_OFFLINE_AFTER_MS = 75_000;

export type HubStatus = "online" | "degraded" | "offline";

export function hubStatus(
  hub: { lastSeenAt: string | null; providerConnected: boolean } | null,
  now: Date,
): HubStatus {
  if (!hub?.lastSeenAt) return "offline";
  if (now.getTime() - Date.parse(hub.lastSeenAt) > HUB_OFFLINE_AFTER_MS) return "offline";
  return hub.providerConnected ? "online" : "degraded";
}

/** The oldest hub protocol this ELISE still speaks; an older hub must update. */
export const MIN_HUB_PROTOCOL_VERSION = 1;

/**
 * What the person sees about their home's hub (ADR-080), derived only from the hub's
 * authenticated presence — never from guessing what's installed on a computer.
 */
export type HomeSetupState =
  | "desktop_not_configured"
  | "desktop_offline"
  | "desktop_update_required"
  | "desktop_online"
  | "hub_initializing"
  | "hub_error"
  | "hub_ready";

export interface HubPresence {
  lastSeenAt: string | null;
  providerConnected: boolean;
  runtimeState: "initializing" | "ready" | "error";
  protocolVersion: number | null;
  lastSyncAt: string | null;
}

export function homeSetupState(hub: HubPresence | null, now: Date): HomeSetupState {
  if (!hub) return "desktop_not_configured";
  if (hubStatus(hub, now) === "offline") return "desktop_offline";
  if (hub.protocolVersion !== null && hub.protocolVersion < MIN_HUB_PROTOCOL_VERSION)
    return "desktop_update_required";
  if (hub.runtimeState === "error") return "hub_error";
  if (hub.runtimeState === "initializing") return "hub_initializing";
  if (!hub.providerConnected) return "hub_error";
  return hub.lastSyncAt ? "hub_ready" : "desktop_online";
}

export type HomeCommandStatus =
  "queued" | "delivered" | "executing" | "succeeded" | "failed" | "expired" | "cancelled";

/** What the hub receives: a device and the actions to apply, in order. */
export const hubCommandSchema = z
  .object({
    id: z.uuid(),
    deviceId: z.uuid(),
    /** Provider identifiers for this device (only the hub understands them). */
    target: z.object({
      providerKey: z.string().min(1).max(300),
      entityIds: z.array(z.string().max(255)).max(30),
    }),
    actions: z.array(homeActionSchema).min(1).max(8),
    expiresAt: z.string(),
  })
  .strict();
export type HubCommand = z.infer<typeof hubCommandSchema>;

export interface HomeCommandOutcome {
  deviceId: string;
  name: string;
  status: "succeeded" | "failed" | "expired" | "offline" | "unavailable" | "pending";
  error?: string;
  state?: HomeState;
}

/** A mode ("Modo Estudio"): typed actions per device — never a natural-language prompt. */
export const homeSceneActionSchema = z
  .object({ deviceId: z.uuid(), actions: z.array(homeActionInputSchema).min(1).max(8) })
  .strict();
export type HomeSceneAction = z.infer<typeof homeSceneActionSchema>;

export interface HomeScene {
  id: string;
  name: string;
  icon: string | null;
  aliases: string[];
  favorite: boolean;
  actions: HomeSceneAction[];
}

export interface HomeSnapshot {
  /** Null until a home exists (no hub paired yet). */
  home: { id: string; name: string } | null;
  hub: {
    id: string;
    name: string;
    status: HubStatus;
    setup: HomeSetupState;
    lastSeenAt: string | null;
    lastSyncAt: string | null;
  } | null;
  rooms: HomeRoom[];
  devices: HomeDevice[];
  groups: HomeGroup[];
  scenes: HomeScene[];
}

/** What ELISE's tools use (implemented in the application layer). */
export interface HomePort {
  snapshot(): Promise<HomeSnapshot>;
  /** Validated actions per device → dispatched to the hub; waits briefly for the results. */
  execute(commands: { deviceId: string; actions: HomeAction[] }[]): Promise<HomeCommandOutcome[]>;
  saveScene(scene: Omit<HomeScene, "id" | "favorite"> & { id?: string }): Promise<HomeScene>;
  deleteScene(id: string): Promise<void>;
}
