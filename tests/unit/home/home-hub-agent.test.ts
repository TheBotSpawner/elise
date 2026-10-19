import { describe, expect, it, vi } from "vitest";

import { normalizeRegistry } from "@/infrastructure/home/home-assistant";

import { HubAgent } from "../../../home-hub/agent";
import { isLocalProvider } from "../../../home-hub/config";
import { HA_ENTRIES, HA_NAMES, HA_STATES } from "../../fixtures/home-assistant";

/**
 * The hub at home (ADR-079) validates every command again: nothing runs just because it
 * arrived — known schema, not expired, a device it reported, and never twice.
 */
function agent() {
  const a = new HubAgent(
    { eliseUrl: "https://elise.example", haUrl: "http://localhost:8123", hubToken: "ehh_x" },
    "ha-token",
  );
  const calls: unknown[] = [];
  const results: { id: string; status: string; error?: string }[] = [];
  const reg = normalizeRegistry(HA_STATES, HA_ENTRIES, HA_NAMES);
  const internals = a as unknown as {
    devices: Map<string, unknown>;
    connected: boolean;
    ha: { callService: (c: unknown) => Promise<unknown>; states: () => Promise<unknown[]> };
    cloud: { result: (id: string, r: { status: string; error?: string }) => Promise<unknown> };
  };
  internals.devices = new Map(reg.devices.map((d) => [d.providerKey, d]));
  internals.connected = true;
  internals.ha.callService = async (c) => void calls.push(c);
  internals.ha.states = async () => HA_STATES;
  internals.cloud.result = async (id, r) => void results.push({ id, ...r });
  return { a, calls, results };
}

const command = (over: object = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  target: { providerKey: "dev_lamp", entityIds: ["light.escritorio"] },
  actions: [{ type: "brightness", value: 30 }],
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  ...over,
});

describe("the hub agent's own checks", () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  it("a valid command runs once, as the provider's own action, and reports the new state", async () => {
    const { a, calls, results } = agent();
    await a.execute(command());
    await a.execute(command()); // duplicate delivery
    expect(calls).toEqual([
      {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.escritorio" },
        service_data: { brightness_pct: 30 },
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(["executing", "succeeded"]);
  });

  it("expired, unknown target or malformed → never executed", async () => {
    const { a, calls, results } = agent();
    await a.execute(
      command({
        id: "33333333-3333-4333-8333-333333333333",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    await a.execute(
      command({
        id: "44444444-4444-4444-8444-444444444444",
        target: { providerKey: "dev_lock", entityIds: ["lock.front"] },
      }),
    );
    await a.execute({ id: "x", actions: [{ type: "shell", cmd: "rm -rf" }] });
    expect(calls).toEqual([]);
    expect(results.map((r) => r.error)).toEqual(["EXPIRED", "UNKNOWN_TARGET"]);
  });

  it("local control without ELISE Cloud: same canonical validation, never a raw call (ADR-081)", async () => {
    const { a, calls } = agent();
    expect(await a.executeLocal("dev_lamp", [{ type: "brightness", value: 40 }])).toMatchObject({
      ok: true,
    });
    expect(calls).toEqual([
      {
        domain: "light",
        service: "turn_on",
        target: { entity_id: "light.escritorio" },
        service_data: { brightness_pct: 40 },
      },
    ]);
    expect(await a.executeLocal("dev_lock", [{ type: "power", value: true }])).toEqual({
      ok: false,
      error: "UNKNOWN_TARGET",
    });
    expect(await a.executeLocal("dev_lamp", [{ type: "brightness", value: 400 }])).toMatchObject({
      ok: false,
    });
    expect(calls).toHaveLength(1);
    expect(a.localDevices().find((d) => d.providerKey === "dev_lamp")).toMatchObject({
      name: expect.any(String),
      available: true,
    });
  });

  it("only a local Home Assistant is ever contacted (no network pivot)", () => {
    expect(isLocalProvider("http://localhost:8123")).toBe(true);
    expect(isLocalProvider("http://192.168.1.20:8123")).toBe(true);
    expect(isLocalProvider("http://homeassistant.local:8123")).toBe(true);
    expect(isLocalProvider("https://evil.example.com")).toBe(false);
    expect(isLocalProvider("file:///etc/passwd")).toBe(false);
  });
});

/** "Quitar" (the person's own): the engine lets go of the device, so it can be added again. */
describe("removing a device", () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  it("runs as a removal, never as a provider action, and resyncs", async () => {
    const { a, calls, results } = agent();
    const internals = a as unknown as {
      ha: { removeDevice: (id: string | null, e: readonly string[]) => Promise<void> };
      sync: () => Promise<void>;
    };
    const removed: unknown[] = [];
    internals.ha.removeDevice = async (id, e) => void removed.push([id, e[0]]);
    internals.sync = async () => undefined;
    await a.execute(command({ actions: [{ type: "remove" }] }));
    expect(removed).toEqual([["dev_lamp", "light.escritorio"]]);
    expect(calls).toEqual([]);
    expect(results.map((r) => r.status)).toEqual(["executing", "succeeded"]);
  });
});

/** "Apagá la tele" with YouTube open: the first power press can just close the app. */
describe("turning a TV off", () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const tvOff = command({
    target: { providerKey: "dev_tv", entityIds: ["media_player.tv"] },
    actions: [{ type: "power", on: false }],
  });

  it("presses power again when the TV still reports on", async () => {
    const { a, calls } = agent();
    (a as unknown as { offRecheckMs: number }).offRecheckMs = 0;
    await a.execute(tvOff);
    expect(calls.map((c) => (c as { service: string }).service)).toEqual(["turn_off", "turn_off"]);
  });

  it("presses once when it did turn off", async () => {
    const { a, calls } = agent();
    const internals = a as unknown as {
      offRecheckMs: number;
      ha: { states: () => Promise<unknown[]> };
    };
    internals.offRecheckMs = 0;
    internals.ha.states = async () =>
      HA_STATES.map((s) => (s.entity_id === "media_player.tv" ? { ...s, state: "off" } : s));
    await a.execute(tvOff);
    expect(calls).toHaveLength(1);
  });
});
