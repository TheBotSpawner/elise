import { describe, expect, it } from "vitest";

import { MY_ELISE, SECTIONS } from "@/components/elise/navigation/nav-items";
import { spaceColor, spaceIcon, suggestAppearance } from "@/core/knowledge/appearance";
import { resolveBindings } from "@/core/providers/resolver";
import { en } from "@/lib/i18n/dictionaries/en";
import { es } from "@/lib/i18n/dictionaries/es";
import { timezoneLabel, timezoneOptions } from "@/lib/timezones";

import { binding, NATIVE_BINDING } from "../fixtures/core-fakes";

describe("navigation", () => {
  it("calls past conversations History (Home is where you talk to ELISE)", () => {
    expect(SECTIONS.find((s) => s.href === "/chat")).toBeDefined();
    expect(en.nav.chat).toBe("History");
    expect(es.nav.chat).toBe("Historial");
  });

  it("gives every My Elise module an icon", () => {
    expect(MY_ELISE.every((m) => typeof m.icon === "object" || typeof m.icon === "function")).toBe(
      true,
    );
  });
});

describe("Knowledge Space appearance", () => {
  it("falls back to defaults for unknown keys and suggests a look from the name", () => {
    expect(spaceIcon("nope")).toBe("folder");
    expect(spaceColor(null)).toBe("slate");
    expect(suggestAppearance("University")).toEqual({ icon: "graduation", color: "blue" });
    expect(suggestAppearance("Work")).toEqual({ icon: "briefcase", color: "cyan" });
    expect(suggestAppearance("Japan Trip")).toEqual({ icon: "plane", color: "amber" });
    expect(suggestAppearance("Misc")).toBeNull();
  });
});

describe("timezone picker", () => {
  it("shows friendly labels, searchable by country, stores the IANA id", () => {
    expect(timezoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires, Argentina");
    expect(timezoneLabel("Europe/London")).toBe("London, Europe");
    const [ba] = timezoneOptions(
      ["America/Argentina/Buenos_Aires"],
      new Date("2026-09-29T12:00:00Z"),
    );
    expect(ba).toMatchObject({ value: "America/Argentina/Buenos_Aires" });
    expect(ba!.keywords).toContain("Argentina");
    expect(ba!.detail).toContain("GMT-3");
  });
});

describe("“Use this account for”", () => {
  it("routes a request that names the context to that account", () => {
    const northwind = binding({
      connectionId: "22222222-2222-4222-8222-222222222222",
      capability: "calendar",
      providerKey: "google",
      label: "Work account",
      contextLabel: "Northwind",
    });
    const personal = binding({
      connectionId: "11111111-1111-4111-8111-111111111111",
      capability: "calendar",
      providerKey: "google",
      label: "Personal",
      isDefault: true,
    });
    const r = resolveBindings([{ ...NATIVE_BINDING, capability: "tasks" }, personal, northwind], {
      capability: "calendar",
      operationKind: "write",
      destination: "my Northwind calendar",
    });
    expect(r).toMatchObject({
      kind: "resolved",
      bindings: [{ connectionId: northwind.connectionId }],
    });
  });
});
