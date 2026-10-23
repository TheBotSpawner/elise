import { z } from "zod";

import { IR_CODE, type IrCommand, type IrKind } from "./model";

/**
 * Infrared profiles by brand and model (ADR-117), from SmartIR's public code library (MIT,
 * github.com/smartHomeHub/SmartIR): codes other people captured and published, in the Broadlink
 * format. ELISE reads its index and one profile at a time, keeps a bounded subset of its codes
 * as the device's buttons, and tests them with the person ("¿La tele se apagó?"). Nothing here
 * is installed in the home engine, and the profile's codes are never presented as verified
 * until the person says the device reacted.
 *
 * BroadLink's own app keeps the person's remotes in the manufacturer's cloud, with no official
 * export: those can't be imported (ADR-117 §context). This is the next-best path.
 */

export const IR_PROFILE_KINDS = { tv: "media_player", ac: "climate", fan: "fan" } as const;
export type ProfileKind = keyof typeof IR_PROFILE_KINDS;

export interface ProfileEntry {
  code: number;
  brand: string;
  models: string[];
}

/**
 * SmartIR's docs page for a device class → its Broadlink profiles. The page has one
 * "#### Brand" heading per brand and rows like "[1060](../codes/media_player/1060.json)|UE40F6500<br>LE40D550|Broadlink"
 * (with or without outer pipes). Rows for other controllers are skipped.
 */
export function parseProfileIndex(markdown: string): ProfileEntry[] {
  const out: ProfileEntry[] = [];
  let brand = "";
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^####\s+(.+)$/.exec(line);
    if (heading) {
      brand = heading[1]!.trim().slice(0, 60);
      continue;
    }
    const row = /^\|?\s*\[(\d{1,5})\]\([^)]*\)\s*\|(.*)\|\s*([^|]+?)\s*\|?\s*$/.exec(line);
    if (!row || !brand || !/broadlink/i.test(row[3]!)) continue;
    const models = row[2]!
      .split(/<br\s*\/?>/i)
      .map((m) => m.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((m) => m.slice(0, 60));
    out.push({ code: Number(row[1]), brand, models });
  }
  return out;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Profiles for what the person typed ("Samsung", "samsung ue40", "LG OLED55"), best first. */
export function searchProfiles(index: readonly ProfileEntry[], query: string): ProfileEntry[] {
  const words = fold(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const score = (e: ProfileEntry) => {
    const brand = fold(e.brand);
    const models = fold(e.models.join(" "));
    let s = 0;
    for (const w of words) {
      if (brand === w || brand.startsWith(w)) s += 10;
      else if (models.split(" ").some((m) => m === w)) s += 8;
      else if (models.includes(w)) s += 4;
      else return 0;
    }
    return s;
  };
  return index
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.code - b.e.code)
    .slice(0, 20)
    .map((x) => x.e);
}

const codeOf = (v: unknown) => {
  const c = IR_CODE.safeParse(v);
  return c.success ? c.data : null;
};

const profileFile = z
  .object({
    manufacturer: z.string().max(80).optional(),
    supportedModels: z.array(z.string()).optional(),
    supportedController: z.string().optional(),
    commandsEncoding: z.string().optional(),
    commands: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** The codes a device's buttons may hold in total (the capability row is bounded, 16 kB). */
export const PROFILE_CODE_BUDGET = 11_000;

/** TV / fan buttons, in ELISE's keys, from SmartIR's command names. */
const BUTTONS: Record<string, { key: string; label: string }> = {
  on: { key: "power_on", label: "Encender" },
  off: { key: "power_off", label: "Apagar" },
  volumeUp: { key: "volume_up", label: "Subir volumen" },
  volumeDown: { key: "volume_down", label: "Bajar volumen" },
  mute: { key: "mute", label: "Silenciar" },
  nextChannel: { key: "channel_up", label: "Canal siguiente" },
  previousChannel: { key: "channel_down", label: "Canal anterior" },
};

/** The temperatures and modes an air conditioner keeps first, most used first. */
const AC_TEMPS = [24, 22, 23, 25, 20, 26, 21, 18, 19, 27, 28];
const AC_MODES = ["cool", "heat", "dry", "fan_only", "auto", "heat_cool"];

/**
 * One profile file → the device's buttons, unverified, within the size budget. An air
 * conditioner's codes are whole states (mode + fan + temperature): each becomes a "captured
 * setting" (preset), the same honest model as one learned from the person's remote.
 */
export function profileCommands(raw: unknown, kind: IrKind): IrCommand[] | null {
  const f = profileFile.safeParse(raw);
  if (!f.success) return null;
  if (f.data.commandsEncoding && !/base64/i.test(f.data.commandsEncoding)) return null;
  if (f.data.supportedController && !/broadlink/i.test(f.data.supportedController)) return null;
  const c = f.data.commands;
  const out: IrCommand[] = [];
  let budget = PROFILE_CODE_BUDGET;
  const add = (cmd: IrCommand) => {
    if (!cmd.code || cmd.code.length > budget) return;
    budget -= cmd.code.length;
    out.push(cmd);
  };
  if (kind === "ac") {
    const off = codeOf(c.off);
    if (off) add({ key: "power_off", label: "Apagar", verified: false, code: off });
    const modes = AC_MODES.filter((m) => c[m] && typeof c[m] === "object");
    for (const temp of AC_TEMPS)
      for (const mode of modes) {
        const fans = c[mode] as Record<string, unknown>;
        const fan = "auto" in fans ? "auto" : Object.keys(fans)[0];
        const byTemp = fan ? (fans[fan] as Record<string, unknown> | undefined) : undefined;
        const code = codeOf(byTemp?.[String(temp)]);
        if (!code) continue;
        const label = `${MODE_LABEL[mode] ?? mode} ${temp} °C`;
        add({
          key: `preset_${mode}_${temp}${fan && fan !== "auto" ? `_${fan.replace(/[^a-z0-9]+/g, "_")}` : ""}`.slice(
            0,
            40,
          ),
          label,
          verified: false,
          preset: { hvacMode: mode, temperature: temp, ...(fan ? { fanMode: fan } : {}) },
          code,
        });
      }
    return out.length ? out : null;
  }
  for (const [name, b] of Object.entries(BUTTONS)) {
    const code = codeOf(c[name]);
    if (code) add({ ...b, verified: false, code });
  }
  // Inputs: "HDMI 1" etc., a few.
  const sources =
    c.sources && typeof c.sources === "object" ? (c.sources as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(sources).slice(0, 6)) {
    const code = codeOf(v);
    const key = `input_${fold(name).replace(/ /g, "_")}`.slice(0, 40);
    if (code && /^[a-z0-9_]{1,40}$/.test(key))
      add({ key, label: name.slice(0, 40), verified: false, code });
  }
  return out.length ? out : null;
}

const MODE_LABEL: Record<string, string> = {
  cool: "Frío",
  heat: "Calor",
  dry: "Seco",
  fan_only: "Ventilación",
  auto: "Automático",
  heat_cool: "Automático",
};

/** The button a test presses first: the one whose effect the person can see at once. */
export function testButton(commands: readonly IrCommand[], kind: IrKind): IrCommand | null {
  return (
    commands.find((c) => c.key === "power_off") ??
    commands.find((c) => c.key === "power_on") ??
    (kind === "ac" ? (commands.find((c) => c.preset) ?? null) : null)
  );
}
