import { distanceMeters, type LatLng, type Place } from "./model";

/**
 * Geographic candidate resolution (ADR-028). A geocoder's first answer is not the answer: an
 * address without a city ("Av. Corrientes 1234") can resolve to the same street in another
 * city or country. Candidates are ranked deterministically:
 *
 *   1. the words the user wrote (street, number, neighbourhood, city, country) — explicit text
 *      always wins over context;
 *   2. among equally good textual matches, closeness to the context: the user's position, the
 *      other end of the route, what the map already shows;
 *   3. the provider's own order, as a last tiebreak.
 *
 * Confidence says what to do: high → use it; medium → use the strong contextual (or the
 * provider's semantic) winner and say which one; low → ask. No I/O; synthetic places in tests.
 */

export type Confidence = "high" | "medium" | "low";

export interface Ranked {
  place: Place;
  score: number;
  /** Share of the user's words found in the candidate (0–1). */
  text: number;
  /** Kilometres to the nearest context point, when there is context. */
  nearKm: number | null;
}

const STOP = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "y",
  "en",
  "al",
  "a",
  "the",
  "of",
  "and",
  "av",
  "avda",
  "avenida",
  "calle",
  "st",
  "street",
  "ave",
  "avenue",
  "rd",
  "road",
  "nro",
  "no",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Proximity on a coarse scale: same metro area, same region, same country-ish, far. */
const proximity = (km: number | null) =>
  km === null ? 0.5 : km <= 30 ? 1 : km <= 100 ? 0.7 : km <= 500 ? 0.25 : 0;

export function rankCandidates(text: string, candidates: Place[], anchors: LatLng[]): Ranked[] {
  const words = [...new Set(tokens(text))];
  const seen = new Set<string>();
  const unique = candidates.filter((c) => !seen.has(c.id) && seen.add(c.id));
  return unique
    .map((place, i) => {
      const hay = tokens(`${place.name} ${place.address ?? ""}`);
      const found = words.filter(
        (w) => hay.includes(w) || (w.length >= 4 && hay.some((h) => h.startsWith(w))),
      ).length;
      const textScore = words.length ? found / words.length : 0;
      const nearKm = anchors.length
        ? Math.min(...anchors.map((a) => distanceMeters(a, place.location))) / 1000
        : null;
      return {
        place,
        text: textScore,
        nearKm,
        // A missing word (one of three) outweighs any amount of proximity.
        score: textScore + 0.12 * proximity(nearKm) + (i === 0 ? 0.02 : i === 1 ? 0.01 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function confidenceOf(ranked: Ranked[]): Confidence {
  const [a, b] = ranked;
  if (!a) return "low";
  // No word matches lexically ("MALBA" → the museum's full name): the provider's semantic
  // match is used, and named in the answer so the user can correct it — unless it's far off.
  if (a.text < 0.5) return a.nearKm !== null && a.nearKm > 500 ? "low" : "medium";
  if (!b) return a.nearKm === null || a.nearKm <= 500 ? "high" : "medium";
  // The same place found twice (geocoder and place search).
  if (distanceMeters(a.place.location, b.place.location) < 2_000) return "high";
  if (a.text - b.text >= 0.15) return "high";
  // Equally good words: only context can decide, and only if it clearly does.
  if (a.nearKm !== null && b.nearKm !== null && a.nearKm <= 100 && b.nearKm > 300) return "medium";
  return "low";
}

/** A trip's two ends should make sense together: a far pair costs a little, never the words. */
function pairPenalty(km: number): number {
  return km <= 100 ? 0 : km <= 500 ? 0.05 : km <= 1_500 ? 0.08 : 0.11;
}

/** Pairs of candidates for a route, most plausible first (top three of each side). */
export function plausiblePairs(from: Ranked[], to: Ranked[]): [Ranked, Ranked][] {
  const pairs: { pair: [Ranked, Ranked]; score: number }[] = [];
  for (const a of from.slice(0, 3))
    for (const b of to.slice(0, 3)) {
      const km = distanceMeters(a.place.location, b.place.location) / 1000;
      pairs.push({ pair: [a, b], score: a.score + b.score - pairPenalty(km) });
    }
  return pairs.sort((x, y) => y.score - x.score).map((p) => p.pair);
}

/**
 * A route that doesn't fit its endpoints: far longer than the straight line allows, or a
 * driving/walking trip of more than 16 hours. Then the next plausible pair is tried.
 */
export function implausibleRoute(
  route: { distanceMeters: number; durationSeconds: number; mode: string },
  start: LatLng,
  end: LatLng,
): boolean {
  const straight = distanceMeters(start, end);
  return (
    route.distanceMeters > Math.max(straight * 4, straight + 20_000) ||
    (route.mode !== "transit" && route.durationSeconds > 16 * 3600)
  );
}
