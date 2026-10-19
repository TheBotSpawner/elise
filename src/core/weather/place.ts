import type { WeatherPlace } from "./model";
import { distanceMeters, type LatLng } from "../location/model";

/**
 * Which place a weather request means (ADR-086). A geocoder's first answer is not the answer:
 * Open-Meteo's search is fuzzy and name-only, so "Capital" comes back as "Capitol, Metro Manila".
 * Here, deterministically and without I/O:
 *
 *   1. what the user wrote — the name and its qualifiers ("Capitol, Metro Manila, Philippines");
 *   2. regional names, only in their region ("Capital", "CABA" mean Buenos Aires in Argentina);
 *   3. candidates whose name doesn't match what was asked are rejected (Capital ≠ Capitol);
 *   4. the rest ranked by significance (capital, region seat, population) and closeness to the
 *      user's region (the place on screen, their shared position, their timezone's country —
 *      weak hints, never a claim about where they are);
 *   5. an unclear result is a question, never a guess on another continent.
 */

export interface PlaceQuery {
  /** The name to search for (after aliases). */
  name: string;
  /** What else the user wrote: region, country ("Metro Manila", "Philippines"). */
  qualifiers: string[];
  /** A country the request is restricted to (from a qualifier or a regional name). */
  country: string | null;
  /** The region a regional name stands for ("Ciudad Autónoma de Buenos Aires"). */
  admin: string | null;
  /** Which regional name was applied, if any (for telemetry). */
  alias: string | null;
}

export interface PlaceHints {
  /** The user's likely country (place on screen, else their timezone's). Weak: ranks only. */
  country: string | null;
  /** The user's shared position (coarse), when there is one. */
  near: LatLng | null;
}

export type PlaceChoice =
  | { kind: "resolved"; place: WeatherPlace; confidence: "high" | "medium" }
  | { kind: "ambiguous"; options: WeatherPlace[] }
  | { kind: "not_found"; rejected: number };

export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const STOP = new Set(["de", "del", "la", "el", "los", "las", "of", "the", "en"]);
const tokens = (s: string) =>
  norm(s)
    .split(" ")
    .filter((t) => t && !STOP.has(t));

// ── Countries by name, in Spanish and English (stdlib: Intl.DisplayNames) ────

let countries: Map<string, string> | null = null;
export function countryCodeOf(name: string): string | null {
  const key = norm(name);
  if (/^[a-z]{2}$/.test(key) && key !== "de") return key.toUpperCase();
  if (!countries) {
    countries = new Map();
    const A = 65;
    for (const lang of ["es", "en"]) {
      const names = new Intl.DisplayNames([lang], { type: "region" });
      for (let i = 0; i < 26; i++)
        for (let j = 0; j < 26; j++) {
          const code = String.fromCharCode(A + i, A + j);
          const n = names.of(code);
          if (n && n !== code) countries.set(norm(n), code);
        }
    }
    countries.set("usa", "US").set("eeuu", "US").set("ee uu", "US").set("uk", "GB");
  }
  return countries.get(key) ?? null;
}

// ── Regional names ───────────────────────────────────────────────────────────

interface Alias {
  country: string;
  name: string;
  admin: string;
  /** Unmistakable outside its region too ("Capital Federal"); else only with that region. */
  unique: boolean;
}

const CABA = { country: "AR", name: "Buenos Aires", admin: "Ciudad Autonoma de Buenos Aires" };
const ALIASES: Record<string, Alias> = {
  capital: { ...CABA, unique: false },
  caba: { ...CABA, unique: false },
  "c a b a": { ...CABA, unique: false },
  "cap fed": { ...CABA, unique: false },
  "capital federal": { ...CABA, unique: true },
  "ciudad autonoma de buenos aires": { ...CABA, unique: true },
  "ciudad de buenos aires": { ...CABA, unique: true },
  "buenos aires capital": { ...CABA, unique: true },
  "capital de buenos aires": { ...CABA, unique: true },
};

/** "Capitol, Metro Manila, Philippines" → name + qualifiers; regional names applied in region. */
export function parsePlaceQuery(raw: string, regionHint: string | null): PlaceQuery {
  const [head = "", ...rest] = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const qualifiers = rest;
  const qualified = qualifiers.map(countryCodeOf).find((c): c is string => c !== null) ?? null;
  const alias = ALIASES[norm(head)];
  const region = qualified ?? regionHint;
  if (alias && (region === alias.country || (alias.unique && !region)))
    return {
      name: alias.name,
      qualifiers: qualifiers.filter((q) => countryCodeOf(q) !== alias.country),
      country: alias.country,
      admin: alias.admin,
      alias: norm(head),
    };
  return { name: head, qualifiers, country: qualified, admin: null, alias: null };
}

// ── Choosing among candidates ────────────────────────────────────────────────

const where = (c: WeatherPlace) => tokens(`${c.admin1 ?? ""} ${c.country ?? ""}`);

/** The candidate is the place asked for, by name (fuzzy look-alikes are rejected). */
function nameMatches(c: WeatherPlace, q: PlaceQuery): boolean {
  const asked = tokens(q.name);
  const named = tokens(c.name);
  if (!asked.length || !named.length) return false;
  if (norm(c.name) === norm(q.name)) return true;
  // "Bariloche" → "San Carlos de Bariloche": every asked word is in the name.
  if (asked.every((w) => named.includes(w))) return true;
  // "Santiago de Chile" → "Santiago", Chile: the extra words name its region or country.
  const extra = asked.filter((w) => !named.includes(w));
  return extra.length < asked.length && extra.every((w) => where(c).includes(w));
}

function qualifierMatches(c: WeatherPlace, qualifier: string): boolean {
  const code = countryCodeOf(qualifier);
  if (code && c.countryCode) return code === c.countryCode;
  const q = norm(qualifier);
  return [c.admin1, c.country].some((x) => {
    const n = x ? norm(x) : "";
    return n !== "" && (n.includes(q) || q.includes(n));
  });
}

const SEATS: Record<string, number> = { PPLC: 3, PPLA: 2, PPLA2: 1 };
/** A capital, a region's seat, or a town of some size (unknown when the provider didn't say). */
const significant = (c: WeatherPlace) =>
  (c.featureCode ? SEATS[c.featureCode] !== undefined : false) || (c.population ?? 0) >= 15_000;
const known = (c: WeatherPlace) => c.featureCode !== undefined || c.population !== undefined;

function score(c: WeatherPlace, q: PlaceQuery, hints: PlaceHints) {
  const nearKm = hints.near ? distanceMeters(hints.near, c) / 1000 : null;
  const near = nearKm === null ? 0 : nearKm <= 100 ? 3 : nearKm <= 500 ? 1.5 : 0;
  const region = hints.country && c.countryCode === hints.country ? 3 : 0;
  const admin = q.admin && c.admin1 && norm(c.admin1) === norm(q.admin) ? 2 : 0;
  const size =
    (c.featureCode ? (SEATS[c.featureCode] ?? 0) : 0) + Math.log10((c.population ?? 0) + 1);
  return { value: size + region + near + admin, local: region > 0 || near > 0 };
}

/** Two candidates this close in score are a real question for the user. */
const CLEAR_LEAD = 1.5;

export function chooseWeatherPlace(
  q: PlaceQuery,
  candidates: readonly WeatherPlace[],
  hints: PlaceHints,
): PlaceChoice {
  const fit = candidates.filter(
    (c) =>
      nameMatches(c, q) &&
      q.qualifiers.every((x) => qualifierMatches(c, x)) &&
      (!q.country || !c.countryCode || c.countryCode === q.country),
  );
  if (!fit.length) return { kind: "not_found", rejected: candidates.length };
  const ranked = fit
    .map((place) => ({ place, ...score(place, q, hints) }))
    .sort((a, b) => b.value - a.value);
  const [top, second] = ranked as [(typeof ranked)[number], ...typeof ranked];
  // What the user qualified (a country, a region, a regional name) is what they meant.
  const qualified = q.qualifiers.length > 0 || q.alias !== null;
  if (
    second &&
    top.value - second.value < CLEAR_LEAD &&
    distanceMeters(top.place, second.place) > 50_000
  )
    return { kind: "ambiguous", options: ranked.slice(0, 3).map((r) => r.place) };
  // A lone village on another continent is a question, not an answer.
  if (!qualified && known(top.place) && !significant(top.place) && !top.local)
    return { kind: "ambiguous", options: [top.place] };
  return { kind: "resolved", place: top.place, confidence: qualified ? "high" : "medium" };
}

/** "Buenos Aires, Ciudad Autónoma de Buenos Aires, Argentina" — one label everywhere. */
export const placeLabel = (p: Pick<WeatherPlace, "name" | "detail">) =>
  [p.name, p.detail].filter(Boolean).join(", ");
