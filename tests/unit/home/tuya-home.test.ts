import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { validateAction, type HomeDevice, type TuyaIrCapability } from "@/core/home/model";
import { meaningOf, remoteCapability, tuyaTestAction } from "@/core/home/tuya";

import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * ADR-118/119: Smart Life as each person's own account. OAuth bound to the session, the browser
 * and the data center; two people (A and B, two workspaces) who never see or control each
 * other's devices, whatever ids they send; import without re-learning and without an ELISE Home
 * hub; disconnect that only touches that account; refresh and sync. Tuya's cloud, the vault and
 * encryption are mocked: none of this is a test against Tuya or a device.
 */

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: null as unknown,
  env: {
    TUYA_ENABLED: "true",
    TUYA_CLIENT_ID: "client",
    TUYA_CLIENT_SECRET: "secret",
    TUYA_OAUTH_URL_US: "https://h5.example-tuya.test/auth?client_id=client&redirect_uri=x",
    TUYA_OAUTH_URL_EU: "https://h5-eu.example-tuya.test/auth?client_id=client",
  } as Record<string, string | undefined>,
  vault: new Map<string, unknown>(),
  leases: new Set<string>(),
}));
// The rate limiter has its own tests; here every flow starts fresh.
vi.mock("@/infrastructure/rate-limit", () => ({ rateLimit: () => undefined }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/config/server-env", () => ({ serverEnv: () => state.env }));
vi.mock("@/infrastructure/crypto/encryption", () => ({
  encrypt: (s: string, ctx: string) => `${ctx}|${s}`,
  decrypt: (s: string, ctx: string) => {
    if (!s.startsWith(`${ctx}|`)) throw new Error("wrong context");
    return s.slice(ctx.length + 1);
  },
}));
vi.mock("@/infrastructure/providers/google/connection-vault", () => ({
  SupabaseCredentialVault: class {
    async read(ref: { connectionId: string; workspaceId: string }) {
      return state.vault.get(`${ref.workspaceId}:${ref.connectionId}`) ?? null;
    }
    async write(ref: { connectionId: string; workspaceId: string }, c: unknown) {
      state.vault.set(`${ref.workspaceId}:${ref.connectionId}`, c);
    }
    async remove(ref: { connectionId: string; workspaceId: string }) {
      state.vault.delete(`${ref.workspaceId}:${ref.connectionId}`);
    }
    async acquireRefreshLease(ref: { connectionId: string }) {
      if (state.leases.has(ref.connectionId)) return false;
      state.leases.add(ref.connectionId);
      return true;
    }
    async releaseRefreshLease(ref: { connectionId: string }) {
      state.leases.delete(ref.connectionId);
    }
  },
}));

class FakeTuyaError extends Error {
  code = "PROVIDER_UNAVAILABLE";
  constructor(readonly problem: string) {
    super(problem);
  }
}
const tuya = vi.hoisted(() => ({
  exchangeTuyaCode: vi.fn(),
  refreshTuyaToken: vi.fn(),
  tuyaUserDevices: vi.fn(),
  tuyaRemotes: vi.fn(),
  tuyaRemoteKeys: vi.fn(),
  tuyaSendKey: vi.fn(),
  tuyaSendAc: vi.fn(),
  forgetTuyaAccount: vi.fn(),
}));
vi.mock("@/infrastructure/home/tuya", () => ({
  ...tuya,
  TuyaError: FakeTuyaError,
  tuyaEnabled: () => state.env.TUYA_ENABLED === "true",
  tuyaConfig: () =>
    state.env.TUYA_ENABLED === "true" && state.env.TUYA_CLIENT_ID
      ? { clientId: "client", secret: "secret" }
      : null,
}));

const { executeHomeCommands, hubSync, redeemPairingCode, createPairingCode, authenticateHub } =
  await import("@/application/home-service");
const {
  completeTuyaConnection,
  disconnectTuya,
  startTuyaConnection,
  tuyaAuthorizationUrl,
  tuyaAvailability,
  tuyaConnections,
} = await import("@/application/tuya-connection-service");
const { syncTuya, tuyaImport, tuyaOverview } = await import("@/application/tuya-home-service");

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
const CONN = "33333333-3333-4333-8333-333333333333";

const device = (cap: TuyaIrCapability, s = {}) =>
  ({ name: "Tele", type: "media_player", state: s, capabilities: [cap] }) as unknown as HomeDevice;

describe("mapping Tuya's remotes", () => {
  it("keys get ELISE's meanings; a TV's single Power is a toggle, never a promised off", () => {
    const tv = remoteCapability(CONN, "ir_hub_a1", TV_REMOTE, TV_KEYS)!;
    expect(tv).toMatchObject({ kind: "tv", categoryId: 2, remoteIndex: 3, connectionId: CONN });
    expect(tv.keys.map((k) => [k.key, k.tuya])).toEqual([
      ["power_toggle", "Power"],
      ["mute", "Mute"],
      ["volume_up", "Vol+"],
      ["volume_down", "Vol-"],
      ["num_1", "1"],
    ]);
    expect(validateAction(device(tv), { type: "power", value: false }).ok).toBe(false);
    const mute = validateAction(device(tv), { type: "button", value: "mute" });
    expect(mute.ok && mute.action).toEqual({
      type: "tuya_key",
      command: "mute",
      tuya: "Mute",
      keyId: 2,
      repeats: 1,
    });
    // "subí el volumen" (Rioplatense, relative): steps of the Vol+ key.
    const louder = validateAction(device(tv), { type: "volume", value: 10, relative: true });
    expect(louder.ok && louder.action).toMatchObject({
      type: "tuya_key",
      tuya: "Vol+",
      repeats: 2,
    });
    expect(tuyaTestAction(tv)).toEqual({ type: "button", value: "mute" });
    expect(meaningOf("power_off")).toBe("power_off");
  });

  it("an AC takes any listed mode/temperature/fan ('poné el aire en calor'), nothing outside", () => {
    const ac = remoteCapability(CONN, "ir_hub_a1", AC_REMOTE, AC_KEYS)!;
    expect(ac.ac?.modes).toEqual([
      { mode: "cool", temps: [16, 24, 30], fans: ["auto", "high"] },
      { mode: "heat", temps: [22], fans: ["low"] },
    ]);
    const d = device(ac, { hvacMode: "cool", targetTemperature: 24 });
    expect(validateAction(d, { type: "temperature", value: 30 })).toMatchObject({
      ok: true,
      action: { type: "tuya_ac", power: true, mode: "cool", temp: 30 },
    });
    expect(validateAction(d, { type: "temperature", value: 25 })).toMatchObject({
      ok: false,
      code: "out_of_range",
    });
    expect(validateAction(d, { type: "hvac_mode", value: "calor" })).toMatchObject({
      ok: true,
      action: { type: "tuya_ac", power: true, mode: "heat" },
    });
    expect(validateAction(d, { type: "power", value: "apagá" })).toMatchObject({
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
    expect(remoteCapability(CONN, "ir_hub_a1", TV_REMOTE, { key_list: [] })).toBeNull();
  });
});

let db: FakeSupabase;
const authFor = (workspaceId: string, userId: string) =>
  ({
    db,
    workspaceId,
    userId,
    profile: { locale: "es", timezone: "America/Argentina/Buenos_Aires" },
  }) as unknown as AuthContext;
const A = () => authFor(WS_A, USER_A);
const B = () => authFor(WS_B, USER_B);

/** Each account has its own hub (A: ir_hub_a1, B: ir_hub_b1) with a TV and an AC. */
const DEVICES: Record<string, unknown[]> = {
  "uid-a": [
    { id: "ir_hub_a1", name: "Smart IR A", category: "wnykq", online: true, sub: false },
    { id: "plug_a001", name: "Enchufe", category: "cz", online: true, sub: false },
  ],
  "uid-b": [{ id: "ir_hub_b1", name: "Smart IR B", category: "wnykq", online: true, sub: false }],
};

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  state.vault.clear();
  state.leases.clear();
  state.env.TUYA_ENABLED = "true";
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
  db.defaults.oauth_states = { expires_at: new Date(Date.now() + 600_000).toISOString() };
  db.defaults.provider_connections = {
    created_at: new Date().toISOString(),
    last_error_code: null,
    last_health_check_at: null,
  };
  for (const f of Object.values(tuya)) f.mockReset();
  tuya.exchangeTuyaCode.mockImplementation(async (_region: string, code: string) => ({
    accessToken: `token-${code}`,
    refreshToken: `refresh-${code}`,
    expiresAt: new Date(Date.now() + 3600_000),
    uid: code === "code-b" ? "uid-b" : "uid-a",
  }));
  tuya.tuyaUserDevices.mockImplementation(
    async (_auth: unknown, uid: string) => DEVICES[uid] ?? [],
  );
  tuya.tuyaRemotes.mockImplementation(async (_auth: unknown, hub: string) =>
    hub.startsWith("ir_hub_") ? [TV_REMOTE, AC_REMOTE] : [],
  );
  tuya.tuyaRemoteKeys.mockImplementation(async (_a: unknown, _h: string, remoteId: string) =>
    remoteId === "rm_ac_01" ? AC_KEYS : TV_KEYS,
  );
});

/** The whole OAuth round trip, as the browser does it: start → /go (cookie) → callback. */
async function connect(auth: AuthContext, code: string, region = "us") {
  const go = new URL(await startTuyaConnection(auth, { region, origin: "https://elise.test" }));
  const s = go.searchParams.get("s")!;
  const h5 = new URL(await tuyaAuthorizationUrl(s));
  expect(h5.searchParams.get("state")).toBe(s);
  const done = await completeTuyaConnection({
    pathRegion: region,
    code,
    state: s,
    cookieState: s,
    sessionUserId: auth.userId,
  });
  return done.connectionId;
}

describe("availability", () => {
  it("off by default; 'not yet' without Tuya's authorization links; regions that have one", () => {
    state.env.TUYA_ENABLED = "false";
    expect(tuyaAvailability()).toEqual({ state: "off" });
    state.env.TUYA_ENABLED = "true";
    expect(tuyaAvailability()).toEqual({ state: "available", regions: ["us", "eu"] });
    const saved = { us: state.env.TUYA_OAUTH_URL_US, eu: state.env.TUYA_OAUTH_URL_EU };
    state.env.TUYA_OAUTH_URL_US = undefined;
    state.env.TUYA_OAUTH_URL_EU = undefined;
    expect(tuyaAvailability()).toEqual({ state: "unavailable" });
    state.env.TUYA_OAUTH_URL_US = saved.us;
    state.env.TUYA_OAUTH_URL_EU = saved.eu;
  });
});

describe("OAuth: the person's own account, bound to their session and browser", () => {
  it("connects: Tuya's official page with ELISE's state, code exchanged in that data center", async () => {
    const id = await connect(A(), "code-a");
    expect(tuya.exchangeTuyaCode).toHaveBeenCalledWith("us", "code-a");
    const [c] = await tuyaConnections(A());
    expect(c).toMatchObject({ id, region: "us", uid: "uid-a", status: "connected" });
    expect(state.vault.get(`${WS_A}:${id}`)).toMatchObject({ refreshToken: "refresh-code-a" });
    // The token is never stored in the connection row (only in the vault).
    expect(JSON.stringify(db.rows("provider_connections"))).not.toContain("token-code-a");
  });

  it("a callback without this browser's cookie, or with another state, is refused", async () => {
    const go = new URL(await startTuyaConnection(A(), { region: "us", origin: "https://e.test" }));
    const s = go.searchParams.get("s")!;
    const base = { pathRegion: "us", code: "code-a", sessionUserId: null };
    await expect(
      completeTuyaConnection({ ...base, state: s, cookieState: null }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      completeTuyaConnection({ ...base, state: "x".repeat(40), cookieState: s }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(tuya.exchangeTuyaCode).not.toHaveBeenCalled();
  });

  it("a flow is consumed once: a retried or concurrent callback never exchanges twice", async () => {
    const go = new URL(await startTuyaConnection(A(), { region: "us", origin: "https://e.test" }));
    const s = go.searchParams.get("s")!;
    const p = { pathRegion: "us", code: "code-a", state: s, cookieState: s, sessionUserId: null };
    const results = await Promise.allSettled([
      completeTuyaConnection(p),
      completeTuyaConnection(p),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(tuya.exchangeTuyaCode).toHaveBeenCalledTimes(1);
  });

  it("another data center's callback, or another signed-in person, is refused", async () => {
    let go = new URL(await startTuyaConnection(A(), { region: "us", origin: "https://e.test" }));
    let s = go.searchParams.get("s")!;
    await expect(
      completeTuyaConnection({
        pathRegion: "eu",
        code: "code-a",
        state: s,
        cookieState: s,
        sessionUserId: null,
      }),
    ).rejects.toMatchObject({ details: { tuyaProblem: "wrong_region" } });
    go = new URL(await startTuyaConnection(A(), { region: "us", origin: "https://e.test" }));
    s = go.searchParams.get("s")!;
    await expect(
      completeTuyaConnection({
        pathRegion: "us",
        code: "code-a",
        state: s,
        cookieState: s,
        sessionUserId: USER_B,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(tuya.exchangeTuyaCode).not.toHaveBeenCalled();
  });

  it("only offered data centers can be started", async () => {
    await expect(
      startTuyaConnection(A(), { region: "cn", origin: "https://e.test" }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });
});

describe("two people, two workspaces: A never sees or controls B's devices", () => {
  it("each lists only their own account's hubs, with their own uid", async () => {
    const a = await connect(A(), "code-a");
    const b = await connect(B(), "code-b");
    const viewA = await tuyaOverview(A(), a);
    const viewB = await tuyaOverview(B(), b);
    expect(viewA.hubs.map((h) => h.id)).toEqual(["ir_hub_a1"]);
    expect(viewB.hubs.map((h) => h.id)).toEqual(["ir_hub_b1"]);
    expect(viewA.otherDevices).toBe(1);
    const uids = tuya.tuyaUserDevices.mock.calls.map((c) => c[1]);
    expect(uids).toEqual(["uid-a", "uid-b"]);
  });

  it("B can't use A's connection id, nor import A's hub through their own connection", async () => {
    const a = await connect(A(), "code-a");
    const b = await connect(B(), "code-b");
    await expect(tuyaOverview(B(), a)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      tuyaImport(B(), {
        connectionId: a,
        remotes: [{ infraredId: "ir_hub_a1", remoteId: "rm_tv_01" }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const out = await tuyaImport(B(), {
      connectionId: b,
      remotes: [{ infraredId: "ir_hub_a1", remoteId: "rm_tv_01" }],
    });
    expect(out).toMatchObject({ added: [], skipped: [{ reason: "not_found" }] });
  });

  it("a device row edited to point at A's account or hub sends nothing", async () => {
    const a = await connect(A(), "code-a");
    const b = await connect(B(), "code-b");
    await tuyaImport(B(), {
      connectionId: b,
      remotes: [{ infraredId: "ir_hub_b1", remoteId: "rm_tv_01" }],
    });
    const row = db.rows("home_devices").find((r) => r.workspace_id === WS_B)!;
    const cap = (row.capabilities as TuyaIrCapability[])[0]!;
    const press = [
      {
        deviceId: row.id as string,
        actions: [{ type: "tuya_key" as const, command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ];
    cap.connectionId = a; // A's connection: not in B's workspace
    expect((await executeHomeCommands(B(), press))[0]).toMatchObject({
      status: "unavailable",
      error: "tuya_not_linked",
    });
    cap.connectionId = b;
    cap.infraredId = "ir_hub_a1"; // A's hub through B's token: Tuya's list for B doesn't have it
    expect((await executeHomeCommands(B(), press))[0]).toMatchObject({
      status: "unavailable",
      error: "tuya_not_linked",
    });
    expect(tuya.tuyaSendKey).not.toHaveBeenCalled();
  });

  it("disconnecting A leaves B connected and working", async () => {
    const a = await connect(A(), "code-a");
    const b = await connect(B(), "code-b");
    for (const [auth, c, hub] of [
      [A(), a, "ir_hub_a1"],
      [B(), b, "ir_hub_b1"],
    ] as const)
      await tuyaImport(auth, {
        connectionId: c,
        remotes: [{ infraredId: hub, remoteId: "rm_tv_01" }],
      });
    await disconnectTuya(A(), a);
    expect(state.vault.has(`${WS_A}:${a}`)).toBe(false);
    expect(state.vault.has(`${WS_B}:${b}`)).toBe(true);
    expect(await tuyaConnections(A())).toEqual([]);
    expect(tuya.forgetTuyaAccount).toHaveBeenCalledWith(a);
    const rowA = db.rows("home_devices").find((r) => r.workspace_id === WS_A)!;
    const rowB = db.rows("home_devices").find((r) => r.workspace_id === WS_B)!;
    expect(rowA.removed_at).not.toBeNull();
    expect(rowB.removed_at).toBeNull();
    const [o] = await executeHomeCommands(B(), [
      {
        deviceId: rowB.id as string,
        actions: [{ type: "tuya_key", command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ]);
    expect(o!.status).toBe("succeeded");
  });

  it("B can't disconnect A's account", async () => {
    const a = await connect(A(), "code-a");
    await expect(disconnectTuya(B(), a)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.vault.has(`${WS_A}:${a}`)).toBe(true);
  });
});

describe("importing and using what's already set up in Smart Life", () => {
  it("cloud-only: no ELISE Home hub needed; ready devices; importing again doesn't duplicate", async () => {
    const a = await connect(A(), "code-a");
    const refs = [
      { infraredId: "ir_hub_a1", remoteId: "rm_tv_01" },
      { infraredId: "ir_hub_a1", remoteId: "rm_ac_01" },
    ];
    const first = await tuyaImport(A(), { connectionId: a, remotes: refs });
    expect(first.added.map((x) => [x.name, x.test])).toEqual([
      ["Tele Pieza", { type: "button", value: "mute" }],
      ["Aire", { type: "power", value: true }],
    ]);
    await tuyaImport(A(), { connectionId: a, remotes: refs });
    const rows = db.rows("home_devices");
    expect(rows).toHaveLength(2);
    expect(db.rows("home_hubs")).toHaveLength(0);
    expect(rows.map((r) => [r.provider_key, r.device_type, r.hub_id, r.workspace_id])).toEqual([
      [`tuya:${a}:ir_hub_a1:rm_tv_01`, "media_player", null, WS_A],
      [`tuya:${a}:ir_hub_a1:rm_ac_01`, "climate", null, WS_A],
    ]);
    // Voice and Hogar control it with no hub: straight to Tuya with A's token.
    const [o] = await executeHomeCommands(A(), [
      {
        deviceId: rows[1]!.id as string,
        actions: [{ type: "tuya_ac", power: true, mode: "cool", temp: 24 }],
      },
    ]);
    expect(o).toMatchObject({
      status: "succeeded",
      state: { on: true, hvacMode: "cool", targetTemperature: 24, estimated: true },
    });
    expect(tuya.tuyaSendAc).toHaveBeenCalledWith(expect.objectContaining({ key: a }), {
      infraredId: "ir_hub_a1",
      remoteId: "rm_ac_01",
      categoryId: 5,
      power: true,
      mode: "cool",
      temp: 24,
    });
  });

  it("a remote named like another device is flagged; 'Usar Smart Life' hides the other one", async () => {
    const a = await connect(A(), "code-a");
    const hub = await (async () => {
      const { code } = await createPairingCode(A());
      const paired = await redeemPairingCode({ code, agentVersion: "0.1.0", protocolVersion: 1 });
      return authenticateHub(`Bearer ${paired.token}`);
    })();
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
    const engineTv = db.rows("home_devices")[0]!;
    engineTv.added_at = new Date().toISOString();
    const { hubs } = await tuyaOverview(A(), a);
    expect(hubs[0]!.remotes[0]).toMatchObject({
      name: "Tele Pieza",
      sameAs: { id: engineTv.id, name: "Tele Pieza" },
    });
    expect(hubs[0]!.remotes[1]!.sameAs).toBeNull();
    await tuyaImport(A(), {
      connectionId: a,
      remotes: [{ infraredId: "ir_hub_a1", remoteId: "rm_tv_01", replaces: engineTv.id as string }],
    });
    expect(engineTv.hidden).toBe(true);
    // The engine's sync never removes a Smart Life remote.
    await hubSync(hub, { rooms: [], devices: [] });
    await hubSync(hub, {
      rooms: [],
      devices: [
        {
          providerKey: "dev_other",
          providerDeviceId: "dev_other",
          entityIds: ["light.x"],
          name: "Luz",
          areaId: null,
          type: "light",
          capabilities: [{ type: "power" }],
          state: {},
          available: true,
          stateUpdatedAt: null,
        },
      ],
    });
    const remote = db.rows("home_devices").find((r) => String(r.provider_key).startsWith("tuya:"));
    expect(remote!.removed_at).toBeNull();
  });

  it("sync: a remote renamed in Smart Life is renamed (the person's alias stays); a deleted one leaves", async () => {
    const a = await connect(A(), "code-a");
    await tuyaImport(A(), {
      connectionId: a,
      remotes: [
        { infraredId: "ir_hub_a1", remoteId: "rm_tv_01" },
        { infraredId: "ir_hub_a1", remoteId: "rm_ac_01" },
      ],
    });
    const [tv, ac] = db.rows("home_devices");
    tv!.display_name = "La tele";
    tuya.tuyaRemotes.mockResolvedValue([{ ...TV_REMOTE, remote_name: "Tele Living" }]);
    expect(await syncTuya(A(), a)).toEqual({ updated: 1, removed: 1 });
    expect(tv).toMatchObject({ name: "Tele Living", display_name: "La tele", removed_at: null });
    expect(ac!.removed_at).not.toBeNull();
  });

  it("an offline Tuya hub isn't sent to; a Tuya error is a failure, not a success", async () => {
    const a = await connect(A(), "code-a");
    await tuyaImport(A(), {
      connectionId: a,
      remotes: [{ infraredId: "ir_hub_a1", remoteId: "rm_tv_01" }],
    });
    const id = db.rows("home_devices")[0]!.id as string;
    const press = [
      {
        deviceId: id,
        actions: [{ type: "tuya_key" as const, command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ];
    tuya.tuyaSendKey.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "RATE_LIMITED" }));
    expect((await executeHomeCommands(A(), press))[0]!.status).toBe("failed");
    tuya.tuyaUserDevices.mockResolvedValue([
      { id: "ir_hub_a1", name: "Smart IR A", category: "wnykq", online: false, sub: false },
    ]);
    expect((await executeHomeCommands(A(), press))[0]!.status).toBe("unavailable");
  });
});

describe("the person's token", () => {
  it("an expired token is refreshed once (single-use refresh token kept); a refused refresh asks to reconnect", async () => {
    const a = await connect(A(), "code-a");
    await tuyaImport(A(), {
      connectionId: a,
      remotes: [{ infraredId: "ir_hub_a1", remoteId: "rm_tv_01" }],
    });
    const key = `${WS_A}:${a}`;
    state.vault.set(key, {
      ...(state.vault.get(key) as object),
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    // The client asks for the token while sending: refresh happens there.
    tuya.tuyaSendKey.mockImplementation(async (auth: { accessToken(): Promise<string> }) => {
      await auth.accessToken();
    });
    tuya.refreshTuyaToken.mockResolvedValueOnce({
      accessToken: "token-2",
      refreshToken: "refresh-2",
      expiresAt: new Date(Date.now() + 3600_000),
      uid: "uid-a",
    });
    const id = db.rows("home_devices")[0]!.id as string;
    const press = [
      {
        deviceId: id,
        actions: [{ type: "tuya_key" as const, command: "mute", tuya: "Mute", repeats: 1 }],
      },
    ];
    expect((await executeHomeCommands(A(), press))[0]!.status).toBe("succeeded");
    expect(tuya.refreshTuyaToken).toHaveBeenCalledWith("us", "refresh-code-a");
    expect(state.vault.get(key)).toMatchObject({
      accessToken: "token-2",
      refreshToken: "refresh-2",
    });

    state.vault.set(key, {
      ...(state.vault.get(key) as object),
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    tuya.refreshTuyaToken.mockRejectedValueOnce(new FakeTuyaError("token"));
    expect((await executeHomeCommands(A(), press))[0]!.status).toBe("failed");
    expect((await tuyaConnections(A()))[0]).toMatchObject({ status: "needs_reauthorization" });
    // Until reconnected, nothing is sent.
    expect((await executeHomeCommands(A(), press))[0]).toMatchObject({
      status: "unavailable",
      error: "tuya_reconnect",
    });
  });
});
