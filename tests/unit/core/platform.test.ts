import { describe, expect, it } from "vitest";

import { isCacheableSnapshot, isSafeExternalUrl, parseDeepLink } from "@/core/platform/links";
import { featureSupport, WEB_PLATFORM, type PlatformInfo } from "@/core/platform/platform";

/** One ELISE, several surfaces (ADR-081): capabilities and protocol, never "is Electron". */
const desktop = (over: Partial<PlatformInfo> = {}): PlatformInfo => ({
  kind: "desktop",
  capabilities: ["home_hub", "local_runtime"],
  bridgeProtocolVersion: 1,
  ...over,
});

describe("feature support", () => {
  it("the web never offers Desktop-only capabilities", () => {
    expect(featureSupport(WEB_PLATFORM, { capability: "home_hub" })).toBe("unsupported");
  });

  it("Desktop with the capability → supported; without it or too old → update required", () => {
    expect(featureSupport(desktop(), { capability: "home_hub" })).toBe("supported");
    expect(featureSupport(desktop(), { capability: "auto_update" })).toBe("update_required");
    expect(featureSupport(desktop(), { capability: "home_hub", minProtocol: 2 })).toBe(
      "update_required",
    );
    expect(
      featureSupport(desktop({ bridgeProtocolVersion: null }), { capability: "home_hub" }),
    ).toBe("update_required");
  });
});

describe("deep links", () => {
  const token = "a".repeat(43);

  it("open known screens only", () => {
    expect(parseDeepLink("elise://home")).toEqual({ kind: "navigate", path: "/my-elise/home" });
    expect(parseDeepLink("elise://home/setup")).toEqual({
      kind: "navigate",
      path: "/my-elise/home",
    });
    expect(parseDeepLink("elise://conversation/11111111-1111-4111-8111-111111111111")).toEqual({
      kind: "navigate",
      path: "/history/11111111-1111-4111-8111-111111111111",
    });
  });

  it("complete sign-in with well-formed values only", () => {
    expect(parseDeepLink(`elise://auth/callback?code=${token}&state=${token}`)).toEqual({
      kind: "auth_callback",
      code: token,
      state: token,
    });
    expect(parseDeepLink("elise://auth/callback?code=short&state=x")).toBeNull();
    expect(parseDeepLink(`elise://auth/callback?code=${token}<script>&state=${token}`)).toBeNull();
  });

  it("never run anything: unknown routes, other schemes and malformed links are refused", () => {
    for (const raw of [
      "elise://run?cmd=calc.exe",
      "elise://settings/../../etc",
      "elise://conversation/not-a-uuid",
      "https://evil.example/home",
      "javascript:alert(1)",
      "elise:%%%",
      `elise://home?${"x".repeat(3000)}`,
    ])
      expect(parseDeepLink(raw)).toBeNull();
  });
});

describe("external links and cache", () => {
  it("only plain web URLs leave the app", () => {
    expect(isSafeExternalUrl("https://elise.app/docs")).toBe(true);
    for (const bad of [
      "file:///C:/Windows",
      "javascript:alert(1)",
      "elise://home",
      "https://u:p@x.com",
      "smb://host/share",
    ])
      expect(isSafeExternalUrl(bad)).toBe(false);
  });

  it("caches an allowlist of screens, never arbitrary keys", () => {
    expect(isCacheableSnapshot("page:/my-elise/home")).toBe(true);
    expect(isCacheableSnapshot("page:/finance")).toBe(false);
    expect(isCacheableSnapshot("../secrets")).toBe(false);
  });
});
