import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

/**
 * Linking this computer as the home's hub (ADR-080/082): runtime events arrive in bursts, and
 * overlapping registrations used to create two hubs, the second revoking the first — Hogar then
 * showed "sin conexión" with ELISE Desktop open. One registration at a time; a refused
 * credential is forgotten and linked again (never in a loop).
 */
const cloud = vi.hoisted(() => {
  let token: string | null = null;
  let n = 0;
  return {
    calls: 0,
    hubToken: () => token,
    setHubToken: vi.fn((t: string | null) => (token = t)),
    session: () => ({ signedIn: true, workspaceId: "w1" }),
    cloudState: () => ({ cloud: "online" }),
    engineCredentials: () => null,
    setEngineCredentials: vi.fn(),
    cloudFetch: vi.fn(async () => {
      cloud.calls++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ token: `ehh_${++n}` }), { status: 200 });
    }),
  };
});
vi.mock("electron", () => ({ app: { getPath: () => "C:/tmp/x", getLocale: () => "es" } }));
vi.mock("../../../desktop/src/main/cloud", () => cloud);
vi.mock("../../../desktop/src/main/log", () => ({ log: vi.fn() }));
vi.mock("../../../desktop/src/main/store", () => ({
  loadState: () => ({ installationId: "inst-1" }),
}));
vi.stubGlobal("__ELISE_BUILD__", { cloudUrl: "https://elise.example" });

const { watchHome } = await import("../../../desktop/src/main/home");

function fakeHost() {
  const host = Object.assign(new EventEmitter(), {
    home: { runtime: { phase: "ready" } },
    version: "0.1.0",
    configure: vi.fn(async () => undefined),
  });
  return host;
}

describe("hub link", () => {
  it("a burst of runtime events registers once; a refused credential relinks once", async () => {
    const host = fakeHost();
    watchHome(host as never);
    for (let i = 0; i < 5; i++) host.emit("home", {});
    await new Promise((r) => setTimeout(r, 80));
    expect(cloud.calls).toBe(1);
    expect(cloud.hubToken()).toBe("ehh_1");

    host.emit("hubRejected");
    host.emit("hubRejected"); // the next heartbeat too: still one relink
    await new Promise((r) => setTimeout(r, 80));
    expect(cloud.setHubToken).toHaveBeenCalledWith(null, null);
    expect(cloud.calls).toBe(2);
    expect(cloud.hubToken()).toBe("ehh_2");
  });
});

describe("hub agent", () => {
  it("tells its host when ELISE refuses its credential (401), not on other failures", async () => {
    const { HubAgent } = await import("../../../home-hub/agent");
    const onRejected = vi.fn();
    const agent = new HubAgent(
      { eliseUrl: "https://elise.example", haUrl: "http://127.0.0.1:8123", hubToken: "ehh_x" },
      "ha",
      { onRejected },
    );
    const beat = (agent as unknown as { beat: (s: string) => Promise<void> }).beat.bind(agent);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "AUTH_ERROR", message: "x" } }), {
            status: 401,
          }),
      ),
    );
    await expect(beat("ready")).rejects.toThrow();
    expect(onRejected).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    await expect(beat("ready")).rejects.toThrow();
    expect(onRejected).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
