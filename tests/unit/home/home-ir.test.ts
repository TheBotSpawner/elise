import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { lanHost } from "@/core/home/discovery";
import {
  describeState,
  estimateIr,
  irDeviceName,
  presetKey,
  validateAction,
  type HomeDevice,
  type IrCapability,
} from "@/core/home/model";
import { sessionCommand } from "@/core/voice/session-control";
import {
  normalizeRegistry,
  toServiceCalls,
  type HaEntityEntry,
  type HaState,
} from "@/infrastructure/home/home-assistant";

import { HubAgent } from "../../../home-hub/agent";
import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * ADR-110: infrared through a Broadlink, simulated end to end — no hardware. The engine's
 * Broadlink entities, the hub's learn/send, ELISE's honest validation and the cloud's routing
 * of an infrared device's command to its own controller.
 */

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
const service = await import("@/application/home-service");

// ── A simulated Broadlink RM4 mini in the engine ─────────────────────────────

const BL_STATES: HaState[] = [
  { entity_id: "remote.rm4_mini_living", state: "on", attributes: { friendly_name: "RM4 mini" } },
  {
    entity_id: "sensor.rm4_mini_living_temperature",
    state: "23.5",
    attributes: { device_class: "temperature", unit_of_measurement: "°C" },
  },
  { entity_id: "remote.android_tv", state: "on", attributes: {} },
];
const BL_ENTRIES: HaEntityEntry[] = [
  {
    entity_id: "remote.rm4_mini_living",
    device_id: "bl1",
    platform: "broadlink",
    area_id: "living",
  },
  { entity_id: "sensor.rm4_mini_living_temperature", device_id: "bl1", platform: "broadlink" },
  { entity_id: "remote.android_tv", device_id: "tv1", platform: "androidtv_remote" },
];
const NAMES = {
  devices: [{ id: "bl1", name: "Broadlink living", area: "living" }],
  areas: [{ id: "living", name: "Living" }],
};

describe("the engine's Broadlink → an ELISE infrared controller", () => {
  it("is one controller (remote first, readings kept); another integration's remote isn't", () => {
    const reg = normalizeRegistry(BL_STATES, BL_ENTRIES, NAMES);
    expect(reg.devices).toHaveLength(1);
    expect(reg.devices[0]).toMatchObject({
      providerKey: "bl1",
      type: "ir_controller",
      name: "Broadlink living",
      capabilities: [{ type: "ir_blaster" }],
      entityIds: ["remote.rm4_mini_living", "sensor.rm4_mini_living_temperature"],
    });
    expect(reg.devices[0]!.state.readings?.[0]).toMatchObject({ quantity: "temperature" });
  });

  it("a learned code goes as send_command with ELISE's names — only on a remote", () => {
    const a = { type: "ir", device: "elise_0123456789ab", command: "mute", repeats: 2 } as const;
    expect(toServiceCalls("remote.rm4_mini_living", [a])).toEqual([
      {
        domain: "remote",
        service: "send_command",
        target: { entity_id: "remote.rm4_mini_living" },
        service_data: { device: "elise_0123456789ab", command: "mute", num_repeats: 2 },
      },
    ]);
    expect(() => toServiceCalls("light.escritorio", [a])).toThrow();
  });
});

// ── ELISE's validation: never a promise infrared can't keep ───────────────────

const CONTROLLER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ir = (kind: IrCapability["kind"], commands: IrCapability["commands"]): IrCapability => ({
  type: "ir",
  controllerId: CONTROLLER,
  device: "elise_0123456789ab",
  kind,
  commands,
});
const cmd = (key: string, label: string, preset?: IrCapability["commands"][number]["preset"]) => ({
  key,
  label,
  verified: true,
  ...(preset ? { preset } : {}),
});
const device = (cap: IrCapability, state: HomeDevice["state"] = {}): HomeDevice => ({
  id: "d",
  name: "TV living",
  aliases: [],
  roomId: null,
  type: cap.kind === "ac" ? "climate" : "media_player",
  capabilities: [cap],
  state,
  available: true,
  stateUpdatedAt: null,
  favorite: false,
});

const TV = device(
  ir("tv", [
    cmd("power_toggle", "Encender/apagar"),
    cmd("volume_up", "Subir volumen"),
    cmd("volume_down", "Bajar volumen"),
    cmd("mute", "Silencio"),
  ]),
);
const AC = device(
  ir("ac", [
    cmd("power_off", "Apagar"),
    cmd("preset_cool_24", "Frío · 24 °C", { hvacMode: "cool", temperature: 24 }),
    cmd("preset_cool_22", "Frío · 22 °C", { hvacMode: "cool", temperature: 22 }),
    cmd("preset_heat_22", "Calor · 22 °C", { hvacMode: "heat", temperature: 22 }),
  ]),
  { hvacMode: "cool", targetTemperature: 24, on: true, estimated: true },
);
const ok = (r: ReturnType<typeof validateAction>) => (r.ok ? r.action : r);

describe("infrared, honestly", () => {
  it("a button by its name or key", () => {
    expect(ok(validateAction(TV, { type: "button", value: "silencio" }))).toMatchObject({
      type: "ir",
      command: "mute",
    });
    expect(validateAction(TV, { type: "button", value: "netflix" }).ok).toBe(false);
  });

  it("a single toggle button is never 'off': ELISE asks first", () => {
    const r = validateAction(TV, { type: "power", value: false });
    expect(r).toMatchObject({ ok: false, code: "unsupported" });
    expect(!r.ok && r.message).toMatch(/toggle/);
  });

  it("volume only steps: '+10' → two presses; an exact level is refused", () => {
    expect(ok(validateAction(TV, { type: "volume", value: 10, relative: true }))).toEqual({
      type: "ir",
      device: "elise_0123456789ab",
      command: "volume_up",
      repeats: 2,
    });
    expect(validateAction(TV, { type: "volume", value: 30 }).ok).toBe(false);
  });

  it("'poné el aire a 22' takes the captured 22 in the current mode; 25 wasn't captured", () => {
    expect(ok(validateAction(AC, { type: "temperature", value: 22 }))).toMatchObject({
      command: "preset_cool_22",
    });
    const r = validateAction(AC, { type: "temperature", value: 25 });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.message).toMatch(/Frío · 24 °C/);
    expect(
      ok(validateAction(AC, { type: "temperature", value: -2, relative: true })),
    ).toMatchObject({ command: "preset_cool_22" });
  });

  it("mode words and off map to captured settings", () => {
    expect(ok(validateAction(AC, { type: "hvac_mode", value: "calor" }))).toMatchObject({
      command: "preset_heat_22",
    });
    expect(ok(validateAction(AC, { type: "power", value: false }))).toMatchObject({
      command: "power_off",
    });
  });

  it("the state after sending is estimated, and a toggle leaves on/off unknown", () => {
    const at = "2026-10-22T12:00:00.000Z";
    const acCap = AC.capabilities[0] as IrCapability;
    const s = estimateIr(
      {},
      acCap,
      { type: "ir", device: "x", command: "preset_heat_22", repeats: 1 },
      at,
    );
    expect(s).toMatchObject({ on: true, hvacMode: "heat", targetTemperature: 22, estimated: true });
    const tvCap = TV.capabilities[0] as IrCapability;
    const t = estimateIr(
      { on: true },
      tvCap,
      { type: "ir", device: "x", command: "power_toggle", repeats: 1 },
      at,
    );
    expect(t.on).toBeUndefined();
    expect(describeState({ ...TV, state: t }, "es")).toBe("Último botón: Encender/apagar");
    expect(describeState({ ...AC, state: s }, "es")).toMatch(/estimado/);
  });

  it("names are safe for the engine", () => {
    expect(irDeviceName("0123ABCD-89ab-4cde-8f00-112233445566")).toBe("elise_0123abcd89ab");
    expect(presetKey({ hvacMode: "fan_only", fanMode: "Alta" })).toBe("preset_fan_only_alta");
    expect(presetKey({ hvacMode: "heat", temperature: 22.5 })).toBe("preset_heat_22_5");
  });

  it("'subí el volumen' alone is the computer; naming the TV goes to Hogar", () => {
    expect(sessionCommand("subí el volumen")).toBe("volume_up");
    expect(sessionCommand("subí el volumen de la tele")).toBeNull();
  });
});

describe("agregar por IP: only the home network", () => {
  it.each([
    ["192.168.1.40", "192.168.1.40"],
    ["10.0.0.7", "10.0.0.7"],
    ["172.20.3.4", "172.20.3.4"],
    ["broadlink.local", "broadlink.local"],
    ["8.8.8.8", null],
    ["172.32.0.1", null],
    ["127.0.0.1", null],
    ["192.168.1.255", null],
    ["localhost", null],
    ["http://192.168.1.40", null],
    ["192.168.1.40:80", null],
    ["evil.com", null],
  ])("%s → %s", (input, out) => expect(lanHost(input)).toBe(out));
});

// ── The hub: learning and sending on a simulated engine ───────────────────────

function hub() {
  const a = new HubAgent(
    { eliseUrl: "https://elise.example", haUrl: "http://localhost:8123", hubToken: "ehh_x" },
    "ha-token",
  );
  const calls: { service: string; data?: unknown; timeout?: number }[] = [];
  const results: { status: string; error?: string; state?: unknown }[] = [];
  const reg = normalizeRegistry(BL_STATES, BL_ENTRIES, NAMES);
  let remoteState = "on";
  let learn: () => Promise<unknown> = async () => undefined;
  const internals = a as unknown as {
    devices: Map<string, unknown>;
    connected: boolean;
    ha: {
      callService: (c: { service: string; service_data?: unknown }, t?: number) => Promise<unknown>;
      states: () => Promise<HaState[]>;
      flowStart: (h: string) => Promise<unknown>;
      flowStep: (id: string) => Promise<unknown>;
      flowSubmit: (id: string, a: unknown) => Promise<unknown>;
    };
    cloud: {
      result: (id: string, r: { status: string }) => Promise<unknown>;
      sync: () => Promise<unknown>;
    };
  };
  internals.devices = new Map(reg.devices.map((d) => [d.providerKey, d]));
  internals.connected = true;
  internals.ha.callService = async (c, timeout) => {
    calls.push({ service: c.service, data: c.service_data, timeout });
    if (c.service === "turn_on") remoteState = "on";
    if (c.service === "learn_command") return learn();
  };
  internals.ha.states = async () =>
    BL_STATES.map((s) =>
      s.entity_id === "remote.rm4_mini_living" ? { ...s, state: remoteState } : s,
    );
  internals.cloud.result = async (_id, r) => void results.push(r);
  internals.cloud.sync = async () => ({ devices: 1, rooms: 1 });
  return {
    a,
    calls,
    results,
    internals,
    setRemote: (s: string) => (remoteState = s),
    onLearn: (f: () => Promise<unknown>) => (learn = f),
  };
}

describe("the hub learns and sends infrared", () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const DEV = "elise_0123456789ab";

  it("learns with a long wait, switching the controller's listening on first if it was off", async () => {
    const h = hub();
    h.setRemote("off");
    expect(await h.a.learnIr("bl1", DEV, "mute")).toEqual({ ok: true });
    expect(h.calls.map((c) => c.service)).toEqual(["turn_on", "learn_command"]);
    expect(h.calls[1]).toMatchObject({
      data: { device: DEV, command: ["mute"], command_type: "ir", timeout: 30 },
      timeout: 45_000,
    });
  });

  it("no button pressed → no_signal; one learning at a time per controller", async () => {
    const h = hub();
    h.onLearn(async () => {
      throw new Error("home_assistant_error");
    });
    expect(await h.a.learnIr("bl1", DEV, "mute")).toEqual({ ok: false, error: "no_signal" });
    let release!: () => void;
    h.onLearn(() => new Promise<void>((r) => (release = r)));
    const first = h.a.learnIr("bl1", DEV, "volume_up");
    await new Promise((r) => setTimeout(r, 0));
    expect(await h.a.learnIr("bl1", DEV, "volume_down")).toEqual({ ok: false, error: "busy" });
    release();
    expect(await first).toEqual({ ok: true });
  });

  it("never learns on something that isn't a controller, nor under an unsafe name", async () => {
    const h = hub();
    expect(await h.a.learnIr("tv1", DEV, "mute")).toEqual({ ok: false, error: "not_found" });
    expect(await h.a.learnIr("bl1", "../x", "mute")).toEqual({ ok: false, error: "bad_name" });
    expect(await h.a.learnIr("bl1", DEV, "MUTE; rm")).toEqual({ ok: false, error: "bad_name" });
    h.setRemote("unavailable");
    expect(await h.a.learnIr("bl1", DEV, "mute")).toEqual({ ok: false, error: "offline" });
    expect(h.calls.filter((c) => c.service === "learn_command")).toEqual([]);
  });

  it("sends a code to its controller and reports no fake state", async () => {
    const h = hub();
    await h.a.execute({
      id: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      target: { providerKey: "bl1", entityIds: ["remote.rm4_mini_living"] },
      actions: [{ type: "ir", device: DEV, command: "mute", repeats: 1 }],
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(h.calls).toEqual([
      {
        service: "send_command",
        data: { device: DEV, command: "mute", num_repeats: 1 },
        timeout: undefined,
      },
    ]);
    expect(h.results.at(-1)).toEqual({ status: "succeeded", latencyMs: expect.any(Number) });
  });

  it("mixing a code with another action, or a code for a non-controller, never runs", async () => {
    const h = hub();
    await h.a.execute({
      id: "33333333-3333-4333-8333-333333333333",
      deviceId: "22222222-2222-4222-8222-222222222222",
      target: { providerKey: "bl1", entityIds: ["remote.rm4_mini_living"] },
      actions: [{ type: "ir", device: DEV, command: "mute", repeats: 1 }, { type: "remove" }],
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(h.calls).toEqual([]);
    expect(h.results.at(-1)).toMatchObject({ status: "failed", error: "UNKNOWN_TARGET" });
  });

  it("agregar por IP: only a LAN address; the host goes into the engine's own setup", async () => {
    const h = hub();
    const flowId = "abcdef0123456789";
    const submitted: unknown[] = [];
    h.internals.ha.flowStart = async () => ({
      type: "form",
      flow_id: flowId,
      data_schema: [{ name: "host", type: "string", required: true }],
    });
    h.internals.ha.flowStep = async () => ({
      type: "form",
      flow_id: flowId,
      data_schema: [{ name: "host", type: "string", required: true }],
    });
    h.internals.ha.flowSubmit = async (_id, answers) => {
      submitted.push(answers);
      return {
        type: "form",
        flow_id: flowId,
        step_id: "finish",
        data_schema: [{ name: "name", type: "string" }],
      };
    };
    expect(await h.a.addBroadlink("8.8.8.8")).toEqual({ kind: "aborted", reason: "invalid_host" });
    const step = await h.a.addBroadlink(" 192.168.1.40 ");
    expect(submitted).toEqual([{ host: "192.168.1.40" }]);
    expect(step).toMatchObject({ kind: "form", flowId, fields: [{ name: "name" }] });
  });
});

// ── The cloud: an infrared device is the person's, on their own controller ────

const WS = "ws-1";
let db: FakeSupabase;
let auth: AuthContext;

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  db.defaults.homes = { created_at: new Date().toISOString() };
  db.defaults.home_hubs = {
    revoked_at: null,
    last_seen_at: null,
    provider_connected: false,
    runtime_state: "initializing",
    protocol_version: 1,
    last_sync_at: null,
    created_at: new Date().toISOString(),
  };
  db.defaults.home_pairing_codes = { used_at: null };
  db.defaults.home_devices = {
    aliases: [],
    favorite: false,
    hidden: false,
    removed_at: null,
    room_override: false,
    added_at: new Date().toISOString(),
  };
  db.defaults.home_commands = {
    status: "queued",
    created_at: new Date().toISOString(),
    error_code: null,
    result: null,
  };
  auth = {
    db,
    workspaceId: WS,
    userId: "user-1",
    profile: { locale: "es", timezone: "America/Argentina/Buenos_Aires" },
  } as unknown as AuthContext;
});

async function homeWithBroadlink() {
  const { code } = await service.createPairingCode(auth);
  const paired = await service.redeemPairingCode({
    code,
    agentVersion: "0.1.0",
    protocolVersion: 1,
  });
  const hub = await service.authenticateHub(`Bearer ${paired.token}`);
  const reg = normalizeRegistry(BL_STATES, BL_ENTRIES, NAMES);
  await service.hubSync(hub, reg);
  await service.hubHeartbeat(hub, { providerConnected: true, runtimeState: "ready" });
  const controller = db.rows("home_devices").find((d) => d.device_type === "ir_controller")!;
  return { hub, controller, reg };
}

describe("infrared devices in ELISE Cloud", () => {
  it("created on the person's own controller; a sync never removes it", async () => {
    const { hub, controller, reg } = await homeWithBroadlink();
    const { id, device: name } = await service.createIrDevice(auth, {
      name: "TV living",
      kind: "tv",
      controllerId: controller.id,
      roomId: null,
    });
    expect(name).toBe(irDeviceName(id));
    await service.hubSync(hub, reg);
    const row = db.rows("home_devices").find((d) => d.id === id)!;
    expect(row).toMatchObject({
      provider_key: `ir:${id}`,
      device_type: "media_player",
      removed_at: null,
    });
    // The hub can't claim ELISE's own keys.
    await expect(
      service.hubSync(hub, {
        rooms: [],
        devices: [{ ...reg.devices[0]!, providerKey: `ir:${id}` }],
      }),
    ).rejects.toThrow();
  });

  it("an unknown controller (or another workspace's) is refused", async () => {
    await homeWithBroadlink();
    await expect(
      service.createIrDevice(auth, {
        name: "TV",
        kind: "tv",
        controllerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        roomId: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("buttons: saved unverified, confirmed, dropped", async () => {
    const { controller } = await homeWithBroadlink();
    const { id } = await service.createIrDevice(auth, {
      name: "TV",
      kind: "tv",
      controllerId: controller.id,
      roomId: null,
    });
    await service.updateIrCommands(auth, id, {
      op: "save",
      command: { key: "mute", label: "Silencio", verified: false },
    });
    const v = await service.updateIrCommands(auth, id, { op: "verify", key: "mute", worked: true });
    expect(v.commands).toEqual([{ key: "mute", label: "Silencio", verified: true }]);
    await expect(
      service.updateIrCommands(auth, id, {
        op: "save",
        command: { key: "bad key!", label: "x", verified: false },
      }),
    ).rejects.toThrow();
    expect(
      (await service.updateIrCommands(auth, id, { op: "delete", key: "mute" })).commands,
    ).toEqual([]);
  });

  it("its command reaches the hub aimed at its controller; then the state is estimated", async () => {
    const { hub, controller } = await homeWithBroadlink();
    const { id, device: name } = await service.createIrDevice(auth, {
      name: "TV",
      kind: "tv",
      controllerId: controller.id,
      roomId: null,
    });
    await service.updateIrCommands(auth, id, {
      op: "save",
      command: { key: "power_on", label: "Encender", verified: true },
    });
    const sent = service.executeHomeCommands(auth, [
      { deviceId: id, actions: [{ type: "ir", device: name, command: "power_on", repeats: 1 }] },
    ]);
    // The hub picks it up as its own controller's command.
    let claimed: Awaited<ReturnType<typeof service.hubClaimCommands>> = [];
    for (let i = 0; i < 20 && !claimed.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      claimed = await service.hubClaimCommands(hub, 0);
    }
    expect(claimed[0]).toMatchObject({
      deviceId: id,
      target: { providerKey: "bl1", entityIds: controller.provider_entity_ids },
    });
    await service.hubReportResult(hub, claimed[0]!.id, { status: "succeeded" });
    const [outcome] = await sent;
    expect(outcome).toMatchObject({ status: "succeeded", state: { on: true, estimated: true } });
    expect(db.rows("home_devices").find((d) => d.id === id)!.state).toMatchObject({
      on: true,
      lastSent: { command: "power_on" },
    });
  });

  it("removing it never removes the Broadlink from the engine", async () => {
    const { controller } = await homeWithBroadlink();
    const { id } = await service.createIrDevice(auth, {
      name: "TV",
      kind: "tv",
      controllerId: controller.id,
      roomId: null,
    });
    expect(await service.removeHomeDevice(auth, id)).toEqual({ removed: true });
    expect(db.rows("home_commands")).toEqual([]);
    expect(db.rows("home_devices").find((d) => d.id === controller.id)!.removed_at).toBeNull();
  });
});
