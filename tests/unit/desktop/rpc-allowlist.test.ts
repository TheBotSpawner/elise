import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { actionNames } from "../../../desktop/actions-stub";

/**
 * Desktop calls Server Actions by name (ADR-081). The stubs must see every action, and the
 * cloud allowlist must list exactly the "use server" modules — minus sign-in and Desktop approval.
 */
const SRC = join(__dirname, "../../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

const USE_SERVER = /^\s*["']use server["']/;
const useServer = files(SRC)
  .map((p) => ({ p, code: readFileSync(p, "utf8") }))
  .filter(({ code }) => USE_SERVER.test(code))
  .map(({ p, code }) => ({
    key: relative(SRC, p)
      .replaceAll("\\", "/")
      .replace(/\.tsx?$/, ""),
    code,
  }));

const VALUE_EXPORT =
  /^export\s+(?!type\b|interface\b)(?:async\s+function|function|const|let|var|class)\s+(\w+)/gm;

describe("Desktop action stubs", () => {
  it("every runtime export of a 'use server' module is an async function the stub sees", () => {
    expect(useServer.length).toBeGreaterThan(10);
    for (const { key, code } of useServer) {
      const values = [...code.matchAll(VALUE_EXPORT)].map((m) => m[1]).sort();
      expect(actionNames(code).sort(), key).toEqual(values);
      expect(code, `${key}: no re-exports the stub can't see`).not.toMatch(/^export\s*\{/m);
    }
  });

  it("the cloud allowlist is exactly the action modules, minus sign-in and Desktop approval", () => {
    const route = readFileSync(join(SRC, "app/api/desktop/rpc/route.ts"), "utf8");
    const listed = [...route.matchAll(/^\s+"(features\/[\w/-]+)":/gm)].map((m) => m[1]).sort();
    const expected = useServer
      .map((m) => m.key)
      .filter((k) => !["features/auth/actions", "features/desktop/actions"].includes(k))
      .sort();
    expect(listed).toEqual(expected);
  });
});
