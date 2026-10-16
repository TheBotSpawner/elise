import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { en } from "@/lib/i18n/dictionaries/en";
import { es } from "@/lib/i18n/dictionaries/es";

/**
 * Shipped copy is for anyone (ADR-072): no example assumes the user knows the people, companies
 * or projects ELISE was built around. Only what ships is scanned — never user data.
 */
const INTERNAL = /\b(firbot|rsfa|centro larrea|ctdi|utn|sistema 10h)\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|json)$/.test(f) ? [p] : [];
  });
}

/** Every string under a key whose name says it is a placeholder or an example. */
function placeholders(node: unknown, path = ""): [string, string][] {
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => {
    const at = path ? `${path}.${k}` : k;
    if (typeof v === "string") return /placeholder/i.test(k) ? [[at, v] as [string, string]] : [];
    return placeholders(v, at);
  });
}

describe("product copy", () => {
  it("no internal company, client or project name ships in the product", () => {
    const leaks = files("src").filter((f) => INTERNAL.test(readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  });

  it("a new Vision suggests something anyone could want", () => {
    expect(es.native.goals.visionForm.statementPlaceholder).toBe("Construir un negocio sostenible");
    expect(en.native.goals.visionForm.statementPlaceholder).toBe("Build a sustainable business");
    expect(es.native.goals.visionForm.hint).toBe("Una dirección a largo plazo.");
  });

  it("placeholders show the kind of content in a few words, in both languages", () => {
    for (const [lang, dict] of [
      ["es", es],
      ["en", en],
    ] as const) {
      const long = placeholders(dict).filter(([, v]) => v.trim().split(/\s+/).length > 8);
      expect(long, lang).toEqual([]);
    }
  });

  it("Spanish and English have the same placeholders", () => {
    const keys = (d: unknown) =>
      placeholders(d)
        .map(([k]) => k)
        .sort();
    expect(keys(es)).toEqual(keys(en));
  });
});
