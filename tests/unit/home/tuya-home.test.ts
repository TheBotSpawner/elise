import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { validateAction, type HomeDevice, type TuyaIrCapability } from "@/core/home/model";
import { meaningOf, remoteCapability, tuyaTestAction } from "@/core/home/tuya";

import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * ADR-118: Smart Life remotes as ELISE devices — Tuya's keys and ranges mapped to what voice and
 * Hogar ask for, imported once per workspace (never another workspace's account), not
 * duplicated, sent through Tuya without the hub, and leaving Broadlink/engine devices alone.
 * Tuya's cloud is mocked here: none of this is a test against Tuya or a device.
 */

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: null as unknown,
  env: {
    TUYA_ENABLED: "true",
    TUYA_CLIENT_ID: "client",
    TUYA_CLIENT_SECRET: "secret",
    TUYA_REGION: "us",
    TUYA_DEV_UID: "uid-mine",
    TUYA_DEV_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
  } as Record<string, string | undefined>,
}));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/config/server-env", () => ({ serverEnv: () => state.env }));
const tuya = vi.hoisted(() => ({
  tuyaUserDevices: vi.fn(),
  tuyaRemotes: vi.fn(),
  tuyaRemoteKeys: vi.fn(),
  tuyaSendKey: vi.fn(),
  tuyaSendAc: vi.fn(),
}));
vi.mock("@/infrastructure/home/tuya", () => ({
  ...tuya,
  tuyaEnabled: () => state.env.TUYA_ENABLED === "true",
  tuyaConfig: () =>
    state.env.TUYA_ENABLED === "true" && state.env.TUYA_CLIENT_ID
      ? { clientId: "client", secret: "secret", host: "h", region: "us" }
      : null,
}));

const { executeHomeCommands, hubSync, redeemPairingCode, createPairingCode, authenticateHub } =
  await import("@/application/home-service");
const { tuyaImport, tuyaLink, tuyaOverview } = await import("@/application/tuya-home-service");

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";

const TV_KEYS = {
  category_id: 2,
  key_list: [
    { key: "Power", key_id: 1, key_name: "Power" },
    { key: "Mute", key_id: 2, key_name: "Mute" },
    { key: "Vol+", key_id: 3, key_name: "Volume +" },
    { key: "Vol-", key_id: 4, key_name: "Volume -" },
    { key: "1", key_id: 5, key_name: "1" },
  ],
};
const AC_KEYS = {
  category_id: 5,
  key_list: [{ key: "power", key_id: 1 }],
  key_range: [
    {
      mode: 0,
      temp_list: [16, 24, 30].map((temp) => ({ temp, fan_list: [{ fan: 0 }, { fan: 3 }] })),
    },
    { mode: 1, temp_list: [{ temp: 22, fan_list: [{ fan: 1 }] }] },
  ],
};
const TV_REMOTE = {
  remote_id: "rm_tv_01",
  remote_name: "Tele Pieza",
  category_id: 2,
  brand_name: "Samsung",
  remote_index: 3,
};
const AC_REMOTE = { remote_id: "rm_ac_01", remote_name: "Aire", category_id: 5, brand_name: "BGH" };

const device = (cap: TuyaIrCapability, state = {}) =>
  ({ name: "Tele", type: "media_player", state, capabilities: [cap] }) as unknown as HomeDevice;

describe("mapping Tuya's remotes", () => {
  it("keys get ELISE's meanings; a TV's single Power is a toggle, never a promised off", () => {
    const tv = remoteCapability("ir_hub_01", TV_REMOTE, TV_KEYS)!;
    expect(tv).toMatchObject({ kind: "tv", categoryId: 2, remoteIndex: 3 });
    expect(tv.keys.map((k) => [k.key, k.tuya])).toEqual([
      ["power_toggle", "Power"],
      ["mute", "Mute"],
      ["volume_up", "Vol+"],
      ["volume_down", "Vol-"],
      ["num_1", "1"],
    ]);
    const off = validateAction(device(tv), { type: "power", value: false });
    expect(off.ok).toBe(false);
    const mute = validateAction(device(tv), { type: "button", value: "mute" });
    expect(mute.ok && mute.action).toEqual({
      type: "tuya_key",
      command: "mute",
      tuya: "Mute",
      keyId: 2,
      repeats: 1,
    });
    const louder = validateAction(device(tv), { type: "volume", value: 10, relative: true });
    expect(louder.ok && louder.action).toMatchObject({
      type: "tuya_key",
      tuya: "Vol+",
      repeats: 2,
    });
    expect(tuyaTestAction(tv)).toEqual({ type: "button", value: "mute" });
    expect(meaningOf("power_off")).toBe("power_off");
  });

  it("an air conditioner takes any listed mode/temperature/fan, and nothing outside them", () => {
    const ac = remoteCapability("ir_hub_01", AC_REMOTE, AC_KEYS)!;
    expect(ac.ac?.modes).toEqual([
      { mode: "cool", temps: [16, 24, 30], fans: ["auto", "high"] },
      { mode: "heat", temps: [22], fans: ["low"] },
    ]);
    const d = device(ac, { hvacMode: "cool", targetTemperature: 24 });
    const set = validateAction(d, { type: "temperature", value: 30 });
    expect(set.ok && set.action).toEqual({ type: "tuya_ac", power: true, mode: "cool", temp: 30 });
    expect(validateAction(d, { type: "temperature", value: 25 })).toMatchObject({
      ok: false,
      code: "out_of_range",
    });
    const heat = validateAction(d, { type: "hvac_mode", value: "calor" });
    expect(heat.ok && heat.action).toEqual({ type: "tuya_ac", power: true, mode: "heat" });
    expect(validateAction(d, { type: "power", value: false })).toMatchObject({
      ok: true,
      action: { type: "tuya_ac", power: false },
    });
    expect(validateAction(d, { type: "fan_mode", value: "alta" })).toMatchObject({
      ok: true,
      action: { fan: "high", mode: "cool" },
    });
    expect(validateAction(d, { type: "fan_mode", value: "baja" }).ok).toBe(false);
  });

  it("a remote with nothing usable isn't a device", () => {
    expect(remoteCapability("ir_hub_01", TV_REMOTE, { key_list: [] })).toBeNull();
  });
});

let db: FakeSupabase;
const authFor = (workspaceId: string) =>
  ({
    db,
    workspaceId,
    userId: "user-1",
    profile: { locale: "es", timezone: "America/Argentina/Buenos_Aires" },
  }) as unknown as AuthContext;

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  state.env.TUYA_ENABLED = "true";
  state.env.TUYA_DEV_WORKSPACE_ID = WS;
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
    room_id: null,
    display_name: null,
    state_updated_at: null,
    created_at: new Date().toISOString(),
  };
  for (const f of Object.values(tuya)) f.mockReset();
  tuya.tuyaUserDevices.mockResolvedValue([
    { id: "ir_hub_01", name: "Smart IR", category: "wnykq", online: true, sub: false },
    { id: "plug_0001", name: "Enchufe", category: "cz", online: true, sub: false },
  ]);
  tuya.tuyaRemotes.mockResolvedValue([TV_REMOTE, AC_REMOTE]);
  tuya.tuyaRemoteKeys.mockImplementation(async (_: string, remoteId: string) =>
    remoteId === "rm_ac_01" ? AC_KEYS : TV_KEYS,
  );
});

async function hubFor(workspaceId: string) {
  const { code } = await createPairingCode(authFor(workspaceId));
  const paired = await redeemPairingCode({ code, agentVersion: "0.1.0", protocolVersion: 1 });
  return authenticateHub(`Bearer ${paired.token}`);
}

describe("linking and isolation", () => {
  it("off by default: nothing is offered", () => {
    state.env.TUYA_ENABLED = "false";
    expect(tuyaLink(authFor(WS))).toEqual({ state: "off" });
  });

  it("only the configured workspace sees the linked account; others get the blocked state", async () => {
    expect(tuyaLink(authFor(WS))).toEqual({ state: "linked", region: "us" });
    expect(tuyaLink(authFor(OTHER_WS))).toEqual({ state: "not_linked" });
    await expect(tuyaOverview(authFor(OTHER_WS))).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(tuya.tuyaUserDevices).not.toHaveBeenCalled();
  });

  it("lists the hub → its remotes (only infrared hubs)", async () => {
    await hubFor(WS);
    const { hubs } = await tuyaOverview(authFor(WS));
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.remotes.map((r) => [r.name, r.kind, r.deviceId])).toEqual([
      ["Tele Pieza", "tv", null],
      ["Aire", "ac", null],
    ]);
    expect(tuya.tuyaUserDevices).toHaveBeenCalledWith("uid-mine");
  });

  it("a remote of an account that isn't this workspace's can't be imported or sent to", async () => {
    await hubFor(WS);
    const out = await tuyaImport(authFor(WS), [
      { infraredId: "ir_someone_else", remoteId: "rm_tv_01" },
    ]);
    expect(out).toMatchObject({ added: [], skipped: [{ reason: "not_found" }] });
    // A member edits a row to point at someone else's hub: the send is refused, nothing goes out.
    await tuyaImport(authFor(WS), [{ infraredId: "ir_hub_01", remoteId: "rm_tv_01" }]);
    const row = db.rows("home_devices")[0]!;
    (row.capabilities as TuyaIrCapability[])[0]!.infraredId = "ir_someone_else";
    const [o] = await executeHomeCommands(authFor(WS), [
      {
        deviceId: row.id as string,
        actions: [{ type: "tuya_key", command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ]);
    expect(o).toMatchObject({ status: "unavailable", error: "tuya_not_linked" });
    expect(tuya.tuyaSendKey).not.toHaveBeenCalled();
  });
});

describe("importing and sending", () => {
  it("imports ready devices (no learning); importing again doesn't duplicate", async () => {
    await hubFor(WS);
    const refs = [
      { infraredId: "ir_hub_01", remoteId: "rm_tv_01" },
      { infraredId: "ir_hub_01", remoteId: "rm_ac_01" },
    ];
    const first = await tuyaImport(authFor(WS), refs);
    expect(first.added.map((a) => [a.name, a.test])).toEqual([
      ["Tele Pieza", { type: "button", value: "mute" }],
      ["Aire", { type: "power", value: true }],
    ]);
    await tuyaImport(authFor(WS), refs);
    const rows = db.rows("home_devices");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.provider_key, r.device_type, r.workspace_id])).toEqual([
      ["tuya:ir_hub_01:rm_tv_01", "media_player", WS],
      ["tuya:ir_hub_01:rm_ac_01", "climate", WS],
    ]);
    const { hubs } = await tuyaOverview(authFor(WS));
    expect(hubs[0]!.remotes.every((r) => r.deviceId)).toBe(true);
  });

  it("a remote named like a device already in the home (e.g. from the engine) is flagged, not duplicated", async () => {
    const hub = await hubFor(WS);
    await hubSync(hub, {
      rooms: [],
      devices: [
        {
          providerKey: "dev_tv",
          providerDeviceId: "dev_tv",
          entityIds: ["media_player.tele"],
          name: "Tele Pieza",
          areaId: null,
          type: "media_player",
          capabilities: [{ type: "power" }],
          state: {},
          available: true,
          stateUpdatedAt: null,
        },
      ],
    });
    db.rows("home_devices")[0]!.added_at = new Date().toISOString();
    const { hubs } = await tuyaOverview(authFor(WS));
    expect(hubs[0]!.remotes[0]).toMatchObject({ name: "Tele Pieza", sameAs: "Tele Pieza" });
    expect(hubs[0]!.remotes[1]!.sameAs).toBeNull();
  });

  it("commands go through Tuya even with the hub offline, and update the estimated state", async () => {
    await hubFor(WS); // never beat: offline
    await tuyaImport(authFor(WS), [{ infraredId: "ir_hub_01", remoteId: "rm_ac_01" }]);
    const id = db.rows("home_devices")[0]!.id as string;
    const [o] = await executeHomeCommands(authFor(WS), [
      { deviceId: id, actions: [{ type: "tuya_ac", power: true, mode: "cool", temp: 24 }] },
    ]);
    expect(o).toMatchObject({
      status: "succeeded",
      state: { on: true, hvacMode: "cool", targetTemperature: 24, estimated: true },
    });
    expect(tuya.tuyaSendAc).toHaveBeenCalledWith({
      infraredId: "ir_hub_01",
      remoteId: "rm_ac_01",
      categoryId: 5,
      power: true,
      mode: "cool",
      temp: 24,
    });
    expect(db.rows("home_commands")).toHaveLength(0);
  });

  it("an offline Tuya hub isn't sent to; a Tuya error is a failure, not a success", async () => {
    await hubFor(WS);
    await tuyaImport(authFor(WS), [{ infraredId: "ir_hub_01", remoteId: "rm_tv_01" }]);
    const id = db.rows("home_devices")[0]!.id as string;
    const press = [
      {
        deviceId: id,
        actions: [{ type: "tuya_key" as const, command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ];
    tuya.tuyaSendKey.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "RATE_LIMITED" }));
    expect((await executeHomeCommands(authFor(WS), press))[0]!.status).toBe("failed");
    tuya.tuyaUserDevices.mockResolvedValue([
      { id: "ir_hub_01", name: "Smart IR", category: "wnykq", online: false, sub: false },
    ]);
    expect((await executeHomeCommands(authFor(WS), press))[0]!.status).toBe("unavailable");
  });

  it("the engine's sync never removes a Smart Life remote (Broadlink/engine devices unchanged)", async () => {
    const hub = await hubFor(WS);
    await tuyaImport(authFor(WS), [{ infraredId: "ir_hub_01", remoteId: "rm_tv_01" }]);
    const LAMP = {
      providerKey: "dev_lamp",
      providerDeviceId: "dev_lamp",
      entityIds: ["light.lamp"],
      name: "Lámpara",
      areaId: null,
      type: "light" as const,
      capabilities: [{ type: "power" as const }],
      state: {},
      available: true,
      stateUpdatedAt: null,
    };
    await hubSync(hub, { rooms: [], devices: [LAMP] });
    await hubSync(hub, {
      rooms: [],
      devices: [{ ...LAMP, providerKey: "dev_other", name: "Otra" }],
    });
    const rows = db.rows("home_devices");
    expect(rows.find((r) => r.provider_key === "tuya:ir_hub_01:rm_tv_01")!.removed_at).toBeNull();
    expect(rows.find((r) => r.provider_key === "dev_lamp")!.removed_at).not.toBeNull();
  });
});
