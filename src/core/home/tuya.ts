import { z } from "zod";

import {
  TUYA_AC_FANS,
  TUYA_AC_MODES,
  type HomeDeviceType,
  type IrKind,
  type TuyaIrCapability,
} from "./model";

/**
 * ADR-118: the remotes a person already set up in Smart Life (Tuya), as ELISE devices. Pure:
 * Tuya's documented responses (Universal Infrared v2.0) in, ELISE's capability out. Nothing here
 * talks to Tuya.
 */

/** Tuya's infrared categories (GET /v2.0/infrareds/{id}/categories, documented values). */
const CATEGORY_KIND: Record<number, IrKind> = { 2: "tv", 5: "ac", 8: "fan" };
export const TUYA_DIY_CATEGORY = 999;

export const KIND_TYPE: Record<IrKind, HomeDeviceType> = {
  tv: "media_player",
  ac: "climate",
  fan: "fan",
  other: "switch",
};

/** An infrared hub's category in Tuya's device list ("wnykq": Smart IR, and its kin). */
export const isTuyaIrHub = (category: string) => /ykq$/.test(category);

export const tuyaProviderKey = (infraredId: string, remoteId: string) =>
  `tuya:${infraredId}:${remoteId}`;
export const TUYA_KEY_PREFIX = "tuya:";

const id = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

export const tuyaDeviceSchema = z.object({
  id,
  name: z.string().max(200).catch(""),
  category: z.string().max(40).catch(""),
  online: z.boolean().catch(false),
  sub: z.boolean().catch(false),
  uid: z.string().max(80).optional(),
});
export type TuyaDevice = z.infer<typeof tuyaDeviceSchema>;

export const tuyaRemoteSchema = z.object({
  remote_id: id,
  remote_name: z.string().max(200).catch(""),
  category_id: z.coerce.number().int(),
  brand_name: z.string().max(80).optional().catch(undefined),
  remote_index: z.coerce.number().int().optional().catch(undefined),
});
export type TuyaRemote = z.infer<typeof tuyaRemoteSchema>;

export const tuyaKeysSchema = z.object({
  category_id: z.coerce.number().int().optional(),
  remote_index: z.coerce.number().int().optional().catch(undefined),
  key_list: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        key_id: z.coerce.number().int().optional().catch(undefined),
        key_name: z.string().max(60).optional().catch(undefined),
      }),
    )
    .catch([]),
  key_range: z
    .array(
      z.object({
        mode: z.coerce.number().int(),
        temp_list: z
          .array(
            z.object({
              temp: z.coerce.number(),
              fan_list: z.array(z.object({ fan: z.coerce.number().int() })).catch([]),
            }),
          )
          .catch([]),
      }),
    )
    .optional()
    .catch(undefined),
});
export type TuyaKeys = z.infer<typeof tuyaKeysSchema>;

export const kindOf = (categoryId: number): IrKind => CATEGORY_KIND[categoryId] ?? "other";

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Tuya's key ("Vol+", "volume_up", "Power") → the meaning ELISE knows it by, or a safe slug. */
const MEANINGS: [RegExp, string][] = [
  [/^(power[\s_-]*on|on|encender)$/, "power_on"],
  [/^(power[\s_-]*off|off|apagar)$/, "power_off"],
  [/^(power|power[\s_/-]*(on[\s_/-]*off|toggle)|encendido)$/, "power_toggle"],
  [/^vol(ume)?[\s_]*(\+|up|plus|subir)$/, "volume_up"],
  [/^vol(ume)?[\s_]*(-|down|minus|bajar)$/, "volume_down"],
  [/^(mute|silencio|silenciar)$/, "mute"],
  [/^(ch(annel)?|canal)[\s_]*(\+|up|plus)$/, "channel_up"],
  [/^(ch(annel)?|canal)[\s_]*(-|down|minus)$/, "channel_down"],
  [/^(input|source|tv[\s/]*av|av[\s/]*tv|fuente|entrada)$/, "input"],
  [/^(play|reproducir)$/, "play"],
  [/^(pause|pausa)$/, "pause"],
  [/^(next|siguiente)$/, "next"],
  [/^(prev(ious)?|anterior)$/, "previous"],
  [/^(speed|wind|fan)[\s_]*(\+|up)$/, "speed_up"],
  [/^(speed|wind|fan)[\s_]*(-|down)$/, "speed_down"],
  [/^(osc(illate|illation)?|swing|shake|oscilar)$/, "oscillate"],
];

const LABELS: Record<string, string> = {
  power_on: "Encender",
  power_off: "Apagar",
  power_toggle: "Encendido",
  volume_up: "Subir volumen",
  volume_down: "Bajar volumen",
  mute: "Silenciar",
  channel_up: "Canal +",
  channel_down: "Canal −",
  input: "Fuente",
  play: "Reproducir",
  pause: "Pausa",
  next: "Siguiente",
  previous: "Anterior",
  speed_up: "Más velocidad",
  speed_down: "Menos velocidad",
  oscillate: "Oscilar",
};

export function meaningOf(key: string, name?: string): string {
  for (const said of [key, name ?? ""].map(fold)) {
    const hit = MEANINGS.find(([re]) => re.test(said));
    if (hit) return hit[1];
  }
  const slug = fold(key)
    .replace(/\+/g, "_plus")
    .replace(/-$/, "_minus")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return (/^\d/.test(slug) ? `num_${slug}` : slug || "key").slice(0, 40);
}

/**
 * One remote and its keys → the capability ELISE keeps (null when Tuya listed nothing usable).
 * Keys stay Tuya's own (`tuya`); `key` is what ELISE and voice call them.
 */
export function remoteCapability(
  infraredId: string,
  remote: TuyaRemote,
  keys: TuyaKeys,
): TuyaIrCapability | null {
  const kind = kindOf(remote.category_id);
  const seen = new Set<string>();
  const list = keys.key_list
    .map((k) => {
      let key = meaningOf(k.key, k.key_name);
      for (let n = 2; seen.has(key); n++) key = `${key.slice(0, 36)}_${n}`;
      seen.add(key);
      const label = (LABELS[key] ?? k.key_name ?? k.key).trim().slice(0, 40) || key;
      return { key, label, tuya: k.key, ...(k.key_id !== undefined ? { keyId: k.key_id } : {}) };
    })
    .slice(0, 80);
  const modes =
    kind === "ac"
      ? (keys.key_range ?? [])
          .filter((m) => m.mode >= 0 && m.mode < TUYA_AC_MODES.length)
          .map((m) => ({
            mode: TUYA_AC_MODES[m.mode]!,
            temps: [
              ...new Set(
                m.temp_list
                  .map((t) => t.temp)
                  .filter((t) => Number.isInteger(t) && t >= 10 && t <= 35),
              ),
            ]
              .sort((a, b) => a - b)
              .slice(0, 30),
            fans: [
              ...new Set(
                m.temp_list
                  .flatMap((t) => t.fan_list.map((f) => f.fan))
                  .filter((f) => f >= 0 && f < TUYA_AC_FANS.length)
                  .map((f) => TUYA_AC_FANS[f]!),
              ),
            ],
          }))
          .slice(0, 5)
      : [];
  if (!list.length && !modes.length) return null;
  return {
    type: "tuya_ir",
    infraredId,
    remoteId: remote.remote_id,
    categoryId: remote.category_id,
    ...(remote.remote_index !== undefined
      ? { remoteIndex: remote.remote_index }
      : keys.remote_index !== undefined
        ? { remoteIndex: keys.remote_index }
        : {}),
    kind,
    keys: list,
    ...(modes.length ? { ac: { modes } } : {}),
  };
}

/** Which key "Probar" presses: reversible first (mute), then power. Never a guess beyond those. */
export function tuyaTestAction(
  cap: TuyaIrCapability,
): { type: "button"; value: string } | { type: "power"; value: true } | null {
  if (cap.kind === "ac" && cap.ac?.modes.length) return { type: "power", value: true };
  for (const k of ["mute", "power_toggle", "power_on"])
    if (cap.keys.some((x) => x.key === k)) return { type: "button", value: k };
  return null;
}

/** "Aire" and "aire " are the same name: what dedup with the person's other devices compares. */
export const sameName = (a: string, b: string) => fold(a) === fold(b);
