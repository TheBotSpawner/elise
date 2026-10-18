import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * ELISE Desktop's main process (ADR-081): only ELISE's own page reaches the bridge, every call
 * is validated, secrets never reach logs, the CSP stays strict, and local state migrates.
 */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => "C:/tmp/elise-test",
    getVersion: () => "1.0.0",
    isPackaged: true,
    getLocale: () => "es",
    on: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      electron.handlers.set(channel, fn),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  net: { isOnline: () => true },
  shell: { openExternal: vi.fn() },
  session: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  autoUpdater: { on: vi.fn(), setFeedURL: vi.fn(), checkForUpdates: vi.fn() },
}));
vi.mock("node:fs", async (orig) => ({
  ...(await orig<typeof import("node:fs")>()),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.stubGlobal("__ELISE_BUILD__", {
  cloudUrl: "https://elise.example",
  supabaseUrl: "https://proj.supabase.co",
  supabasePublishableKey: "pk",
  updateFeed: "",
  channel: "stable",
  googleMapsKey: "",
});

const { redact } = await import("../../../desktop/src/main/log");
const { migrateState } = await import("../../../desktop/src/main/store");
const { contentSecurityPolicy, APP_ORIGIN } = await import("../../../desktop/src/main/protocol");
const { isAppUrl } = await import("../../../desktop/src/main/security");
const { registerIpc } = await import("../../../desktop/src/main/ipc");
const { absorbSetCookies, cookieHeader } = await import("../../../desktop/src/main/cloud");
const { INVOKE } = await import("../../../desktop/src/shared/channels");

const host = {
  home: {
    runtime: "not_installed",
    paired: false,
    providerConnected: false,
    devices: 0,
    message: null,
  },
  running: true,
  version: "0.1.0",
  call: vi.fn(async () => []),
  stop: vi.fn(),
};
const fromApp = { senderFrame: { origin: APP_ORIGIN } };
const call = (channel: string, event: unknown, ...args: unknown[]) =>
  electron.handlers.get(channel)!(event, ...args);

beforeAll(() => {
  registerIpc(host as never, () => undefined);
});

describe("the bridge", () => {
  it("refuses any page but ELISE's own", async () => {
    await expect(
      call(INVOKE.desktopInfo, { senderFrame: { origin: "https://evil.example" } }),
    ).rejects.toThrow("Not allowed");
    await expect(call(INVOKE.desktopInfo, { senderFrame: null })).rejects.toThrow();
    expect(await call(INVOKE.desktopInfo, fromApp)).toMatchObject({ bridgeProtocolVersion: 1 });
  });

  it("validates every argument; only typed operations exist", async () => {
    await expect(call(INVOKE.setPreferences, fromApp, { startAtLogin: "yes" })).rejects.toThrow();
    await expect(call(INVOKE.setPreferences, fromApp, { runShell: true })).rejects.toThrow();
    await expect(
      call(INVOKE.homeExecute, fromApp, { providerKey: "x", actions: [] }),
    ).rejects.toThrow();
    expect([...electron.handlers.keys()].some((c) => /shell|eval|spawn|command|:fs/.test(c))).toBe(
      false,
    );
  });

  it("nobody signed in to that home → no local Home control", async () => {
    expect(
      await call(INVOKE.homeExecute, fromApp, {
        providerKey: "dev_lamp",
        actions: [{ type: "power", value: true }],
      }),
    ).toEqual({ ok: false, error: "NOT_ALLOWED" });
    expect(host.call).not.toHaveBeenCalled();
    expect(await call(INVOKE.homeDevices, fromApp)).toEqual([]);
  });

  it("caches only allowlisted screens, and only for a signed-in account", async () => {
    expect(await call(INVOKE.cacheGet, fromApp, "page:/finance")).toBeNull();
    expect(await call(INVOKE.cacheGet, fromApp, "page:/my-elise/home")).toBeNull();
  });
});

describe("secrets and policy", () => {
  it("logs never carry tokens", () => {
    const out = JSON.stringify(
      redact({
        authorization: "Bearer abc",
        refresh_token: "r1",
        note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9 and ehh_abcdefghijklmnopqrstuvwxyz",
        nested: { cookie: "sb-x-auth-token=1" },
      }),
    );
    expect(out).not.toMatch(/Bearer abc|"r1"|eyJ|ehh_abc|sb-x-auth/);
  });

  it("strict CSP: no eval, no wildcard scripts, no plugins, no dev server", () => {
    const csp = contentSecurityPolicy(false);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("localhost");
  });

  it("only the app's own origin is privileged", () => {
    expect(isAppUrl(`${APP_ORIGIN}/my-elise/home`)).toBe(true);
    expect(isAppUrl("https://elise.example/")).toBe(false);
    expect(isAppUrl("elise-app://evil/")).toBe(false);
  });

  it("keeps only ELISE's auth cookies from the cloud", () => {
    const h = new Headers();
    h.append("set-cookie", "sb-proj-auth-token=abc; Path=/; HttpOnly");
    h.append("set-cookie", "tracking=1; Path=/");
    absorbSetCookies(h);
    expect(cookieHeader()).toBe("sb-proj-auth-token=abc");
    const gone = new Headers();
    gone.append("set-cookie", "sb-proj-auth-token=; Max-Age=0");
    absorbSetCookies(gone);
    expect(cookieHeader()).toBe("");
  });
});

describe("local state", () => {
  it("migrates without losing the installation or preferences; repairs bad values", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const s = migrateState({ installationId: id, preferences: { startAtLogin: false } });
    expect(s).toMatchObject({ version: 1, installationId: id });
    expect(s.preferences).toEqual({
      startAtLogin: false,
      keepInBackground: true,
      notifications: true,
    });
    expect(migrateState({ installationId: "aa:bb:cc:dd" }).installationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(migrateState("garbage").preferences.keepInBackground).toBe(true);
  });
});
