import type { HomeDevice, HomeDeviceType, HomeGroup, HomeRoom, HomeScene } from "./model";

/**
 * Natural references → the user's own devices (ADR-079): "luz del escritorio", "aire living",
 * "la tele", "el humidificador". Only real records are returned — the model never invents an
 * id — and when a reference fits several devices with nothing to tell them apart, ELISE asks.
 */

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();

const STOP = new Set([
  "el",
  "la",
  "los",
  "las",
  "lo",
  "del",
  "de",
  "en",
  "al",
  "a",
  "un",
  "una",
  "mi",
  "mis",
  "the",
  "of",
  "in",
  "my",
  "on",
  "todo",
  "toda",
  "todas",
  "todos",
  "all",
]);

const words = (s: string) =>
  fold(s)
    .split(" ")
    .filter((w) => w && !STOP.has(w));

/** Everyday words for each kind of device (es/en). */
const TYPE_WORDS: Record<HomeDeviceType, readonly string[]> = {
  light: [
    "luz",
    "luces",
    "lampara",
    "lamparas",
    "lamparita",
    "foco",
    "focos",
    "light",
    "lights",
    "lamp",
    "bombita",
    "tira",
    "led",
  ],
  climate: [
    "aire",
    "aires",
    "acondicionado",
    "split",
    "ac",
    "clima",
    "calefaccion",
    "climate",
    "thermostat",
    "termostato",
  ],
  switch: ["enchufe", "enchufes", "toma", "tomacorriente", "plug", "switch", "interruptor"],
  fan: ["ventilador", "ventiladores", "fan"],
  humidifier: ["humidificador", "humidifier", "deshumidificador"],
  media_player: [
    "tele",
    "tv",
    "television",
    "televisor",
    "parlante",
    "speaker",
    "musica",
    "equipo",
    "chromecast",
  ],
  sensor: ["sensor", "sensores", "temperatura", "humedad", "termometro"],
};

export function typeFromWords(text: string): HomeDeviceType | null {
  const w = new Set(words(text));
  for (const [type, list] of Object.entries(TYPE_WORDS) as [HomeDeviceType, readonly string[]][])
    if (list.some((x) => w.has(x))) return type;
  return null;
}

const namesOf = (x: { name: string; aliases: string[] }) => [x.name, ...x.aliases];

/** How well a phrase matches a name: every meaningful word of the name appears in the phrase. */
function score(phrase: string[], name: string): number {
  const n = words(name);
  if (!n.length) return 0;
  const hit = n.filter(
    (w) =>
      phrase.includes(w) ||
      phrase.some((p) => p.length > 3 && (p.startsWith(w) || w.startsWith(p))),
  );
  if (hit.length === n.length) return 2 + n.length; // all of the name's words: strong
  return hit.length / n.length; // partial
}

export type Resolution<T> =
  { kind: "one"; item: T } | { kind: "ambiguous"; candidates: T[] } | { kind: "none" };

function pickBest<T>(scored: { item: T; s: number }[]): Resolution<T> {
  const strong = scored.filter((x) => x.s >= 2).sort((a, b) => b.s - a.s);
  if (strong.length) {
    const top = strong.filter((x) => x.s === strong[0]!.s);
    return top.length === 1
      ? { kind: "one", item: top[0]!.item }
      : { kind: "ambiguous", candidates: top.map((x) => x.item) };
  }
  return { kind: "none" };
}

export function resolveRoom(phrase: string, rooms: readonly HomeRoom[]): Resolution<HomeRoom> {
  const p = words(phrase);
  return pickBest(
    rooms.map((r) => ({ item: r, s: Math.max(...namesOf(r).map((n) => score(p, n))) })),
  );
}

export function resolveGroup(phrase: string, groups: readonly HomeGroup[]): Resolution<HomeGroup> {
  const p = words(phrase);
  return pickBest(
    groups.map((g) => ({ item: g, s: Math.max(...namesOf(g).map((n) => score(p, n))) })),
  );
}

export function resolveScene(phrase: string, scenes: readonly HomeScene[]): Resolution<HomeScene> {
  const p = words(phrase).filter(
    (w) => w !== "modo" && w !== "escena" && w !== "mode" && w !== "scene",
  );
  return pickBest(
    scenes.map((s) => ({
      item: s,
      s: Math.max(
        ...namesOf(s).map((n) => score(p, n.replace(/^(modo|escena|mode|scene)\s+/i, ""))),
      ),
    })),
  );
}

/**
 * A device reference. Order: an exact name or alias; then name words (plus the room's name:
 * "luz escritorio" is the light in the Escritorio room); then the kind of device, alone or in a
 * room ("el aire" when there's one, "la luz del living"). Favorites break ties.
 */
export function resolveDevice(
  phrase: string,
  devices: readonly HomeDevice[],
  rooms: readonly HomeRoom[],
): Resolution<HomeDevice> {
  const p = words(phrase);
  const folded = fold(phrase);
  const exact = devices.filter((d) => namesOf(d).some((n) => fold(n) === folded));
  if (exact.length === 1) return { kind: "one", item: exact[0]! };

  const roomOf = (d: HomeDevice) => rooms.find((r) => r.id === d.roomId);
  const type = typeFromWords(phrase);
  const room = resolveRoom(phrase, rooms);
  const inRoom = room.kind === "one" ? room.item : null;

  const scored = devices.map((d) => {
    const own = Math.max(...namesOf(d).map((n) => score(p, n)));
    const r = roomOf(d);
    const withRoom = r
      ? Math.max(...namesOf(d).flatMap((n) => namesOf(r).map((rn) => score(p, `${n} ${rn}`))))
      : 0;
    let s = Math.max(own, withRoom);
    if (type && d.type !== type) s = Math.min(s, 1.5); // "la luz del escritorio" isn't the escritorio's AC
    if (inRoom && d.roomId !== inRoom.id && s < 2) s = 0;
    return { item: d, s: s + (d.favorite ? 0.1 : 0) };
  });
  const byName = pickBest(scored);
  if (byName.kind !== "none") return byName;

  // By kind ("el aire"), within the room when one was named.
  if (type) {
    const pool = devices.filter((d) => d.type === type && (!inRoom || d.roomId === inRoom.id));
    if (pool.length === 1) return { kind: "one", item: pool[0]! };
    if (pool.length > 1) {
      const fav = pool.filter((d) => d.favorite);
      return fav.length === 1
        ? { kind: "one", item: fav[0]! }
        : { kind: "ambiguous", candidates: pool };
    }
  }
  return { kind: "none" };
}
