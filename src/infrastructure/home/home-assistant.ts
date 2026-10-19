import type {
  HomeAction,
  HomeApp,
  HomeCapability,
  HomeDeviceType,
  HomeState,
} from "@/core/home/model";

/**
 * Home Assistant as ELISE Home's first provider (ADR-079): pure translation, no I/O, shared by
 * the app (tests) and the local ELISE Home Hub agent. Only documented APIs feed it:
 * WebSocket `get_states`, `config/entity_registry/list`, `state_changed` events, `call_service`,
 * and REST `/api/template` for device and area names. Nothing here leaves the hub except the
 * normalized ELISE shapes; Home Assistant's ids travel only as opaque provider keys.
 */

/** A state object as `get_states` / `state_changed` return it. */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_updated?: string;
}

/** An entry of `config/entity_registry/list` (the fields ELISE reads). */
export interface HaEntityEntry {
  entity_id: string;
  device_id?: string | null;
  area_id?: string | null;
  entity_category?: string | null;
  hidden_by?: string | null;
  disabled_by?: string | null;
  name?: string | null;
  original_name?: string | null;
  /** The integration that provides it ("androidtv_remote"). */
  platform?: string | null;
}

/** Device and area names, from the documented template API. */
export interface HaNames {
  devices: { id: string; name: string | null; area: string | null }[];
  areas: { id: string; name: string }[];
}

/** One normalized device, as the hub sends it to ELISE. */
export interface SyncedDevice {
  /** Stable key: the provider's device id, or the entity id for devices without one. */
  providerKey: string;
  providerDeviceId: string | null;
  /** The primary (controlled) entity first. */
  entityIds: string[];
  name: string;
  areaId: string | null;
  type: HomeDeviceType;
  capabilities: HomeCapability[];
  state: HomeState;
  available: boolean;
  stateUpdatedAt: string | null;
}

export interface SyncedRegistry {
  rooms: { providerAreaId: string; name: string }[];
  devices: SyncedDevice[];
}

const CONTROL_PRIORITY = [
  "climate",
  "light",
  "fan",
  "humidifier",
  "media_player",
  "switch",
] as const;
const SENSOR_DOMAINS = ["sensor", "binary_sensor"];
/** Sensor classes worth showing (the rest are diagnostics: signal, battery of a lamp…). */
const USEFUL_SENSORS = new Set([
  "temperature",
  "humidity",
  "power",
  "energy",
  "aqi",
  "pm25",
  "pm10",
  "carbon_dioxide",
  "volatile_organic_compounds",
  "occupancy",
  "motion",
  "presence",
  "illuminance",
]);

const domainOf = (entityId: string) => entityId.split(".")[0] ?? "";
/** "switch.humidificador_cuarto" → "Humidificador cuarto": never a provider id as a name. */
const humanize = (entityId: string) => {
  const s = (entityId.split(".")[1] ?? entityId).replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const sensorClass = (s: HaState) => str(s.attributes.device_class) ?? "";
const usefulSensor = (s: HaState) =>
  SENSOR_DOMAINS.includes(domainOf(s.entity_id)) && USEFUL_SENSORS.has(sensorClass(s));

// media_player supported_features bits (Home Assistant's MediaPlayerEntityFeature).
const MP = {
  PAUSE: 1,
  PREVIOUS: 16,
  NEXT: 32,
  VOLUME_SET: 4,
  TURN_ON: 128,
  TURN_OFF: 256,
  PLAY_MEDIA: 512,
  SELECT_SOURCE: 2048,
  PLAY: 16384,
};
// fan: SET_SPEED = 1.
const FAN_SET_SPEED = 1;

/** What an entity can do, in ELISE's capability terms. */
export function capabilitiesOf(
  s: HaState,
): { type: HomeDeviceType; capabilities: HomeCapability[] } | null {
  const a = s.attributes;
  const features = num(a.supported_features) ?? 0;
  switch (domainOf(s.entity_id)) {
    case "light": {
      const modes = strings(a.supported_color_modes);
      const caps: HomeCapability[] = [{ type: "power" }];
      if (modes.some((m) => m !== "onoff")) caps.push({ type: "brightness" });
      if (modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m)))
        caps.push({ type: "color" });
      if (modes.includes("color_temp"))
        caps.push({
          type: "color_temp",
          min: Math.round(num(a.min_color_temp_kelvin) ?? 2000),
          max: Math.round(num(a.max_color_temp_kelvin) ?? 6500),
        });
      return { type: "light", capabilities: caps };
    }
    case "switch":
      return { type: "switch", capabilities: [{ type: "power" }] };
    case "climate": {
      const caps: HomeCapability[] = [{ type: "power" }];
      const min = num(a.min_temp);
      const max = num(a.max_temp);
      if (min !== undefined && max !== undefined)
        caps.push({ type: "temperature", min, max, step: num(a.target_temp_step) ?? 0.5 });
      const hvac = strings(a.hvac_modes);
      if (hvac.length) caps.push({ type: "hvac_mode", modes: hvac });
      const fan = strings(a.fan_modes);
      if (fan.length) caps.push({ type: "fan_mode", modes: fan });
      return { type: "climate", capabilities: caps };
    }
    case "fan":
      return {
        type: "fan",
        capabilities: [
          { type: "power" },
          ...(features & FAN_SET_SPEED ? [{ type: "fan_speed" as const }] : []),
        ],
      };
    case "humidifier":
      return {
        type: "humidifier",
        capabilities: [
          { type: "power" },
          { type: "humidity", min: num(a.min_humidity) ?? 0, max: num(a.max_humidity) ?? 100 },
        ],
      };
    case "media_player": {
      const caps: HomeCapability[] = [];
      if (features & (MP.TURN_ON | MP.TURN_OFF)) caps.push({ type: "power" });
      if (features & MP.VOLUME_SET) caps.push({ type: "volume" });
      if (features & (MP.PLAY | MP.PAUSE | MP.NEXT | MP.PREVIOUS)) caps.push({ type: "media" });
      const sources = strings(a.source_list);
      if (features & MP.SELECT_SOURCE && sources.length)
        caps.push({ type: "source", sources: sources.slice(0, 40) });
      return { type: "media_player", capabilities: caps };
    }
    case "sensor":
    case "binary_sensor":
      return usefulSensor(s) ? { type: "sensor", capabilities: [] } : null;
    default:
      return null;
  }
}

/** A provider state → ELISE's normalized state. */
export function stateOf(s: HaState): HomeState {
  const a = s.attributes;
  const on = !["off", "unavailable", "unknown", "standby", "idle"].includes(s.state);
  switch (domainOf(s.entity_id)) {
    case "light": {
      const rgb = Array.isArray(a.rgb_color) ? (a.rgb_color as number[]) : null;
      const b = num(a.brightness);
      return {
        on: s.state === "on",
        ...(b !== undefined ? { brightness: Math.round((b / 255) * 100) } : {}),
        ...(rgb && rgb.length === 3 ? { color: { r: rgb[0]!, g: rgb[1]!, b: rgb[2]! } } : {}),
        ...(num(a.color_temp_kelvin) !== undefined ? { colorTemp: num(a.color_temp_kelvin) } : {}),
      };
    }
    case "switch":
    case "fan":
    case "humidifier":
      return {
        on: s.state === "on",
        ...(num(a.percentage) !== undefined ? { fanSpeed: num(a.percentage) } : {}),
        ...(num(a.humidity) !== undefined ? { targetHumidity: num(a.humidity) } : {}),
        ...(num(a.current_humidity) !== undefined ? { humidity: num(a.current_humidity) } : {}),
      };
    case "climate":
      return {
        on: s.state !== "off" && s.state !== "unavailable",
        hvacMode: s.state,
        ...(num(a.current_temperature) !== undefined
          ? { currentTemperature: num(a.current_temperature) }
          : {}),
        ...(num(a.temperature) !== undefined ? { targetTemperature: num(a.temperature) } : {}),
        ...(str(a.fan_mode) ? { fanMode: str(a.fan_mode) } : {}),
        ...(num(a.current_humidity) !== undefined ? { humidity: num(a.current_humidity) } : {}),
      };
    case "media_player":
      return {
        on,
        ...(s.state === "playing" || s.state === "paused"
          ? { playing: s.state === "playing" }
          : {}),
        ...(num(a.volume_level) !== undefined
          ? { volume: Math.round(num(a.volume_level)! * 100) }
          : {}),
        ...(str(a.source) ? { source: str(a.source) } : {}),
      };
    default: {
      const value = num(Number(s.state)) ?? s.state;
      const unit = str(a.unit_of_measurement);
      return { reading: { value, ...(unit ? { unit } : {}) }, quantity: sensorClass(s) };
    }
  }
}

/**
 * The registry → one ELISE device per physical device: its main controllable entity, or — for
 * a sensor-only device — its useful readings. Diagnostics, config entities, firmware updates,
 * hidden and disabled entities are left out.
 */
export function normalizeRegistry(
  states: readonly HaState[],
  entries: readonly HaEntityEntry[],
  names: HaNames,
): SyncedRegistry {
  const entryOf = new Map(entries.map((e) => [e.entity_id, e]));
  const deviceName = new Map(names.devices.map((d) => [d.id, d]));
  const visible = states.filter((s) => {
    const e = entryOf.get(s.entity_id);
    if (e && (e.entity_category || e.hidden_by || e.disabled_by)) return false;
    return capabilitiesOf(s) !== null;
  });
  const groups = new Map<string, HaState[]>();
  for (const s of visible) {
    const key = entryOf.get(s.entity_id)?.device_id ?? `entity:${s.entity_id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const devices: SyncedDevice[] = [];
  for (const [key, members] of groups) {
    const providerDeviceId = key.startsWith("entity:") ? null : key;
    const primary =
      CONTROL_PRIORITY.map((d) => members.find((m) => domainOf(m.entity_id) === d)).find(Boolean) ??
      members[0]!;
    const entry = entryOf.get(primary.entity_id);
    const kind = capabilitiesOf(primary)!;
    // Android TVs open apps by link (play_media "app"); other players take media there instead.
    if (
      entry?.platform === "androidtv_remote" &&
      (num(primary.attributes.supported_features) ?? 0) & MP.PLAY_MEDIA
    )
      kind.capabilities.push({ type: "app" });
    const info = providerDeviceId ? deviceName.get(providerDeviceId) : undefined;
    const name =
      info?.name ??
      entry?.name ??
      str(primary.attributes.friendly_name) ??
      entry?.original_name ??
      humanize(primary.entity_id);
    const sensors = members.filter(usefulSensor);
    // An Android TV's remote entity: its sleep key is the reliable "off" (see sleepCall).
    const remote =
      entry?.platform === "androidtv_remote" && providerDeviceId
        ? entries.find(
            (e) =>
              e.device_id === providerDeviceId &&
              domainOf(e.entity_id) === "remote" &&
              !e.disabled_by,
          )?.entity_id
        : undefined;
    const state =
      kind.type === "sensor"
        ? {
            ...stateOf(primary),
            readings: sensors.slice(0, 6).map((m) => {
              const r = stateOf(m);
              return {
                quantity: sensorClass(m),
                value: r.reading!.value,
                ...(r.reading!.unit ? { unit: r.reading!.unit } : {}),
              };
            }),
          }
        : stateOf(primary);
    devices.push({
      providerKey: key,
      providerDeviceId,
      entityIds: [
        primary.entity_id,
        ...members.filter((m) => m !== primary).map((m) => m.entity_id),
        ...(remote ? [remote] : []),
      ].slice(0, 30),
      name: String(name).slice(0, 120),
      areaId: entry?.area_id ?? info?.area ?? null,
      type: kind.type,
      capabilities: kind.capabilities,
      state,
      available: primary.state !== "unavailable",
      stateUpdatedAt: primary.last_updated ?? null,
    });
  }
  const used = new Set(devices.map((d) => d.areaId).filter(Boolean));
  return {
    rooms: names.areas
      .filter((a) => used.has(a.id))
      .map((a) => ({ providerAreaId: a.id, name: a.name })),
    devices,
  };
}

/** The documented template that names devices and areas (REST `POST /api/template`). */
export function namesTemplate(deviceIds: readonly string[]): string {
  const ids = JSON.stringify(deviceIds.filter((d) => /^[a-zA-Z0-9_-]+$/.test(d)));
  return `{% set ns = namespace(d=[], a=[]) %}{% for id in ${ids} %}{% set ns.d = ns.d + [{"id": id, "name": device_attr(id, "name_by_user") or device_attr(id, "name"), "area": area_id(id)}] %}{% endfor %}{% for a in areas() %}{% set ns.a = ns.a + [{"id": a, "name": area_name(a)}] %}{% endfor %}{{ {"devices": ns.d, "areas": ns.a} | tojson }}`;
}

/** The app links Android TV opens (Home Assistant's androidtv_remote documents these). */
const APP_LINKS: Record<HomeApp, string> = {
  youtube: "https://www.youtube.com",
  netflix: "https://www.netflix.com/title",
  prime_video: "https://app.primevideo.com",
  disney_plus: "https://www.disneyplus.com",
  max: "https://play.max.com",
};

/**
 * Turning an Android TV off: the power key toggles, and with an app in front it only closes the
 * app. The sleep key only ever puts it to sleep, so it goes instead of the power call; the hub
 * sends the power call only if the TV is still on a moment later (`sleepThenVerify`, agent).
 */
export function sleepCall(
  entityIds: readonly string[],
  actions: readonly HomeAction[],
): HaServiceCall | null {
  const remote = entityIds.find((e) => domainOf(e) === "remote");
  if (!remote || !actions.some((a) => a.type === "power" && !a.on)) return null;
  return {
    domain: "remote",
    service: "send_command",
    service_data: { command: "SLEEP" },
    target: { entity_id: remote },
  };
}

export interface HaServiceCall {
  domain: string;
  service: string;
  service_data?: Record<string, unknown>;
  target: { entity_id: string };
}

/**
 * ELISE's validated actions → Home Assistant actions (`call_service`), for the device's main
 * entity. A light's settings travel in one `turn_on`; the rest go one by one, in order.
 */
export function toServiceCalls(entityId: string, actions: readonly HomeAction[]): HaServiceCall[] {
  const domain = domainOf(entityId);
  const target = { entity_id: entityId };
  const call = (service: string, service_data?: Record<string, unknown>): HaServiceCall => ({
    domain,
    service,
    target,
    ...(service_data ? { service_data } : {}),
  });
  if (domain === "light") {
    const off = actions.some((a) => a.type === "power" && !a.on);
    const data: Record<string, unknown> = {};
    for (const a of actions) {
      if (a.type === "brightness") data.brightness_pct = a.value;
      if (a.type === "color") data.rgb_color = [a.rgb.r, a.rgb.g, a.rgb.b];
      if (a.type === "color_temp") data.color_temp_kelvin = a.kelvin;
    }
    if (off && !Object.keys(data).length) return [call("turn_off")];
    return [call("turn_on", Object.keys(data).length ? data : undefined)];
  }
  const calls: HaServiceCall[] = [];
  for (const a of actions) {
    switch (a.type) {
      case "power":
        calls.push(call(a.on ? "turn_on" : "turn_off"));
        break;
      case "temperature":
        calls.push(call("set_temperature", { temperature: a.value }));
        break;
      case "hvac_mode":
        calls.push(call("set_hvac_mode", { hvac_mode: a.mode }));
        break;
      case "fan_mode":
        calls.push(call("set_fan_mode", { fan_mode: a.mode }));
        break;
      case "fan_speed":
        calls.push(call("set_percentage", { percentage: a.value }));
        break;
      case "humidity":
        calls.push(call("set_humidity", { humidity: a.value }));
        break;
      case "volume":
        calls.push(call("volume_set", { volume_level: a.value / 100 }));
        break;
      case "media":
        calls.push(
          call(
            a.command === "play"
              ? "media_play"
              : a.command === "pause"
                ? "media_pause"
                : a.command === "next"
                  ? "media_next_track"
                  : "media_previous_track",
          ),
        );
        break;
      case "source":
        calls.push(call("select_source", { source: a.source }));
        break;
      case "app":
        calls.push(
          call("play_media", { media_content_type: "app", media_content_id: APP_LINKS[a.app] }),
        );
        break;
      default:
        // Brightness, color and white tone only exist on lights (validated before).
        throw new Error(`unsupported action ${a.type} for ${domain}`);
    }
  }
  return calls;
}
