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

  it("only a local Home Assistant is ever contacted (no network pivot)", () => {
    expect(isLocalProvider("http://localhost:8123")).toBe(true);
    expect(isLocalProvider("http://192.168.1.20:8123")).toBe(true);
    expect(isLocalProvider("http://homeassistant.local:8123")).toBe(true);
    expect(isLocalProvider("https://evil.example.com")).toBe(false);
    expect(isLocalProvider("file:///etc/passwd")).toBe(false);
  });
});
