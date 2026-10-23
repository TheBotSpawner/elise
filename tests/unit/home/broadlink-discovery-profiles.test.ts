import { describe, expect, it } from "vitest";

import {
  broadlinkFlowId,
  BROADLINK_FLOW,
  helloPacket,
  parseHelloReply,
} from "@/core/home/broadlink";
import { discoveredDevices } from "@/core/home/discovery";
import {
  parseProfileIndex,
  PROFILE_CODE_BUDGET,
  profileCommands,
  searchProfiles,
  testButton,
} from "@/core/home/ir-profiles";
import { validateAction, type HomeDevice, type IrCapability } from "@/core/home/model";
import { toServiceCalls } from "@/infrastructure/home/home-assistant";

import { broadcastOf } from "../../../home-hub/broadlink-scan";

/**
 * ADR-117: Broadlinks found by this computer's own hello (the engine in WSL2 never sees their
 * DHCP), the router left out of "devices to add", and published profiles instead of re-learning.
 * Synthetic packets and profiles only.
 */

describe("Broadlink hello", () => {
  it("builds the documented 0x30-byte packet with its checksum", () => {
    const p = helloPacket("192.168.1.10", 50_000, new Date(2026, 9, 23, 18, 5));
    expect(p.length).toBe(0x30);
    expect([...p.slice(0x18, 0x1c)]).toEqual([10, 1, 168, 192]); // reversed address
    expect(p[0x1c]! | (p[0x1d]! << 8)).toBe(50_000);
    expect(p[0x26]).toBe(6);
    const sum = [...p].reduce((n, b, i) => (i === 0x20 || i === 0x21 ? n : n + b), 0xbeaf) & 0xffff;
    expect(p[0x20]! | (p[0x21]! << 8)).toBe(sum);
  });

  it("reads a reply: type, MAC, name, lock", () => {
    const r = new Uint8Array(0x80);
    r[0x34] = 0x0d; // 0x520d: RM4C mini
    r[0x35] = 0x52;
    [0x77, 0x66, 0x55, 0x44, 0xd1, 0x1c].forEach((b, i) => (r[0x3a + i] = b));
    new TextEncoder().encode("Universal Remote").forEach((b, i) => (r[0x40 + i] = b));
    const d = parseHelloReply(r, "192.168.1.31");
    expect(d).toEqual({
      host: "192.168.1.31",
      mac: "1cd144556677",
      devtype: 0x520d,
      model: "RM4C mini",
      name: "Universal Remote",
      locked: false,
    });
    expect(BROADLINK_FLOW.exec(broadlinkFlowId(d!.mac))?.[1]).toBe(d!.mac);
  });

  it("an unknown type is still a Broadlink (never a guessed model); garbage is ignored", () => {
    const r = new Uint8Array(0x80);
    r[0x34] = 0x99;
    r[0x3a] = 1;
    expect(parseHelloReply(r, "192.168.1.2")?.model).toBe("Broadlink");
    expect(parseHelloReply(new Uint8Array(10), "192.168.1.2")).toBeNull();
  });

  it("broadcasts only to the interface's own subnet", () => {
    expect(broadcastOf("192.168.1.37", "255.255.255.0")).toBe("192.168.1.255");
    expect(broadcastOf("10.0.5.9", "255.255.0.0")).toBe("10.0.255.255");
  });
});

describe("what's offered to add", () => {
  it("the router's UPnP gateway is not a home device", () => {
    const flows = [
      {
        flow_id: "flow_abcdefghij1",
        handler: "upnp",
        context: { source: "ssdp", title_placeholders: { name: "Huawei IGD" } },
      },
      {
        flow_id: "flow_abcdefghij2",
        handler: "cast",
        context: { source: "zeroconf", title_placeholders: { name: "TV Living" } },
      },
    ];
    expect(discoveredDevices(flows).map((d) => d.name)).toEqual(["TV Living"]);
  });
});

const INDEX = `
#### Samsung
| Code | Supported Models | Controller |
| ------------- | -------------------------- | ------------- |
[1060](../codes/media_player/1060.json)|UE40F6500<br>LE40D550|Broadlink
[7060](../codes/media_player/7060.json)|UA32EH5000M|ESPHome

#### LG
| [1040](../codes/media_player/1040.json) | 22MT47DC | Broadlink |
`;

const CODE =
  "JgBQAAABKJMSExISEhMSExITEhISExI3EjcSNxI3EjcSNxI3EjcSEhI3EhMSEhITEhISExITEhISNxITEjcSNxI3EjcSNxI3EgAFKQABKkkSAA0FAAAAAAAAAAA=";

describe("published profiles (SmartIR, MIT)", () => {
  it("indexes Broadlink profiles per brand, skips other controllers, and searches", () => {
    const index = parseProfileIndex(INDEX);
    expect(index).toEqual([
      { code: 1060, brand: "Samsung", models: ["UE40F6500", "LE40D550"] },
      { code: 1040, brand: "LG", models: ["22MT47DC"] },
    ]);
    expect(searchProfiles(index, "samsung").map((e) => e.code)).toEqual([1060]);
    expect(searchProfiles(index, "LE40D550").map((e) => e.code)).toEqual([1060]);
    expect(searchProfiles(index, "bgh")).toEqual([]);
  });

  it("a TV profile becomes unverified buttons in ELISE's keys", () => {
    const cmds = profileCommands(
      {
        supportedController: "Broadlink",
        commandsEncoding: "Base64",
        commands: { on: CODE, off: CODE, volumeUp: CODE, mute: CODE, sources: { "HDMI 1": CODE } },
      },
      "tv",
    )!;
    expect(cmds.map((c) => c.key)).toEqual([
      "power_on",
      "power_off",
      "volume_up",
      "mute",
      "input_hdmi_1",
    ]);
    expect(cmds.every((c) => !c.verified && c.code === CODE)).toBe(true);
    expect(testButton(cmds, "tv")?.key).toBe("power_off");
  });

  it("an AC profile becomes captured settings, most used first, within the size budget", () => {
    const temps = Object.fromEntries([18, 20, 22, 24, 26].map((t) => [String(t), CODE]));
    const cmds = profileCommands(
      { commands: { off: CODE, cool: { auto: temps, high: temps }, heat: { auto: temps } } },
      "ac",
    )!;
    expect(cmds[0]).toMatchObject({ key: "power_off" });
    expect(cmds[1]).toMatchObject({
      key: "preset_cool_24",
      preset: { hvacMode: "cool", temperature: 24, fanMode: "auto" },
    });
    expect(cmds.reduce((n, c) => n + (c.code?.length ?? 0), 0)).toBeLessThanOrEqual(
      PROFILE_CODE_BUDGET,
    );
  });

  it("refuses profiles for other controllers or encodings", () => {
    expect(
      profileCommands({ supportedController: "ESPHome", commands: { off: CODE } }, "tv"),
    ).toBeNull();
    expect(
      profileCommands({ commandsEncoding: "Pronto", commands: { off: CODE } }, "tv"),
    ).toBeNull();
  });

  it("a profile button is sent as the engine's raw b64 code; a learned one by its name", () => {
    const ir: IrCapability = {
      type: "ir",
      controllerId: "00000000-0000-4000-8000-000000000001",
      device: "elise_0123456789ab",
      kind: "tv",
      commands: [
        { key: "power_off", label: "Apagar", verified: true, code: CODE },
        { key: "mute", label: "Silenciar", verified: true },
      ],
    };
    const tv = {
      name: "Tele Pieza",
      type: "media_player",
      state: {},
      capabilities: [ir],
    } as unknown as HomeDevice;
    const off = validateAction(tv, { type: "power", value: false });
    const mute = validateAction(tv, { type: "button", value: "mute" });
    expect(off.ok && off.action).toMatchObject({ type: "ir", command: "power_off", code: CODE });
    expect(toServiceCalls("remote.rm4c", [off.ok ? off.action : (null as never)])[0]).toMatchObject(
      {
        service: "send_command",
        service_data: { command: `b64:${CODE}`, num_repeats: 1 },
      },
    );
    expect(
      toServiceCalls("remote.rm4c", [mute.ok ? mute.action : (null as never)])[0],
    ).toMatchObject({
      service_data: { device: "elise_0123456789ab", command: "mute" },
    });
  });
});
