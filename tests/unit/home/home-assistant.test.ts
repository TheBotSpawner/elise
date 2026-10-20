import { describe, expect, it, vi } from "vitest";

import { validateAction, type HomeDevice } from "@/core/home/model";
import { normalizeRegistry, toServiceCalls } from "@/infrastructure/home/home-assistant";

import { HA_ENTRIES, HA_NAMES, HA_STATES } from "../../fixtures/home-assistant";

/** Home Assistant → ELISE Home (ADR-079): normalized devices, never provider objects. */
describe("discovery", () => {
  const reg = normalizeRegistry(HA_STATES, HA_ENTRIES, HA_NAMES);
  const by = (name: string) => reg.devices.find((d) => d.name === name)!;

  it("one device per physical device; diagnostics, firmware and automations left out", () => {
    expect(reg.devices.map((d) => d.name).sort()).toEqual(
      [
        "Aire",
        "Humidificador",
        "Luz escritorio",
        "Luz patio",
        "Luz principal",
        "Sensor living",
        "TV",
        "Ventilador",
        "Humidificador",
      ].sort(),
    );
    expect(by("Luz escritorio").entityIds[0]).toBe("light.escritorio");
    expect(JSON.stringify(reg)).not.toContain("rssi");
    expect(JSON.stringify(reg)).not.toContain("firmware");
  });

  it("rooms come from areas actually used", () => {
    expect(reg.rooms.map((r) => r.name).sort()).toEqual(["Dormitorio", "Escritorio", "Living"]);
    expect(by("Aire").areaId).toBe("living");
    // An entity's own area wins (the plug has no device).
    expect(reg.devices.find((d) => d.providerKey === "entity:switch.humidificador")!.areaId).toBe(
      "dormitorio",
    );
  });

  it("capabilities are inferred from what each device supports", () => {
    expect(by("Luz escritorio").capabilities.map((c) => c.type)).toEqual([
      "power",
      "brightness",
      "color",
      "color_temp",
    ]);
    expect(by("Luz principal").capabilities.map((c) => c.type)).toEqual(["power"]);
    expect(by("Aire").capabilities).toEqual([
      { type: "power" },
      { type: "temperature", min: 16, max: 30, step: 1 },
      { type: "hvac_mode", modes: ["off", "cool", "heat", "auto"] },
      { type: "fan_mode", modes: ["low", "high"] },
    ]);
    expect(by("Ventilador").capabilities.map((c) => c.type)).toEqual(["power", "fan_speed"]);
    expect(by("TV").capabilities.map((c) => c.type)).toEqual([
      "power",
      "volume",
      "media",
      "source",
    ]);
  });

  it("states are normalized; unavailable is reflected; sensors keep every reading", () => {
    expect(by("Luz escritorio").state).toMatchObject({
      on: true,
      brightness: 50,
      color: { r: 0, g: 255, b: 0 },
    });
    expect(by("Aire").state).toMatchObject({
      hvacMode: "cool",
      currentTemperature: 26,
      targetTemperature: 24,
    });
    expect(by("TV").state).toMatchObject({ playing: false, volume: 20, source: "Netflix" });
    expect(by("Luz patio").available).toBe(false);
    expect(by("Sensor living").type).toBe("sensor");
    expect(by("Sensor living").state.readings).toEqual([
      { quantity: "temperature", value: 23.5, unit: "°C" },
      { quantity: "humidity", value: 48, unit: "%" },
    ]);
  });
});

describe("ELISE actions → Home Assistant actions", () => {
  const reg = normalizeRegistry(HA_STATES, HA_ENTRIES, HA_NAMES);
  const device = (name: string): HomeDevice => {
    const d = reg.devices.find((x) => x.name === name)!;
    return {
      id: d.providerKey,
      name: d.name,
      aliases: [],
      roomId: null,
      type: d.type,
      capabilities: d.capabilities,
      state: d.state,
      available: d.available,
      stateUpdatedAt: null,
      favorite: false,
    };
  };

  it("a light's power, color and brightness travel in one turn_on", () => {
    const lamp = device("Luz escritorio");
    const actions = [
      validateAction(lamp, { type: "power", value: true }),
      validateAction(lamp, { type: "color", value: "verde" }),
      validateAction(lamp, { type: "brightness", value: 25 }),
    ].map((v) => (v.ok ? v.action : null)!);
    expect(toServiceCalls("light.escritorio", actions)).toEqual([
      {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.escritorio" },
        service_data: { rgb_color: [0, 255, 0], brightness_pct: 25 },
      },
    ]);
  });

  it("color on a light without color is refused before anything reaches the provider", () => {
    expect(validateAction(device("Luz principal"), { type: "color", value: "rojo" })).toMatchObject(
      { ok: false, code: "unsupported" },
    );
  });

  it("climate: target temperature and mode, in order", () => {
    expect(
      toServiceCalls("climate.aire_living", [
        { type: "power", on: true },
        { type: "temperature", value: 24 },
      ]),
    ).toEqual([
      { domain: "climate", service: "turn_on", target: { entity_id: "climate.aire_living" } },
      {
        domain: "climate",
        service: "set_temperature",
        target: { entity_id: "climate.aire_living" },
        service_data: { temperature: 24 },
      },
    ]);
  });
});

/** "Abrí YouTube en la tele" (Android TV): an app link, or the TV's own source when it lists it. */
describe("opening apps on a TV", () => {
  const tv = {
    entity_id: "media_player.tv_dormitorio",
    state: "on",
    attributes: { friendly_name: "TV del dormitorio", supported_features: 128 | 256 | 4 | 512 },
  };
  const entry = { entity_id: tv.entity_id, device_id: "d1", platform: "androidtv_remote" };
  const names = { devices: [{ id: "d1", name: "TV del dormitorio", area: null }], areas: [] };

  it("an Android TV can open apps; another player with the same features can't", () => {
    const remote = {
      entity_id: "remote.tv_dormitorio",
      device_id: "d1",
      platform: "androidtv_remote",
    };
    const [android] = normalizeRegistry([tv], [entry, remote], names).devices;
    expect(android!.capabilities).toContainEqual({ type: "app" });
    // Its remote rides along, for the sleep key.
    expect(android!.entityIds).toEqual([tv.entity_id, remote.entity_id]);
    const [cast] = normalizeRegistry([tv], [{ ...entry, platform: "cast" }], names).devices;
    expect(cast!.capabilities).not.toContainEqual({ type: "app" });
  });

  it("a Cast-only TV offers no power and doesn't claim off: its 'off' only quits the app", () => {
    const idle = { ...tv, state: "off" };
    const [cast] = normalizeRegistry([idle], [{ ...entry, platform: "cast" }], names).devices;
    expect(cast!.capabilities.map((c) => c.type)).not.toContain("power");
    expect(cast!.capabilities.map((c) => c.type)).toContain("volume");
    expect(cast!.state.on).toBeUndefined();
    const [playing] = normalizeRegistry(
      [{ ...tv, state: "playing" }],
      [{ ...entry, platform: "cast" }],
      names,
    ).devices;
    expect(playing!.state.on).toBe(true);
  });

  it("validates the app by the words people use and opens it by link", () => {
    const [d] = normalizeRegistry([tv], [entry], names).devices;
    const device = { ...d!, id: "x", aliases: [], roomId: null, favorite: false } as HomeDevice;
    const v = validateAction(device, { type: "app", value: "YouTube" });
    expect(v).toEqual({ ok: true, action: { type: "app", app: "youtube" } });
    expect(validateAction(device, { type: "app", value: "Kodi" })).toMatchObject({ ok: false });
    expect(toServiceCalls(tv.entity_id, [{ type: "app", app: "youtube" }])).toEqual([
      {
        domain: "media_player",
        service: "play_media",
        target: { entity_id: tv.entity_id },
        service_data: { media_content_type: "app", media_content_id: "https://www.youtube.com" },
      },
    ]);
  });

  it("a TV that lists the app as a source switches to it instead", () => {
    const device = {
      capabilities: [{ type: "source", sources: ["HDMI 1", "Netflix"] }],
    } as unknown as HomeDevice;
    expect(validateAction(device, { type: "app", value: "netflix" })).toEqual({
      ok: true,
      action: { type: "source", source: "Netflix" },
    });
  });
});

describe("removing from the engine", async () => {
  const { HomeAssistantClient } = await import("../../../home-hub/home-assistant-client");
  const setup = (registry: { id: string; config_entries: string[] }[]) => {
    const c = new HomeAssistantClient("http://ha.local", "t");
    const sent: unknown[] = [];
    (c as unknown as { command: (p: unknown) => Promise<unknown> }).command = async (p) => {
      sent.push(p);
      return (p as { type: string }).type === "config/device_registry/list" ? registry : null;
    };
    return { c, sent };
  };

  it("a device alone in its entry (a paired TV) takes the entry with it", async () => {
    const { c } = setup([{ id: "tv", config_entries: ["e1"] }]);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await c.removeDevice("tv", ["media_player.tv"]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      "http://ha.local/api/config/config_entries/entry/e1",
    );
    vi.unstubAllGlobals();
  });

  it("a device sharing its entry (a bridge's light) leaves only that entry", async () => {
    const { c, sent } = setup([
      { id: "lamp", config_entries: ["bridge"] },
      { id: "other", config_entries: ["bridge"] },
    ]);
    await c.removeDevice("lamp", ["light.lamp"]);
    expect(sent).toContainEqual({
      type: "config/device_registry/remove_config_entry",
      device_id: "lamp",
      config_entry_id: "bridge",
    });
  });
});
