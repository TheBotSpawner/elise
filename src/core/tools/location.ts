import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import {
  coarse,
  LOCATION_LIMITS,
  TRAVEL_MODES,
  type LatLng,
  type LocationCapability,
  type Place,
  type Waypoint,
} from "../location/model";
import { clipText as clip } from "../text";
import { isLocalDateTime, toLocalDateTime, zonedDateTimeToUtc } from "../time";
import type { MapPayload, PlacePayload } from "../workspace/location";

/**
 * Location tools (ADR-023): where places are and how long it takes to get there. Named by
 * capability (never "googleMaps.*"), read-only. "here" means the position the user shared for
 * this session; without it ELISE asks — it never guesses where the user is, and never sends
 * those coordinates back to the model or into a Surface.
 */

function maps(env: ToolRunEnv): LocationCapability {
  return env.providers.get("location", env.binding);
}

const HERE = "here";
const place = z
  .string()
  .trim()
  .min(2)
  .max(300)
  .describe(
    '"here" (the user\'s shared position), "place:<id>" (a place ELISE already showed), or an address / place name.',
  );
const mode = z.enum(TRAVEL_MODES).default("drive").describe("drive, walk, bicycle or transit.");
const departAt = z
  .string()
  .trim()
  .max(40)
  .optional()
  .describe("Leave at this local date-time (YYYY-MM-DDTHH:MM). Omit for now.");

/** The user hasn't shared a position: a Surface asks, the model says so and waits. */
function needsLocation(query: string) {
  const map: MapPayload = {
    mode: "locate",
    query: clip(query, 200),
    center: null,
    places: [],
    route: null,
    comparison: null,
  };
  return {
    output: {
      needsLocation: true,
      instructions:
        "ELISE doesn't know where the user is. Ask them to share their location with the button on screen (only for this session), or to name a place or address. Never guess.",
    },
    display: { kind: "map" as const, map },
  };
}

function waypoint(env: ToolRunEnv, raw: string): Waypoint | "unknown_here" {
  const v = raw.trim();
  if (v.toLowerCase() === HERE)
    return env.ctx.here ? { location: coarse(env.ctx.here) } : "unknown_here";
  if (v.startsWith("place:")) return { placeId: v.slice(6) };
  return { address: v };
}

const label = (raw: string, locale: "es" | "en") =>
  raw.trim().toLowerCase() === HERE
    ? locale === "es"
      ? "Tu ubicación"
      : "Your location"
    : raw.startsWith("place:")
      ? ""
      : clip(raw, 200);

/** Local "YYYY-MM-DDTHH:MM" in the user's timezone → ISO. */
function departure(env: ToolRunEnv, local: string | undefined): string | null {
  const v = local?.slice(0, 16);
  return v && isLocalDateTime(v) ? zonedDateTimeToUtc(v, env.ctx.timezone).toISOString() : null;
}

const mapPlace = (p: Place): MapPayload["places"][number] => ({
  id: clip(p.id, 300),
  name: clip(p.name, 200),
  address: p.address ? clip(p.address, 300) : null,
  location: p.location,
  category: p.category ? clip(p.category, 80) : null,
  rating: p.rating,
  ratingCount: p.ratingCount,
  openNow: p.openNow,
  distanceMeters: p.distanceMeters,
  mapsUrl: p.mapsUrl,
});

/** What the model sees of a place: enough to answer and refer back, no raw URLs to invent from. */
const brief = (p: Place, i: number) => ({
  n: i + 1,
  ref: `place:${p.id}`,
  name: p.name,
  address: p.address,
  category: p.category,
  ...(p.rating != null ? { rating: p.rating, ratings: p.ratingCount } : {}),
  ...(p.openNow != null ? { openNow: p.openNow } : {}),
  ...(p.distanceMeters != null ? { metersAway: p.distanceMeters } : {}),
});

const minutes = (s: number) => Math.max(1, Math.round(s / 60));

// ── Search ───────────────────────────────────────────────────────────────────

const searchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .describe('What to find: "cafés", "pharmacy", "MALBA", "Plaza de Mayo".'),
    near: place.optional().describe('Search around this: "here", a place or an address.'),
    radiusMeters: z.number().int().min(100).max(LOCATION_LIMITS.maxRadiusMeters).optional(),
    closest: z.boolean().default(false).describe("The user wants the nearest ones first."),
    openNow: z.boolean().default(false),
    limit: z.number().int().min(1).max(LOCATION_LIMITS.placesPerSearch).default(6),
  })
  .strict();

export const searchPlacesTool: ToolDefinition = {
  name: "location.searchPlaces",
  capability: "location",
  operation: "searchPlaces",
  description:
    "Find places on a map: businesses, landmarks, venues, or the nearest of something. Shows them on a map. For facts about a place from the web (history, news) use web.search instead.",
  input: searchInput,
  async describe() {
    return { summary: "Find places" };
  },
  async run(raw, env) {
    const q = searchInput.parse(raw);
    let center: MapPayload["center"] = null;
    let near: LatLng | null = null;
    if (q.near) {
      const w = waypoint(env, q.near);
      if (w === "unknown_here") return needsLocation(q.query);
      if ("location" in w) near = w.location;
      else {
        const found = await resolve(env, w);
        if (!found)
          return {
            output: {
              found: false,
              instructions: `Couldn't find "${q.near}". Ask the user where they mean.`,
            },
          };
        near = found.location;
        center = { name: clip(found.name, 200), location: found.location };
      }
    }
    const places = await maps(env).searchPlaces({
      query: q.query,
      near,
      radiusMeters: q.radiusMeters ?? null,
      rank: q.closest && near ? "distance" : "relevance",
      openNow: q.openNow,
      limit: q.limit,
      language: env.ctx.locale,
    });
    if (!places.length)
      return {
        output: {
          found: false,
          instructions: "No places matched. Say so; suggest widening the area or the words.",
        },
      };
    const sorted =
      q.closest && near
        ? [...places].sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0))
        : places;
    return {
      output: {
        found: true,
        ...(near && !center ? { near: "the user's shared location" } : {}),
        ...(center ? { near: center.name } : {}),
        places: sorted.map(brief),
        instructions:
          "The map shows these. Answer briefly (name, distance or rating when useful); don't read addresses aloud unless asked. If the user wanted one specific place and several match, ask which one. Use ref with other location tools.",
      },
      display: {
        kind: "map",
        map: {
          mode: "places",
          query: clip(q.query, 200),
          center,
          places: sorted.slice(0, 10).map(mapPlace),
          route: null,
          comparison: null,
        },
      },
    };
  },
};

/** A named place or address → one place (geocoding first, a place search when it fails). */
async function resolve(env: ToolRunEnv, w: Waypoint): Promise<Place | null> {
  if ("placeId" in w) return maps(env).getPlace(w.placeId, env.ctx.locale);
  if ("location" in w) return null;
  const geo = await maps(env).geocode(w.address, env.ctx.locale);
  if (geo[0]) return { ...geo[0], name: w.address };
  const found = await maps(env).searchPlaces({
    query: w.address,
    near: null,
    radiusMeters: null,
    rank: "relevance",
    openNow: false,
    limit: 1,
    language: env.ctx.locale,
  });
  return found[0] ?? null;
}

// ── One place ────────────────────────────────────────────────────────────────

const getPlaceInput = z
  .object({ place: place.describe('"place:<id>" from a previous result, or a name/address.') })
  .strict();

export const getPlaceTool: ToolDefinition = {
  name: "location.getPlace",
  capability: "location",
  operation: "getPlace",
  description:
    "Details of one place: address, opening hours, open now, phone, website, rating, a photo.",
  input: getPlaceInput,
  async describe() {
    return { summary: "Look up a place" };
  },
  async run(raw, env) {
    const { place: ref } = getPlaceInput.parse(raw);
    const w = waypoint(env, ref);
    if (w === "unknown_here" || "location" in w)
      return {
        output: {
          found: false,
          instructions: "Name the place; use location.reverseGeocode for an address.",
        },
      };
    let p = "placeId" in w ? await maps(env).getPlace(w.placeId, env.ctx.locale) : null;
    if (!p && "address" in w) {
      const hit = await maps(env).searchPlaces({
        query: w.address,
        near: null,
        radiusMeters: null,
        rank: "relevance",
        openNow: false,
        limit: 1,
        language: env.ctx.locale,
      });
      p = hit[0] ? await maps(env).getPlace(hit[0].id, env.ctx.locale) : null;
    }
    if (!p) return { output: { found: false, instructions: "That place wasn't found. Say so." } };
    const payload: PlacePayload = {
      ...mapPlace(p),
      phone: p.phone ? clip(p.phone, 60) : null,
      website: p.website,
      priceLevel: p.priceLevel,
      hours: p.hours.slice(0, 7).map((h) => clip(h, 120)),
      photo: p.photo
        ? {
            url: p.photo.url,
            attributions: p.photo.attributions
              .slice(0, 3)
              .map((a) => ({ name: clip(a.name, 200), url: a.url })),
          }
        : null,
    };
    return {
      output: {
        found: true,
        place: {
          ...brief(p, 0),
          hours: p.hours,
          phone: p.phone,
          website: p.website,
          priceLevel: p.priceLevel,
        },
        instructions: "The place is on screen. Answer what was asked about it, briefly.",
      },
      display: { kind: "place", place: payload },
    };
  },
};

// ── Addresses ────────────────────────────────────────────────────────────────

const geocodeInput = z.object({ address: z.string().trim().min(2).max(300) }).strict();

export const geocodeTool: ToolDefinition = {
  name: "location.geocode",
  capability: "location",
  operation: "geocode",
  description: "Where an address is: its full form and position on a map.",
  input: geocodeInput,
  async describe() {
    return { summary: "Find an address" };
  },
  async run(raw, env) {
    const { address } = geocodeInput.parse(raw);
    const results = await maps(env).geocode(address, env.ctx.locale);
    if (!results.length)
      return {
        output: { found: false, instructions: "That address wasn't found. Ask for more detail." },
      };
    return {
      output: {
        found: true,
        candidates: results.map(brief),
        instructions:
          results.length > 1
            ? "Several addresses match: ask which one before using it."
            : "The address is on the map.",
      },
      display: {
        kind: "map",
        map: {
          mode: "places",
          query: clip(address, 200),
          center: null,
          places: results.map(mapPlace),
          route: null,
          comparison: null,
        },
      },
    };
  },
};

const reverseInput = z
  .object({
    at: z
      .union([
        z.literal(HERE),
        z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
      ])
      .describe('"here" for the user\'s shared position, or coordinates.'),
  })
  .strict();

export const reverseGeocodeTool: ToolDefinition = {
  name: "location.reverseGeocode",
  capability: "location",
  operation: "reverseGeocode",
  description: 'The address at a position — "where am I?" uses "here".',
  input: reverseInput,
  async describe() {
    return { summary: "Find the address" };
  },
  async run(raw, env) {
    const { at } = reverseInput.parse(raw);
    const here = at === HERE;
    if (here && !env.ctx.here) return needsLocation("where am I");
    const point = here ? coarse(env.ctx.here!) : at;
    const results = await maps(env).reverseGeocode(point, env.ctx.locale);
    if (!results[0]) return { output: { found: false, instructions: "No address there. Say so." } };
    // The user's own position stays off the map and out of the output: only the street.
    return {
      output: {
        found: true,
        address: results[0].address,
        approximate: here,
        instructions: here
          ? "Say it's approximately this address (the shared position is coarse)."
          : "Give the address.",
      },
      ...(here
        ? {}
        : {
            display: {
              kind: "map" as const,
              map: {
                mode: "places" as const,
                query: clip(results[0].address ?? "", 200),
                center: null,
                places: results.slice(0, 1).map(mapPlace),
                route: null,
                comparison: null,
              },
            },
          }),
    };
  },
};

// ── Routes ───────────────────────────────────────────────────────────────────

const routeInput = z
  .object({
    from: place,
    to: place,
    stops: z.array(place).max(LOCATION_LIMITS.stops).default([]),
    mode,
    departAt,
  })
  .strict();

export const getRouteTool: ToolDefinition = {
  name: "location.getRoute",
  capability: "location",
  operation: "getRoute",
  description:
    "Route between places: travel time, distance and arrival time, drawn on a map. For the next meeting, read its location from the calendar first. Not turn-by-turn navigation.",
  input: routeInput,
  async describe() {
    return { summary: "Plan a route" };
  },
  async run(raw, env) {
    const r = routeInput.parse(raw);
    const points = [r.from, r.to, ...r.stops].map((p) => waypoint(env, p));
    if (points.includes("unknown_here")) return needsLocation(`${r.from} → ${r.to}`);
    const [origin, destination, ...stops] = points as Waypoint[];
    const departAtIso = departure(env, r.departAt);
    const route = await maps(env).route({
      origin: origin!,
      destination: destination!,
      stops,
      mode: r.mode,
      departAt: departAtIso,
      language: env.ctx.locale,
    });
    if (!route)
      return {
        output: {
          found: false,
          instructions: `There's no ${r.mode} route between those places. Say so; offer another way to travel.`,
        },
      };
    const leave = departAtIso ? new Date(departAtIso) : env.ctx.now;
    const arrival = new Date(leave.getTime() + route.durationSeconds * 1000);
    const fromHere = r.from.trim().toLowerCase() === HERE;
    const shown = await workspaceNames(env, [r.from, r.to]);
    const names = { from: clip(shown(r.from), 200), to: clip(shown(r.to), 200) };
    return {
      output: {
        found: true,
        mode: r.mode,
        minutes: minutes(route.durationSeconds),
        km: Math.round(route.distanceMeters / 100) / 10,
        leaveAt: toLocalDateTime(leave, env.ctx.timezone),
        arriveAt: toLocalDateTime(arrival, env.ctx.timezone),
        ...(route.warnings.length ? { warnings: route.warnings } : {}),
        ...(stops.length && r.mode === "transit" ? { note: "Transit routes ignore stops." } : {}),
        instructions:
          "The route is on screen. Give the time and arrival in one sentence. Travel times are estimates; with traffic for driving.",
      },
      display: {
        kind: "map",
        map: {
          mode: "route",
          query: clip(`${names.from} → ${names.to}`, 200),
          center: null,
          places: [],
          route: {
            mode: r.mode,
            from: names.from,
            to: names.to,
            distanceMeters: Math.round(route.distanceMeters),
            durationSeconds: Math.round(route.durationSeconds),
            arrival: arrival.toISOString(),
            polyline: route.polyline,
            start: route.start,
            end: route.end,
            warnings: route.warnings.map((w) => clip(w, 200)),
            fromHere,
            mapsUrl: route.mapsUrl,
          },
          comparison: null,
        },
      },
    };
  },
};

// ── Comparison ───────────────────────────────────────────────────────────────

const compareInput = z
  .object({
    from: z.array(place).min(1).max(LOCATION_LIMITS.matrixOrigins),
    to: z.array(place).min(1).max(LOCATION_LIMITS.matrixDestinations),
    mode,
    departAt,
  })
  .strict();

export const compareTravelTimesTool: ToolDefinition = {
  name: "location.compareTravelTimes",
  capability: "location",
  operation: "compareTravelTimes",
  description:
    "Compare travel times from one or a few origins to several places (which is closest by time). Use refs from a previous place search when you have them.",
  input: compareInput,
  async describe() {
    return { summary: "Compare travel times" };
  },
  async run(raw, env) {
    const c = compareInput.parse(raw);
    const origins = c.from.map((p) => waypoint(env, p));
    const destinations = c.to.map((p) => waypoint(env, p));
    if ([...origins, ...destinations].includes("unknown_here"))
      return needsLocation(c.to.join(", "));
    const cells = await maps(env).matrix({
      origins: origins as Waypoint[],
      destinations: destinations as Waypoint[],
      mode: c.mode,
      departAt: departure(env, c.departAt),
    });
    const shown = await workspaceNames(env, [...c.from, ...c.to]);
    const rows = cells
      .filter((x) => x.origin < c.from.length && x.destination < c.to.length)
      .sort(
        (a, b) =>
          (a.durationSeconds ?? Number.MAX_SAFE_INTEGER) -
          (b.durationSeconds ?? Number.MAX_SAFE_INTEGER),
      );
    if (!rows.some((x) => x.ok))
      return {
        output: { found: false, instructions: "No routes found between those places. Say so." },
      };
    return {
      output: {
        found: true,
        mode: c.mode,
        times: rows.map((x) => ({
          from: shown(c.from[x.origin]!),
          to: shown(c.to[x.destination]!),
          ...(x.ok
            ? {
                minutes: minutes(x.durationSeconds ?? 0),
                km: Math.round((x.distanceMeters ?? 0) / 100) / 10,
              }
            : { noRoute: true }),
        })),
        instructions: "Fastest first. Say which is closest by time and by how much.",
      },
      display: {
        kind: "map",
        map: {
          mode: "compare",
          query: clip(c.to.map(shown).join(", "), 200),
          center: null,
          places: [],
          route: null,
          comparison: {
            mode: c.mode,
            origins: c.from.map((p) => clip(shown(p), 200)),
            rows: rows.slice(0, 30).map((x) => ({
              origin: x.origin,
              destination: clip(shown(c.to[x.destination]!), 200),
              durationSeconds: x.durationSeconds,
              distanceMeters: x.distanceMeters,
            })),
          },
        },
      },
    };
  },
};

/** A place reference → the name it has on screen (the workspace already holds it). */
async function workspaceNames(env: ToolRunEnv, refs: string[]): Promise<(ref: string) => string> {
  const known = new Map<string, string>();
  for (const s of env.ctx.workspace?.state().surfaces ?? []) {
    if (s.type !== "map" && s.type !== "place") continue;
    const items = s.type === "map" ? (s.payload as MapPayload).places : [s.payload as PlacePayload];
    for (const p of items) known.set(`place:${p.id}`, p.name);
  }
  const missing = refs.filter((r) => r.startsWith("place:") && !known.has(r));
  await Promise.all(
    missing.map(async (r) => {
      const p = await maps(env)
        .getPlace(r.slice(6), env.ctx.locale)
        .catch(() => null);
      if (p) known.set(r, p.name);
    }),
  );
  return (ref) => known.get(ref) ?? (label(ref, env.ctx.locale) || ref);
}

export const LOCATION_TOOLS = [
  searchPlacesTool,
  getPlaceTool,
  geocodeTool,
  reverseGeocodeTool,
  getRouteTool,
  compareTravelTimesTool,
];
