import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * The ELISE Home service over an in-memory database (ADR-079): single-use pairing, the hub's
 * own credential, commands claimed once, never delivered late, and results that update state.
 */

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));

const {
  authenticateHub,
  createPairingCode,
  executeHomeCommands,
  hubClaimCommands,
  hubHeartbeat,
  hubReportResult,
  hubSync,
  redeemPairingCode,
  registerDesktopHub,
} = await import("@/application/home-service");

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

const LAMP = {
  providerKey: "dev_lamp",
  providerDeviceId: "dev_lamp",
  entityIds: ["light.escritorio"],
  name: "Luz escritorio",
  areaId: "escritorio",
  type: "light" as const,
  capabilities: [{ type: "power" as const }, { type: "brightness" as const }],
  state: { on: false },
  available: true,
  stateUpdatedAt: null,
};

async function pairedHub() {
  const { code } = await createPairingCode(auth);
  const paired = await redeemPairingCode({ code, agentVersion: "0.1.0", protocolVersion: 1 });
  const hub = await authenticateHub(`Bearer ${paired.token}`);
  return { paired, hub };
}

describe("pairing", () => {
  it("a code works once; the hub gets its own credential (never stored in plain text)", async () => {
    const { code } = await createPairingCode(auth);
    expect(code).toMatch(/^ELISE-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const paired = await redeemPairingCode({ code });
    expect(paired.token).toMatch(/^ehh_/);
    await expect(redeemPairingCode({ code })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(JSON.stringify(db.rows("home_hub_credentials"))).not.toContain(paired.token);
    expect(JSON.stringify(db.rows("home_pairing_codes"))).not.toContain(code);
  });

  it("an expired code is refused", async () => {
    const { code } = await createPairingCode(auth);
    db.rows("home_pairing_codes")[0]!.expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(redeemPairingCode({ code })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("an unknown or revoked credential is refused", async () => {
    const { paired } = await pairedHub();
    await expect(authenticateHub("Bearer ehh_not-a-real-token-at-all-xx")).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
    db.rows("home_hubs")[0]!.revoked_at = new Date().toISOString();
    await expect(authenticateHub(`Bearer ${paired.token}`)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
  });

  it("ELISE Desktop registers through the person's session (no code), replacing its previous hub", async () => {
    const first = await registerDesktopHub(auth, { agentVersion: "1.0.0", protocolVersion: 1 });
    const second = await registerDesktopHub(auth, {});
    await expect(authenticateHub(`Bearer ${first.token}`)).rejects.toMatchObject({
      code: "AUTH_ERROR",
    });
    await expect(authenticateHub(`Bearer ${second.token}`)).resolves.toMatchObject({
      workspaceId: WS,
    });
  });
});

describe("commands", () => {
  async function ready() {
    const { hub } = await pairedHub();
    await hubSync(hub, {
      rooms: [{ providerAreaId: "escritorio", name: "Escritorio" }],
      devices: [LAMP],
    });
    await hubHeartbeat(hub, { providerConnected: true, runtimeState: "ready" });
    const device = db.rows("home_devices")[0]!;
    return { hub, deviceId: device.id as string };
  }

  it("sync creates the room and the device, scoped to the hub's workspace", async () => {
    const { deviceId } = await ready();
    expect(db.rows("home_rooms")[0]).toMatchObject({ workspace_id: WS, name: "Escritorio" });
    expect(db.rows("home_devices")[0]).toMatchObject({
      id: deviceId,
      workspace_id: WS,
      name: "Luz escritorio",
    });
  });

  it("queued → delivered once → executing → succeeded; the result updates the cached state", async () => {
    const { hub, deviceId } = await ready();
    db.rows("home_commands").push({
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: WS,
      home_id: db.rows("homes")[0]!.id,
      hub_id: hub.id,
      device_id: deviceId,
      actions: [{ type: "power", on: true }],
      status: "queued",
      expires_at: new Date(Date.now() + 30_000).toISOString(),
      created_at: new Date().toISOString(),
    });
    const first = await hubClaimCommands(hub, 0);
    expect(first.map((c) => c.target)).toEqual([
      { providerKey: "dev_lamp", entityIds: ["light.escritorio"] },
    ]);
    // A retry or a second connection gets nothing: claimed atomically.
    expect(await hubClaimCommands(hub, 0)).toEqual([]);
    await hubReportResult(hub, first[0]!.id, { status: "executing" });
    await hubReportResult(hub, first[0]!.id, { status: "succeeded", state: { on: true } });
    expect(db.rows("home_commands")[0]).toMatchObject({ status: "succeeded" });
    expect(db.rows("home_devices")[0]!.state).toEqual({ on: true });
    // A finished command can't be reported again.
    await expect(hubReportResult(hub, first[0]!.id, { status: "failed" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("a command older than its TTL expires instead of running late", async () => {
    const { hub, deviceId } = await ready();
    db.rows("home_commands").push({
      id: "22222222-2222-4222-8222-222222222222",
      workspace_id: WS,
      home_id: db.rows("homes")[0]!.id,
      hub_id: hub.id,
      device_id: deviceId,
      actions: [{ type: "power", on: true }],
      status: "queued",
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
    });
    expect(await hubClaimCommands(hub, 0)).toEqual([]);
    expect(db.rows("home_commands")[0]).toMatchObject({ status: "expired" });
  });

  it("a hub that stopped beating is offline: the command isn't sent, and says so", async () => {
    const { deviceId } = await ready();
    db.rows("home_hubs")[0]!.last_seen_at = new Date(Date.now() - 10 * 60_000).toISOString();
    const out = await executeHomeCommands(auth, [
      { deviceId, actions: [{ type: "power", on: true }] },
    ]);
    expect(out).toEqual([{ deviceId, name: "Luz escritorio", status: "offline" }]);
    expect(db.rows("home_commands")).toHaveLength(0);
  });

  it("an unknown device is refused", async () => {
    await ready();
    await expect(
      executeHomeCommands(auth, [
        {
          deviceId: "33333333-3333-4333-8333-333333333333",
          actions: [{ type: "power", on: true }],
        },
      ]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a device that disappears is kept (removed) and comes back with its names", async () => {
    const { hub } = await ready();
    db.rows("home_devices")[0]!.aliases = ["luz PC"];
    await hubSync(hub, { rooms: [], devices: [] });
    expect(db.rows("home_devices")[0]!.removed_at).not.toBeNull();
    await hubSync(hub, { rooms: [], devices: [LAMP] });
    expect(db.rows("home_devices")[0]).toMatchObject({ removed_at: null, aliases: ["luz PC"] });
  });

  it("the hub's payloads are validated at the boundary", async () => {
    const { hub } = await ready();
    await expect(
      hubSync(hub, { rooms: [], devices: [{ ...LAMP, type: "lock" }] }),
    ).rejects.toThrow();
  });
});
