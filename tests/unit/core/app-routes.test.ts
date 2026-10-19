import { describe, expect, it } from "vitest";

import { cloudAppPath, isSettingsRoute, matchAppRoute } from "@/core/platform/app-routes";

/** ELISE's screens by path (ADR-092): the one list the web and Desktop resolve against. */
describe("matchAppRoute", () => {
  it("static paths, with or without a trailing slash", () => {
    expect(matchAppRoute("/")).toEqual({ route: "/", params: {} });
    expect(matchAppRoute("/my-elise/finance/")).toEqual({
      route: "/my-elise/finance",
      params: {},
    });
  });

  it("dynamic segments, decoded; a static segment wins over a dynamic one", () => {
    expect(matchAppRoute("/chat/3f2a")).toEqual({ route: "/chat/[id]", params: { id: "3f2a" } });
    expect(matchAppRoute("/connections/sources/new")?.route).toBe("/connections/sources/new");
    expect(matchAppRoute("/connections/sources/abc")).toEqual({
      route: "/connections/sources/[id]",
      params: { id: "abc" },
    });
    expect(matchAppRoute("/settings/storage/fotos%20viejas")?.params).toEqual({
      category: "fotos viejas",
    });
  });

  it("unknown, malformed or traversal-looking paths match nothing", () => {
    expect(matchAppRoute("/nope")).toBeNull();
    expect(matchAppRoute("/chat/a/b")).toBeNull();
    expect(matchAppRoute("/chat/%E0%A4%A")).toBeNull(); // bad encoding
    expect(matchAppRoute("/chat/..%2F..%2Fsecrets")).toBeNull(); // an encoded slash
  });

  it("settings screens are recognized for the Settings shell", () => {
    expect(isSettingsRoute("/settings/voice")).toBe(true);
    expect(isSettingsRoute("/settings")).toBe(true);
    expect(isSettingsRoute("/my-elise")).toBe(false);
  });
});

describe("cloudAppPath", () => {
  const CLOUD = "https://elise.example.com";
  it("ELISE Cloud's own screens stay in the window, with their query and hash", () => {
    expect(cloudAppPath(new URL(`${CLOUD}/my-elise/finance?tab=budgets#x`), CLOUD)).toBe(
      "/my-elise/finance?tab=budgets#x",
    );
  });
  it("other origins, non-screens and a missing cloud are external", () => {
    expect(cloudAppPath(new URL("https://evil.example.com/my-elise"), CLOUD)).toBeNull();
    expect(cloudAppPath(new URL(`${CLOUD}/api/connect/google`), CLOUD)).toBeNull();
    expect(cloudAppPath(new URL(`${CLOUD}/my-elise`), "")).toBeNull();
  });
});
