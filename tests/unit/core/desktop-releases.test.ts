import { describe, expect, it } from "vitest";

import { homeOnboarding, type DesktopPresence } from "@/core/platform/presence";
import {
  compareVersions,
  latestRelease,
  parseManifest,
  platformFromUserAgent,
  type DesktopManifest,
  type DesktopRelease,
} from "@/core/platform/releases";

/**
 * Finding ELISE Desktop (ADR-082): one manifest for download and updates; drafts, withdrawn
 * and unsigned stable builds never reach people; setup advances only from real presence.
 */
const release = (over: Partial<DesktopRelease> = {}): DesktopRelease => ({
  version: "1.0.0",
  channel: "stable",
  state: "published",
  platform: "windows",
  arch: "x64",
  installerUrl: "https://releases.example/ELISE-Setup.exe",
  sha256: "a".repeat(64),
  sizeBytes: 150_000_000,
  publishedAt: "2026-10-18T00:00:00.000Z",
  signed: true,
  ...over,
});
const manifest = (...releases: DesktopRelease[]): DesktopManifest => ({
  schemaVersion: 1,
  releases,
});
const stable = { platform: "windows" as const, channel: "stable" as const, production: true };
const beta = { platform: "windows" as const, channel: "beta" as const, production: false };

describe("release manifest", () => {
  it("a stable Windows release is offered; the newest wins", () => {
    const m = manifest(
      release({ version: "1.0.0" }),
      release({ version: "1.2.0" }),
      release({ version: "1.10.0" }),
    );
    expect(latestRelease(m, stable)?.version).toBe("1.10.0");
  });

  it("nothing for this audience → null (the page says so; no fake link)", () => {
    expect(latestRelease(null, stable)).toBeNull();
    expect(latestRelease(manifest(release({ platform: "macos" })), stable)).toBeNull();
  });

  it("beta-only builds show only where beta downloads are on", () => {
    const m = manifest(release({ channel: "beta", signed: false, version: "0.2.0-beta.1" }));
    expect(latestRelease(m, stable)).toBeNull();
    expect(latestRelease(m, beta)?.version).toBe("0.2.0-beta.1");
  });

  it("drafts and withdrawn releases are never offered; the previous one takes over", () => {
    const m = manifest(
      release({ version: "1.0.0" }),
      release({ version: "1.1.0", state: "withdrawn" }),
      release({ version: "1.2.0", state: "draft" }),
    );
    expect(latestRelease(m, stable)?.version).toBe("1.0.0");
  });

  it("an unsigned build is never a public stable download", () => {
    expect(latestRelease(manifest(release({ signed: false })), stable)).toBeNull();
    expect(
      latestRelease(manifest(release({ signed: false })), { ...stable, production: false })
        ?.version,
    ).toBe("1.0.0");
  });

  it("an invalid manifest is treated as no release", () => {
    expect(parseManifest({ schemaVersion: 2, releases: [] })).toBeNull();
    expect(
      parseManifest({ schemaVersion: 1, releases: [{ ...release(), sha256: "nope" }] }),
    ).toBeNull();
    expect(parseManifest({ schemaVersion: 1, releases: [release()] })?.releases).toHaveLength(1);
  });

  it("versions compare like semver (pre-releases before the release)", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });

  it("detects the platform from the browser; phones get no desktop build", () => {
    expect(platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140")).toBe(
      "windows",
    );
    expect(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari")).toBe(
      "macos",
    );
    expect(
      platformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile"),
    ).toBeNull();
    expect(platformFromUserAgent("Mozilla/5.0 (Linux; Android 15) Mobile")).toBeNull();
  });
});

describe("Hogar setup from presence", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const desktop = (over: Partial<DesktopPresence> = {}): DesktopPresence => ({
    installationId: "11111111-1111-4111-8111-111111111111",
    name: "PC de casa",
    platform: "windows",
    lastSeenAt: "2026-10-18T11:59:30Z",
    bridgeProtocolVersion: 1,
    homeEnabled: false,
    homeRuntimePhase: null,
    homeRuntimeProgress: null,
    ...over,
  });

  it("no heartbeat → not configured (a deep link that 'worked' proves nothing)", () => {
    expect(homeOnboarding(null, [], now).state).toBe("desktop_not_configured");
  });

  it("a heartbeat appears → setup advances to that computer", () => {
    const ob = homeOnboarding(null, [desktop()], now);
    expect(ob).toMatchObject({ state: "desktop_online", choose: false });
    expect(ob.host?.name).toBe("PC de casa");
  });

  it("a stale heartbeat is offline, not connected", () => {
    expect(homeOnboarding(null, [desktop({ lastSeenAt: "2026-10-18T11:50:00Z" })], now).state).toBe(
      "desktop_offline",
    );
  });

  it("the hub went quiet but ELISE Desktop is open → reconnecting, never “sin conexión”", () => {
    expect(homeOnboarding("desktop_offline", [desktop()], now).state).toBe("hub_initializing");
    // Nothing open at all: then it really is offline.
    expect(
      homeOnboarding("desktop_offline", [desktop({ lastSeenAt: "2026-10-18T11:50:00Z" })], now)
        .state,
    ).toBe("desktop_offline");
  });

  it("an old, incompatible Desktop → update required", () => {
    expect(homeOnboarding(null, [desktop({ bridgeProtocolVersion: 0 })], now).state).toBe(
      "desktop_update_required",
    );
  });

  it("several computers online → ask which; the one already preparing Home is chosen", () => {
    const two = [desktop(), desktop({ installationId: "2", name: "Notebook" })];
    expect(homeOnboarding(null, two, now)).toMatchObject({ choose: true, host: null });
    const preparing = [
      desktop(),
      desktop({
        installationId: "2",
        name: "Notebook",
        homeEnabled: true,
        homeRuntimePhase: "downloading",
      }),
    ];
    expect(homeOnboarding(null, preparing, now)).toMatchObject({
      choose: false,
      host: { name: "Notebook" },
    });
  });

  it("once a hub exists, the hub's own presence decides", () => {
    expect(homeOnboarding("hub_initializing", [desktop()], now).state).toBe("hub_initializing");
  });
});
