import { describe, expect, it, vi } from "vitest";

import { resolveCloudUrl } from "../../../desktop/cloud-url";
import {
  assertPublishable,
  manifestWith,
  withdrawn,
} from "../../../desktop/scripts/release-policy.mjs";

/**
 * ELISE Desktop distribution (ADR-084): a packaged build can't talk to localhost, releases follow
 * the channel policy, the manifest URL never changes per release, and beta reaches testers only.
 */
const env = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock("server-only", () => ({}));
vi.mock("@/config/server-env", () => ({ serverEnv: () => env.value }));

const { desktopReleaseFor, manifestUrlFor, resetDesktopReleaseCache } =
  await import("@/config/desktop-releases");

describe("Cloud URL baked into a build", () => {
  it("production builds refuse a missing, local or plain-http ELISE_CLOUD_URL", () => {
    expect(() => resolveCloudUrl(undefined, true)).toThrow(/non-local ELISE_CLOUD_URL/);
    for (const bad of [
      "http://localhost:3999",
      "https://localhost",
      "http://127.0.0.1:3000",
      "https://0.0.0.0",
      "https://elise.local",
    ])
      expect(() => resolveCloudUrl(bad, true), bad).toThrow(/non-local/);
    expect(() => resolveCloudUrl("http://elise-lime.vercel.app", true)).toThrow(/https/);
  });

  it("production accepts the real Cloud (normalized); development defaults to the local web", () => {
    expect(resolveCloudUrl("https://elise-lime.vercel.app/", true)).toBe(
      "https://elise-lime.vercel.app",
    );
    expect(resolveCloudUrl(undefined, false)).toBe("http://localhost:3000");
    expect(resolveCloudUrl("http://localhost:3100", false)).toBe("http://localhost:3100");
  });
});

const entry = (over: Record<string, unknown> = {}) => ({
  version: "0.1.0-beta.1",
  channel: "beta",
  state: "published",
  platform: "windows",
  arch: "x64",
  installerUrl:
    "https://github.com/o/r/releases/download/desktop-v0.1.0-beta.1/ELISE-Setup-0.1.0-beta.1.exe",
  sha256: "a".repeat(64),
  sizeBytes: 1,
  publishedAt: "2026-10-19T00:00:00.000Z",
  signed: false,
  ...over,
});

describe("release policy", () => {
  const base = {
    version: "0.1.0-beta.1",
    channel: "beta",
    signed: false,
    cloudUrl: "https://elise-lime.vercel.app",
    updateFeed: "https://github.com/TheBotSpawner/elise/releases/download",
    installerName: "ELISE-0.1.0-beta.1 Setup.exe",
  };
  it("an unsigned beta with the production Cloud can be published", () => {
    expect(() => assertPublishable(base)).not.toThrow();
  });
  it("never a build that talks to localhost, nor a mismatched installer", () => {
    expect(() => assertPublishable({ ...base, cloudUrl: "http://localhost:3999" })).toThrow(
      /production ELISE_CLOUD_URL/,
    );
    expect(() => assertPublishable({ ...base, installerName: "ELISE-0.1.0 Setup.exe" })).toThrow(
      /doesn't match/,
    );
  });
  it("never a build that can't update itself (no feed)", () => {
    expect(() => assertPublishable({ ...base, updateFeed: "" })).toThrow(/ELISE_UPDATE_FEED/);
  });
  it("stable needs a signed, non-prerelease build; beta never lands on stable", () => {
    expect(() =>
      assertPublishable({
        ...base,
        channel: "stable",
        version: "0.1.0",
        installerName: "ELISE-0.1.0 Setup.exe",
      }),
    ).toThrow(/signed/);
    expect(() => assertPublishable({ ...base, channel: "stable", signed: true })).toThrow(
      /Pre-release/,
    );
    expect(() =>
      assertPublishable({
        ...base,
        channel: "stable",
        signed: true,
        version: "0.1.0",
        installerName: "ELISE-0.1.0 Setup.exe",
      }),
    ).not.toThrow();
  });
  it("a new version changes the manifest's content (history kept); withdrawing goes back", () => {
    const one = manifestWith(null, entry());
    const two = manifestWith(
      one,
      entry({ version: "0.1.0-beta.2", installerUrl: "https://x/ELISE-Setup-0.1.0-beta.2.exe" }),
    );
    expect(two.releases.map((r: { version: string }) => r.version)).toEqual([
      "0.1.0-beta.1",
      "0.1.0-beta.2",
    ]);
    const back = withdrawn(two, "0.1.0-beta.2");
    expect(back.releases.find((r: { version: string }) => r.version === "0.1.0-beta.2").state).toBe(
      "withdrawn",
    );
    expect(() => withdrawn(two, "9.9.9")).toThrow();
  });
});

describe("what the web offers", () => {
  const TEMPLATE =
    "https://github.com/o/r/releases/download/desktop-{channel}/desktop-releases.json";
  const serve = (byChannel: Record<string, unknown[]>) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const channel = /desktop-(beta|stable)\//.exec(String(url))?.[1] ?? "";
      const releases = byChannel[channel];
      return releases
        ? Response.json({ schemaVersion: 1, releases })
        : new Response("", { status: 404 });
    });

  it("one URL configured once: the channel picks the file, the file picks the version", () => {
    expect(manifestUrlFor(TEMPLATE, "beta")).toBe(
      "https://github.com/o/r/releases/download/desktop-beta/desktop-releases.json",
    );
    expect(manifestUrlFor(TEMPLATE, "stable")).toContain("desktop-stable/");
  });

  it("production: the beta tester gets the beta installer; everyone else doesn't (no stable yet)", async () => {
    env.value = { ELISE_ENV: "production", ELISE_DESKTOP_MANIFEST_URL: TEMPLATE };
    resetDesktopReleaseCache();
    const fetchSpy = serve({ beta: [entry()] });
    expect((await desktopReleaseFor("windows", { tester: true }))?.version).toBe("0.1.0-beta.1");
    expect(await desktopReleaseFor("windows", { tester: false })).toBeNull();
    fetchSpy.mockRestore();
  });

  it("withdrawn and draft versions are never offered; the newest good one is", async () => {
    env.value = { ELISE_ENV: "production", ELISE_DESKTOP_MANIFEST_URL: TEMPLATE };
    resetDesktopReleaseCache();
    const fetchSpy = serve({
      beta: [
        entry(),
        entry({ version: "0.1.0-beta.2", state: "withdrawn" }),
        entry({ version: "0.1.0-beta.3", state: "draft" }),
      ],
    });
    expect((await desktopReleaseFor("windows", { tester: true }))?.version).toBe("0.1.0-beta.1");
    fetchSpy.mockRestore();
  });
});
