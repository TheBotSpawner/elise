import { describe, expect, it } from "vitest";

import { discoveredDevices, discoveryStep, stepAnswers } from "@/core/home/discovery";

/**
 * Adding devices (ADR-090): the engine's pending setups (shapes as Home Assistant returns them)
 * become ELISE's words; nothing provider-shaped reaches the screen.
 */
const FLOW = "01JABCDEFGHJKMNPQRSTVWXYZ0";

describe("what the engine found on the network", () => {
  it("lists only setups the engine started by itself, named for people, once each", () => {
    const found = discoveredDevices([
      {
        flow_id: FLOW,
        handler: "cast",
        context: { source: "zeroconf", title_placeholders: { name: "Living TV" } },
      },
      {
        flow_id: "01JABCDEFGHJKMNPQRSTVWXYZ1",
        handler: "cast",
        context: { source: "zeroconf", title_placeholders: { name: "Living TV" } },
      },
      { flow_id: "01JABCDEFGHJKMNPQRSTVWXYZ2", handler: "tplink", context: { source: "dhcp" } },
      { flow_id: "01JABCDEFGHJKMNPQRSTVWXYZ3", handler: "hue", context: { source: "user" } }, // a person's own
      { flow_id: "bad id!", handler: "x", context: { source: "ssdp" } },
      "garbage",
    ]);
    expect(found).toEqual([
      { flowId: FLOW, name: "Living TV", kind: "cast" },
      { flowId: "01JABCDEFGHJKMNPQRSTVWXYZ2", name: "Tplink", kind: "tplink" },
    ]);
    expect(discoveredDevices({ not: "a list" })).toEqual([]);
  });
});

describe("one step of adding a device", () => {
  it("an empty form is a confirmation; fields become ELISE's fields (codes are secret)", () => {
    expect(
      discoveryStep(
        {
          type: "form",
          step_id: "zeroconf_confirm",
          data_schema: [],
          description_placeholders: { name: "Hue Bridge" },
        },
        FLOW,
      ),
    ).toEqual({ kind: "confirm", flowId: FLOW, title: "Hue Bridge" });
    const step = discoveryStep(
      {
        type: "form",
        data_schema: [
          { name: "pairing_code", type: "string", required: true },
          { name: "port", type: "integer", optional: true, default: 8080 },
          {
            name: "mode",
            type: "select",
            options: [
              ["a", "Modo A"],
              ["b", "Modo B"],
            ],
          },
        ],
        errors: { pairing_code: "invalid_auth" },
      },
      FLOW,
    );
    expect(step).toMatchObject({
      kind: "form",
      fields: [
        { name: "pairing_code", type: "password", required: true },
        { name: "port", type: "number", required: false, defaultValue: 8080 },
        {
          name: "mode",
          type: "select",
          options: [
            { value: "a", label: "Modo A" },
            { value: "b", label: "Modo B" },
          ],
        },
      ],
      errors: { pairing_code: "invalid_auth" },
    });
  });

  it("added, aborted, and what ELISE can't show yet (browser sign-in, unknown fields)", () => {
    expect(discoveryStep({ type: "create_entry", title: "Living TV" }, FLOW)).toEqual({
      kind: "added",
      name: "Living TV",
    });
    expect(discoveryStep({ type: "abort", reason: "already_configured" }, FLOW)).toEqual({
      kind: "aborted",
      reason: "already_configured",
    });
    expect(discoveryStep({ type: "external", url: "https://x" }, FLOW)).toEqual({
      kind: "unsupported",
      reason: "external",
    });
    expect(
      discoveryStep({ type: "form", data_schema: [{ name: "x", type: "color_rgb" }] }, FLOW),
    ).toEqual({ kind: "unsupported", reason: "form" });
  });

  it("answers keep only the step's own fields, each in its type", () => {
    const fields = [
      { name: "pairing_code", type: "password" as const, required: true },
      { name: "port", type: "number" as const, required: false },
      {
        name: "mode",
        type: "select" as const,
        required: true,
        options: [{ value: "a", label: "A" }],
      },
      { name: "remember", type: "boolean" as const, required: false },
    ];
    expect(
      stepAnswers(fields, {
        pairing_code: "123-45",
        port: "8081",
        mode: "zzz",
        remember: "true",
        sneaky: "x",
      }),
    ).toEqual({ pairing_code: "123-45", port: 8081, remember: true });
  });
});
