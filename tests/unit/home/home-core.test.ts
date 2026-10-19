import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  broadTargets,
  homeSetupState,
  HUB_OFFLINE_AFTER_MS,
  validateAction,
  type HomeAction,
  type HomeCommandOutcome,
  type HomeDevice,
  type HomePort,
  type HomeScene,
  type HomeSnapshot,
} from "@/core/home/model";
import { resolveDevice } from "@/core/home/resolve";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * ELISE Home (ADR-079): AI for intent, code for execution. The model names what it wants; this
 * code resolves real devices, validates every value and reports exactly what happened.
 */

const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const ROOMS = [
  { id: id(91), name: "Living", aliases: [], icon: null, favorite: false },
  { id: id(92), name: "Escritorio", aliases: [], icon: null, favorite: false },
  { id: id(93), name: "Dormitorio", aliases: [], icon: null, favorite: false },
];
const dev = (n: number, over: Partial<HomeDevice>): HomeDevice => ({
  id: id(n),
  name: "x",
  aliases: [],
  roomId: null,
  type: "light",
  capabilities: [{ type: "power" }],
  state: {},
  available: true,
  stateUpdatedAt: "2026-10-18T20:00:00Z",
  favorite: false,
  ...over,
});
const LAMP = dev(1, {
  name: "Luz escritorio",
  roomId: ROOMS[1]!.id,
  capabilities: [{ type: "power" }, { type: "brightness" }, { type: "color" }],
  state: { on: false, brightness: 60 },
});
const MAIN = dev(2, {
  name: "Luz principal",
  roomId: ROOMS[0]!.id,
  capabilities: [{ type: "power" }, { type: "brightness" }],
});
const AC = dev(3, {
  name: "Aire",
  type: "climate",
  roomId: ROOMS[0]!.id,
  capabilities: [
    { type: "power" },
    { type: "temperature", min: 16, max: 30, step: 1 },
    { type: "hvac_mode", modes: ["off", "cool", "heat"] },
  ],
  state: { on: true, targetTemperature: 24, hvacMode: "cool" },
});
const HUM = dev(4, { name: "Humidificador", type: "switch", roomId: ROOMS[2]!.id });

function home(
  devices: HomeDevice[],
  over: Partial<HomeSnapshot> = {},
  results: (d: string) => HomeCommandOutcome["status"] = () => "succeeded",
) {
  const sent: { deviceId: string; actions: HomeAction[] }[][] = [];
  let scenes: HomeScene[] = over.scenes ?? [];
  const port: HomePort = {
    snapshot: async () => ({
      home: { id: id(80), name: "Casa" },
      hub: {
        id: id(81),
        name: "ELISE Desktop",
        status: "online",
        setup: "hub_ready",
        lastSeenAt: new Date().toISOString(),
        lastSyncAt: null,
      },
      rooms: ROOMS,
      devices,
      groups: [],
      ...over,
      scenes,
    }),
    execute: async (commands) => {
      sent.push(commands);
      return commands.map((c) => ({
        deviceId: c.deviceId,
        name: devices.find((d) => d.id === c.deviceId)!.name,
        status: results(c.deviceId),
      }));
    },
    saveScene: async (s) => {
      const saved = { ...s, id: s.id ?? id(70), favorite: false };
      scenes = [...scenes.filter((x) => x.id !== saved.id), saved];
      return saved;
    },
    deleteScene: async (sid) => void (scenes = scenes.filter((x) => x.id !== sid)),
  };
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "home" ? port : undefined)) as ProviderFactory["get"],
  };
  return { ports, sent, scenes: () => scenes };
}

const call = (h: ReturnType<typeof home>, name: string, args: unknown) =>
  executeToolCall(h.ports, makeCtx(), { name, args });

describe("validation (deterministic)", () => {
  it("climate out of range fails; relative changes are clamped", () => {
    expect(validateAction(AC, { type: "temperature", value: 35 })).toMatchObject({
      ok: false,
      code: "out_of_range",
    });
    expect(validateAction(AC, { type: "temperature", value: 24 })).toEqual({
      ok: true,
      action: { type: "temperature", value: 24 },
    });
    expect(
      validateAction(
        { ...AC, state: { targetTemperature: 29 } },
        { type: "temperature", value: 5, relative: true },
      ),
    ).toEqual({
      ok: true,
      action: { type: "temperature", value: 30 },
    });
    expect(validateAction(LAMP, { type: "brightness", value: -20, relative: true })).toEqual({
      ok: true,
      action: { type: "brightness", value: 40 },
    });
  });

  it("modes are only the device's own; Spanish words map to them", () => {
    expect(validateAction(AC, { type: "hvac_mode", value: "frío" })).toEqual({
      ok: true,
      action: { type: "hvac_mode", mode: "cool" },
    });
    expect(validateAction(AC, { type: "hvac_mode", value: "dry" })).toMatchObject({ ok: false });
  });

  it("broad actions skip climate unless named, and anything that can't do it", () => {
    expect(broadTargets([LAMP, MAIN, AC, HUM], ["power"]).map((d) => d.name)).toEqual([
      "Luz escritorio",
      "Luz principal",
      "Humidificador",
    ]);
    expect(broadTargets([LAMP, MAIN, HUM], ["brightness"]).map((d) => d.name)).toEqual([
      "Luz escritorio",
      "Luz principal",
    ]);
  });
});

describe("natural references", () => {
  const all = [LAMP, MAIN, AC, HUM];
  it("'la luz del escritorio' is that lamp; 'el aire' with one AC is it", () => {
    expect(resolveDevice("la luz del escritorio", all, ROOMS)).toMatchObject({
      kind: "one",
      item: { name: "Luz escritorio" },
    });
    expect(resolveDevice("lamparita escritorio", all, ROOMS)).toMatchObject({
      kind: "one",
      item: { name: "Luz escritorio" },
    });
    expect(resolveDevice("el aire", all, ROOMS)).toMatchObject({
      kind: "one",
      item: { name: "Aire" },
    });
  });

  it("two ACs and no context → ask", () => {
    const AC2 = dev(5, { ...AC, id: id(5), name: "Aire", roomId: ROOMS[2]!.id });
    expect(resolveDevice("el aire", [...all, AC2], ROOMS).kind).toBe("ambiguous");
    expect(resolveDevice("el aire del dormitorio", [...all, AC2], ROOMS)).toMatchObject({
      kind: "one",
      item: { id: id(5) },
    });
  });

  it("aliases count", () => {
    const withAlias = { ...LAMP, aliases: ["luz PC"] };
    expect(resolveDevice("luz pc", [withAlias, MAIN], ROOMS)).toMatchObject({
      kind: "one",
      item: { name: "Luz escritorio" },
    });
  });
});

describe("home.control", () => {
  it("'prendé la luz del escritorio en verde y bajita' → one validated command, then 'Listo.'", async () => {
    const h = home([LAMP, MAIN, AC, HUM]);
    const out = await call(h, "home.control", {
      device: "luz del escritorio",
      actions: [
        { type: "power", value: true },
        { type: "color", value: "verde" },
        { type: "brightness", value: 25 },
      ],
    });
    expect(out.status).toBe("succeeded");
    expect(h.sent[0]).toEqual([
      {
        deviceId: LAMP.id,
        actions: [
          { type: "power", on: true },
          { type: "color", rgb: { r: 0, g: 255, b: 0 } },
          { type: "brightness", value: 25 },
        ],
      },
    ]);
    expect(out.status === "succeeded" && out.display).toMatchObject({ kind: "home" });
    expect(JSON.stringify(out)).not.toMatch(/light\.|entity|service/);
  });

  it("follow-up 'bajala al 20%' with the device just controlled", async () => {
    const h = home([LAMP, MAIN]);
    await call(h, "home.control", {
      device: "Luz escritorio",
      actions: [{ type: "brightness", value: 20 }],
    });
    expect(h.sent[0]![0]).toEqual({
      deviceId: LAMP.id,
      actions: [{ type: "brightness", value: 20 }],
    });
  });

  it("unsupported (color on a plain light) is refused and nothing is sent", async () => {
    const h = home([MAIN]);
    const out = await call(h, "home.control", {
      device: "luz principal",
      actions: [{ type: "color", value: "rojo" }],
    });
    expect(out.status === "succeeded" && out.output).toMatchObject({ done: false });
    expect(h.sent).toHaveLength(0);
  });

  it("ambiguous → asks which, nothing sent", async () => {
    const AC2 = dev(5, { ...AC, id: id(5), roomId: ROOMS[2]!.id });
    const h = home([AC, AC2]);
    const out = await call(h, "home.control", {
      device: "el aire",
      actions: [{ type: "power", value: true }],
    });
    expect(out.status === "succeeded" && out.output).toMatchObject({ needsChoice: true });
    expect(h.sent).toHaveLength(0);
  });

  it("'apagá todo el living' only touches compatible, low-risk devices there", async () => {
    const h = home([LAMP, MAIN, AC, HUM]);
    await call(h, "home.control", { room: "living", actions: [{ type: "power", value: false }] });
    expect(h.sent[0]!.map((c) => c.deviceId)).toEqual([MAIN.id]);
  });

  it("hub offline → a clear offline result, never a fake success", async () => {
    const h = home([LAMP], {}, () => "offline");
    const out = await call(h, "home.control", {
      device: "luz escritorio",
      actions: [{ type: "power", value: true }],
    });
    expect(out.status === "succeeded" && out.output).toMatchObject({ hubOffline: true });
    expect(JSON.stringify(out.status === "succeeded" && out.output)).toMatch(/last known/);
  });
});

describe("modes", () => {
  const ESTUDIO: HomeScene = {
    id: id(70),
    name: "Estudio",
    icon: null,
    aliases: [],
    favorite: false,
    actions: [
      {
        deviceId: LAMP.id,
        actions: [
          { type: "color", value: "verde" },
          { type: "brightness", value: 25 },
        ],
      },
      { deviceId: AC.id, actions: [{ type: "temperature", value: 24 }] },
      { deviceId: HUM.id, actions: [{ type: "power", value: true }] },
    ],
  };

  it("'activá Modo Estudio' → typed actions per device; a partial failure is named", async () => {
    const h = home([LAMP, AC, HUM], { scenes: [ESTUDIO] }, (d) =>
      d === HUM.id ? "failed" : "succeeded",
    );
    const out = await call(h, "home.runScene", { scene: "Modo Estudio" });
    expect(h.sent[0]!.map((c) => c.deviceId)).toEqual([LAMP.id, AC.id, HUM.id]);
    expect(out.status === "succeeded" && out.output).toMatchObject({
      mode: "Estudio",
      notResponding: ["Humidificador"],
    });
  });

  it("all fine → 'Estudio activado.' without another model call", async () => {
    const h = home([LAMP, AC, HUM], { scenes: [ESTUDIO] });
    const out = await call(h, "home.runScene", { scene: "estudio" });
    expect(out.status === "succeeded" && out.output).toMatchObject({ notResponding: [] });
  });

  it("created and edited from conversation, as typed actions", async () => {
    const h = home([LAMP, AC, HUM]);
    await call(h, "home.saveScene", {
      name: "Estudio",
      set: [
        {
          device: "luz del escritorio",
          actions: [
            { type: "color", value: "verde" },
            { type: "brightness", value: 30 },
          ],
        },
        { device: "el aire", actions: [{ type: "temperature", value: 24 }] },
      ],
    });
    expect(h.scenes()[0]!.actions.map((a) => a.deviceId)).toEqual([LAMP.id, AC.id]);
    await call(h, "home.saveScene", {
      scene: "Modo Estudio",
      set: [{ device: "humidificador", actions: [{ type: "power", value: true }] }],
    });
    await call(h, "home.saveScene", { scene: "Estudio", remove: ["el aire"] });
    expect(h.scenes()[0]!.actions.map((a) => a.deviceId)).toEqual([LAMP.id, HUM.id]);
    const bad = await call(h, "home.saveScene", {
      scene: "Estudio",
      set: [{ device: "el aire", actions: [{ type: "temperature", value: 40 }] }],
    });
    expect(bad.status === "succeeded" && bad.output).toMatchObject({ saved: false });
  });

  it("deleting a mode always asks first", async () => {
    const h = home([LAMP], { scenes: [ESTUDIO] });
    const out = await call(h, "home.deleteScene", { scene: "Estudio" });
    expect(out.status).toBe("approval_required");
  });
});

describe("Desktop / hub presence (ADR-080)", () => {
  const now = new Date("2026-10-18T20:00:00Z");
  const seen = (ago: number) => new Date(now.getTime() - ago).toISOString();
  const hub = (over: object) => ({
    lastSeenAt: seen(5000),
    providerConnected: true,
    runtimeState: "ready" as const,
    protocolVersion: 1,
    lastSyncAt: seen(5000),
    ...over,
  });
  it("derived only from the authenticated heartbeat", () => {
    expect(homeSetupState(null, now)).toBe("desktop_not_configured");
    expect(homeSetupState(hub({ lastSeenAt: seen(HUB_OFFLINE_AFTER_MS + 1000) }), now)).toBe(
      "desktop_offline",
    );
    expect(homeSetupState(hub({ protocolVersion: 0 }), now)).toBe("desktop_update_required");
    expect(
      homeSetupState(hub({ runtimeState: "initializing", providerConnected: false }), now),
    ).toBe("hub_initializing");
    expect(homeSetupState(hub({ runtimeState: "error", providerConnected: false }), now)).toBe(
      "hub_error",
    );
    expect(homeSetupState(hub({ lastSyncAt: null }), now)).toBe("desktop_online");
    expect(homeSetupState(hub({}), now)).toBe("hub_ready");
  });
});

/** When a device can't do something, ELISE knows what to offer instead. */
describe("what a device can do", () => {
  it("lists a TV's abilities in plain words", async () => {
    const { canDo } = await import("@/core/tools/home");
    const tv = dev(70, {
      type: "media_player",
      capabilities: [
        { type: "power" },
        { type: "volume" },
        { type: "source", sources: ["HDMI 1", "Netflix"] },
      ],
    });
    expect(canDo(tv)).toEqual(["turn on/off", "volume", "input or app: HDMI 1, Netflix"]);
  });
});
