import { describe, expect, it } from "vitest";

import { overrideKey } from "../../../desktop/override-key";

/** Desktop's module overrides apply however shared code imports them (ADR-081/092). */
describe("overrideKey", () => {
  const SRC = String.raw`D:\repo\src`;
  it("aliased, absolute (what Vite's alias hands plugins) and relative imports map to one key", () => {
    expect(overrideKey("@/features/auth/actions", undefined, SRC)).toBe("@/features/auth/actions");
    expect(overrideKey("D:/repo/src/features/auth/actions", "x", SRC)).toBe(
      "@/features/auth/actions",
    );
    expect(overrideKey("D:/repo/src/features/home/actions.ts", "x", SRC)).toBe(
      "@/features/home/actions",
    );
    expect(overrideKey("./actions", "D:/repo/src/features/home/home-view.tsx?v=1", SRC)).toBe(
      "@/features/home/actions",
    );
  });
  it("anything outside the shared source keeps its specifier", () => {
    expect(overrideKey("next/link", "D:/repo/src/a.tsx", SRC)).toBe("next/link");
  });
});
