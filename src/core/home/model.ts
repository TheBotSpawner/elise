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
  /** ADR-110: an infrared blaster (Broadlink): it controls other devices, not itself. */
  "ir_controller",
] as const;
export type HomeDeviceType = (typeof HOME_DEVICE_TYPES)[number];

/** ADR-110: one button an infrared device's controller learned from the person's remote. */
/** A Broadlink infrared code (base64), bounded. */
export const IR_CODE = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .min(8)
  .max(2400);

export const irCommandSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{1,40}$/),
    label: z.string().trim().min(1).max(40),
    /** The person confirmed the device reacted ("Funcionó"). */
    verified: z.boolean(),
    /**
     * An air conditioner's remote sends its whole state with each press: the state this captured
     * press sets.
     */
    preset: z
      .object({
        hvacMode: z.string().min(1).max(30),
        temperature: z.number().min(10).max(35).optional(),
        fanMode: z.string().min(1).max(30).optional(),
      })
      .strict()
      .optional(),
    /**
     * ADR-117: the infrared code itself (Broadlink base64), when it comes from a verified-source
     * profile instead of being learned into the controller. Set by ELISE only, never the client.
     */
    code: IR_CODE.optional(),
  })
  .strict();

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
  /** Opens one of HOME_APPS on a TV ("abrí YouTube en la tele"). */
  z.object({ type: z.literal("app") }),
  /** ADR-110: an infrared controller that can learn and send codes. */
  z.object({ type: z.literal("ir_blaster") }),
  /** ADR-110: a device controlled by infrared, through one of the home's controllers. */
  z
    .object({
      type: z.literal("ir"),
      controllerId: z.uuid(),
      /** The name the codes are stored under in the controller (irDeviceName). */
      device: z.string().regex(/^elise_[0-9a-f]{12}$/),
      kind: z.enum(["tv", "ac", "fan", "other"]),
      commands: z.array(irCommandSchema).max(60),
      /** ADR-117: the brand/model profile its codes came from (SmartIR, MIT). */
      profile: z
        .object({
          source: z.literal("smartir"),
          code: z.number().int().min(1).max(99_999),
          manufacturer: z.string().max(60),
          models: z.string().max(200),
        })
        .strict()
        .optional(),
    })
    .strict(),
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
    /** ADR-110: infrared has no feedback — this state is what ELISE last sent, not a reading. */
    estimated: z.boolean().optional(),
    lastSent: z
      .object({ command: z.string().max(40), at: z.string().max(40) })
      .strict()
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
  "app",
  "button",
] as const;
export type HomeActionType = (typeof HOME_ACTION_TYPES)[number];

export const homeActionInputSchema = z
  .object({
    type: z.enum(HOME_ACTION_TYPES),
    /**
     * power: true/false · brightness, fan_speed, volume: 0–100 · temperature: °C · humidity: % ·
     * color: a name ("verde", "warm white") or #RRGGBB · color_temp: kelvin, or "warm" / "neutral"
     * / "cool" · hvac_mode, fan_mode, source: one of the device's own · media: play / pause /
     * next / previous · app: an app to open on a TV ("youtube", "netflix") · button: an
     * infrared device's learned button, by its name ("mute", "Canal +").
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
  | { type: "source"; source: string }
  | { type: "app"; app: HomeApp }
  /** ADR-110: one learned infrared code, sent by the device's controller. */
  | { type: "ir"; device: string; command: string; repeats: number; code?: string }
  /** Takes the device out of the home (the person's "Quitar"); never chosen by the model. */
  | { type: "remove" };

/** Apps ELISE can open on a TV, by the words people use for them. */
export const HOME_APPS = {
  youtube: ["youtube", "yt"],
  netflix: ["netflix"],
  prime_video: ["prime video", "prime", "amazon prime", "amazon"],
  disney_plus: ["disney", "disney plus", "disney+"],
  max: ["max", "hbo", "hbo max"],
} as const;
export type HomeApp = keyof typeof HOME_APPS;
const appOf = (said: string) =>
  (Object.keys(HOME_APPS) as HomeApp[]).find((k) =>
    HOME_APPS[k].some((w) => fold(said) === w || fold(said) === `la app de ${w}`),
  );

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
  z.object({
    type: z.literal("app"),
    app: z.enum(Object.keys(HOME_APPS) as [HomeApp, ...HomeApp[]]),
  }),
  z.object({
    type: z.literal("ir"),
    device: z.string().regex(/^elise_[0-9a-f]{12}$/),
    command: z.string().regex(/^[a-z0-9_]{1,40}$/),
    repeats: z.number().int().min(1).max(10),
    /** ADR-117: a profile's code, sent as is (otherwise the code learned under `command`). */
    code: IR_CODE.optional(),
  }),
  z.object({ type: z.literal("remove") }),
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
  const ir = has(device, "ir");
  if (ir) return validateIr(device, ir, input);
  switch (input.type) {
    case "power": {
      if (!has(device, "power")) return unsupported(device, "power");
      const on = powerOf(input.value);
      if (on === null) return bad("power is on or off");
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
    case "app": {
      const said = String(input.value);
      // A TV that lists the app among its own sources opens it that way.
      const listed = has(device, "source")?.sources.find((x) => fold(x) === fold(said));
      if (listed) return { ok: true, action: { type: "source", source: listed } };
      if (!has(device, "app")) return unsupported(device, "opening apps");
      const app = appOf(said);
      if (!app) return bad(`apps ELISE can open: ${Object.keys(HOME_APPS).join(", ")}`);
      return { ok: true, action: { type: "app", app } };
    }
    case "button":
      return unsupported(device, "buttons");
  }
}

const powerOf = (v: HomeActionInput["value"]) =>
  v === true || v === 1 || (typeof v === "string" && /^(on|true|encend|prend|1)/i.test(v))
    ? true
    : v === false || v === 0 || (typeof v === "string" && /^(off|false|apag|0)/i.test(v))
      ? false
      : null;

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
  // ADR-110: infrared can't be read back — what ELISE last sent, said as such.
  if (s.estimated && parts.length) parts.push(es ? "estimado" : "estimated");
  const ir = has(d, "ir");
  if (ir && !parts.length && s.lastSent) {
    const label = ir.commands.find((c) => c.key === s.lastSent!.command)?.label;
    if (label) return es ? `Último botón: ${label}` : `Last button: ${label}`;
  }
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
    case "app":
      return { ...state, on: true };
    case "ir":
    case "remove":
      return state;
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
  /** The person's devices: the only ones ELISE lists, controls or puts in modes. */
  devices: HomeDevice[];
  /** ADR-103: found on the network by the engine, waiting for the person's "Agregar". */
  found?: HomeDevice[];
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

// ── Infrared (ADR-110) ───────────────────────────────────────────────────────

export type IrCapability = Extract<HomeCapability, { type: "ir" }>;
export type IrCommand = IrCapability["commands"][number];
export type IrKind = IrCapability["kind"];

/** The name an infrared device's codes are stored under in its controller (regex-safe). */
export const irDeviceName = (deviceId: string) =>
  `elise_${deviceId.replace(/-/g, "").slice(0, 12).toLowerCase()}`;

/** The buttons ELISE knows by meaning, per kind; anything else is a named custom button. */
export const IR_BUTTONS: Record<IrKind, readonly string[]> = {
  tv: [
    "power_toggle",
    "power_on",
    "power_off",
    "volume_up",
    "volume_down",
    "mute",
    "channel_up",
    "channel_down",
    "input",
  ],
  ac: ["power_off", "power_on"],
  fan: ["power_toggle", "power_on", "power_off", "speed_up", "speed_down", "oscillate"],
  other: ["power_toggle", "power_on", "power_off"],
};

/** What a guided setup asks for first (an air conditioner also needs one captured setting). */
export const IR_ESSENTIAL: Record<IrKind, readonly string[]> = {
  tv: ["power_toggle", "volume_up", "volume_down", "mute"],
  ac: ["power_off"],
  fan: ["power_toggle"],
  other: [],
};

/** "preset_cool_24", "preset_heat_22_5_low": one key per captured air conditioner state. */
export function presetKey(p: NonNullable<IrCommand["preset"]>): string {
  const slug = (s: string) =>
    fold(s)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
  return [
    "preset",
    slug(p.hvacMode),
    ...(p.temperature !== undefined ? [String(p.temperature).replace(".", "_")] : []),
    ...(p.fanMode ? [slug(p.fanMode)] : []),
  ]
    .join("_")
    .slice(0, 40);
}

/** Usable: at least one button the person confirmed works. */
export const irReady = (ir: IrCapability) => ir.commands.some((c) => c.verified);

/**
 * Infrared, honestly. There is no feedback: ELISE only knows what it sent. So it never promises
 * a state it can't produce: a single power button that toggles is not "off", volume moves only
 * by steps, and an air conditioner takes only the settings the person captured from its remote.
 */
function validateIr(
  d: Pick<HomeDevice, "name" | "state">,
  ir: IrCapability,
  input: HomeActionInput,
): HomeValidation {
  const s = d.state;
  const find = (key: string) => ir.commands.find((c) => c.key === key);
  const send = (command: string, repeats = 1): HomeValidation => {
    const code = ir.commands.find((c) => c.key === command)?.code;
    return {
      ok: true,
      action: { type: "ir", device: ir.device, command, repeats, ...(code ? { code } : {}) },
    };
  };
  const presets = ir.commands.filter((c) => c.preset);
  const named = (list: readonly IrCommand[]) => list.map((c) => c.label).join(", ") || "none";
  const no = (message: string): HomeValidation => ({ ok: false, code: "unsupported", message });
  // The captured state closest to what ELISE last set (same mode, then same temperature).
  const closest = (list: IrCommand[]) =>
    list.find(
      (c) => c.preset!.hvacMode === s.hvacMode && c.preset!.temperature === s.targetTemperature,
    ) ??
    list.find((c) => c.preset!.hvacMode === s.hvacMode) ??
    list[0];
  switch (input.type) {
    case "button": {
      const want = fold(String(input.value));
      const c =
        ir.commands.find((x) => x.key === want || fold(x.label) === want) ??
        ir.commands.find((x) => fold(x.label).includes(want));
      return c ? send(c.key) : bad(`${d.name}'s buttons: ${named(ir.commands)}`);
    }
    case "power": {
      const on = powerOf(input.value);
      if (on === null) return bad("power is on or off");
      if (find(on ? "power_on" : "power_off")) return send(on ? "power_on" : "power_off");
      if (on && presets.length) {
        const p = closest(presets)!;
        if (presets.length === 1 || p.preset!.hvacMode === s.hvacMode) return send(p.key);
        return no(`${d.name} turns on with one of its settings: ${named(presets)}. Ask which.`);
      }
      if (find("power_toggle"))
        return no(
          `${d.name} has a single power button that toggles, and ELISE can't see whether it's on, so it can't promise "${on ? "on" : "off"}". Press it (action button "power_toggle") only if the person confirms.`,
        );
      return unsupported(d, "power");
    }
    case "volume": {
      const v = num(input.value);
      if (!input.relative || !Number.isFinite(v) || v === 0)
        return no(`${d.name} only steps its volume up or down (infrared): use a relative change`);
      const key = v > 0 ? "volume_up" : "volume_down";
      if (!find(key)) return unsupported(d, "volume");
      return send(key, clamp(Math.round(Math.abs(v) / 5), 1, 10));
    }
    case "media": {
      const v = fold(String(input.value));
      const key = /^(play|reproduc)/.test(v)
        ? "play"
        : /^(pause|paus)/.test(v)
          ? "pause"
          : /^(next|siguiente)/.test(v)
            ? "next"
            : /^(prev|anterior)/.test(v)
              ? "previous"
              : "";
      return find(key) ? send(key) : unsupported(d, "playback");
    }
    case "fan_speed": {
      const v = num(input.value);
      const key = v > 0 ? "speed_up" : "speed_down";
      if (!input.relative || !Number.isFinite(v) || v === 0 || !find(key))
        return no(`${d.name} only steps its speed up or down, when those buttons were learned`);
      return send(key);
    }
    case "temperature": {
      if (!presets.length) return unsupported(d, "temperature");
      const v = num(input.value);
      if (!Number.isFinite(v)) return bad("temperature needs a number");
      const target = input.relative ? (s.targetTemperature ?? NaN) + v : v;
      if (!Number.isFinite(target))
        return no(`${d.name}'s current temperature is unknown: ask for an exact one`);
      const c = closest(presets.filter((x) => x.preset!.temperature === target));
      return c
        ? send(c.key)
        : no(
            `${d.name} only has these settings captured from its remote: ${named(presets)}. ${target} °C isn't one; the person can add it in Hogar.`,
          );
    }
    case "hvac_mode":
    case "fan_mode": {
      if (!presets.length) return unsupported(d, "mode");
      const want = fold(String(input.value));
      const mode = HVAC_WORDS[want] ?? want;
      if (input.type === "hvac_mode" && mode === "off")
        return find("power_off") ? send("power_off") : unsupported(d, "power");
      const match = presets.filter((x) =>
        input.type === "hvac_mode"
          ? fold(x.preset!.hvacMode) === mode
          : fold(x.preset!.fanMode ?? "") === want,
      );
      const c = match.find((x) => x.preset!.temperature === s.targetTemperature) ?? closest(match);
      return c ? send(c.key) : no(`${d.name}'s captured settings: ${named(presets)}`);
    }
    default:
      return unsupported(d, input.type.replace("_", " "));
  }
}

/** What an infrared device is now believed to be after ELISE sent this (never a reading). */
export function estimateIr(
  state: HomeState,
  ir: IrCapability,
  action: Extract<HomeAction, { type: "ir" }>,
  at: string,
): HomeState {
  const next: HomeState = { ...state, estimated: true, lastSent: { command: action.command, at } };
  const preset = ir.commands.find((c) => c.key === action.command)?.preset;
  if (action.command === "power_on") next.on = true;
  else if (action.command === "power_off") next.on = false;
  // A toggle: on or off, ELISE can't know which.
  else if (action.command === "power_toggle") delete next.on;
  else if (preset) {
    next.on = true;
    next.hvacMode = preset.hvacMode;
    if (preset.temperature !== undefined) next.targetTemperature = preset.temperature;
    if (preset.fanMode) next.fanMode = preset.fanMode;
  }
  return next;
}
