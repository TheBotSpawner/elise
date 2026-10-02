import { describe, expect, it, vi } from "vitest";

import { buildContextPackage } from "@/core/agents/context";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  coarse,
  decodePolyline,
  type LocationCapability,
  type Place,
  type Route,
} from "@/core/location/model";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import { forStorage, mapPayload } from "@/core/workspace/location";
import { applyOps, emptyWorkspace, type Surface } from "@/core/workspace/model";
import { describeWorkspace, PAYLOADS } from "@/core/workspace/registry";
import { GoogleMapsLocation } from "@/infrastructure/location/google-maps";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const NOW = new Date("2026-10-02T15:00:00Z");
const OBELISCO = { lat: -34.6037, lng: -58.3816 };
// A precise position the user shared; must never leave the server.
const HERE = { lat: -34.60123456, lng: -58.38345678 };

const place = (id: string, name: string, over: Partial<Place> = {}): Place => ({
  id,
  name,
  address: `${name} 123, CABA`,
  location: { lat: -34.6 - Number(id.length) / 1000, lng: -58.38 },
  category: "Cafe",
  rating: 4.5,
  ratingCount: 120,
  priceLevel: 2,
  openNow: true,
  hours: [],
  phone: null,
  website: null,
  mapsUrl: `https://maps.google.com/?cid=${id}`,
  photo: null,
  distanceMeters: null,
  ...over,
});

function fakeMaps(over: Partial<LocationCapability> = {}) {
  const calls: { op: string; arg: unknown }[] = [];
  const maps: LocationCapability = {
    searchPlaces: async (q) => {
      calls.push({ op: "search", arg: q });
      if (q.query.startsWith("Obelisco")) return [place("obelisco_id_1", "Obelisco")];
      return [
        place("cafe_far_0001", "Café Lejos", { distanceMeters: 900 }),
        place("cafe_near_001", "Café Cerca", { distanceMeters: 120 }),
      ];
    },
    getPlace: async (id) => {
      calls.push({ op: "place", arg: id });
      return place(id, "MALBA", { hours: ["lunes: 12–20"], phone: "+54 11 4808-6500" });
    },
    geocode: async (a) => {
      calls.push({ op: "geocode", arg: a });
      return a.includes("Obelisco") ? [place("geo_obelisco", a, { location: OBELISCO })] : [];
    },
    reverseGeocode: async (at) => {
      calls.push({ op: "reverse", arg: at });
      return [place("geo_here_000", "Av. Corrientes 1000")];
    },
    route: async (r) => {
      calls.push({ op: "route", arg: r });
      const route: Route = {
        mode: r.mode,
        distanceMeters: 7400,
        durationSeconds: 1260,
        polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
        warnings: [],
        start: { lat: -34.608, lng: -58.372 },
        end: { lat: -34.577, lng: -58.403 },
        mapsUrl: "https://www.google.com/maps/dir/?api=1&destination=MALBA&travelmode=driving",
      };
      return route;
    },
    matrix: async (m) => {
      calls.push({ op: "matrix", arg: m });
      return [
        { origin: 0, destination: 0, ok: true, durationSeconds: 900, distanceMeters: 5000 },
        { origin: 0, destination: 1, ok: true, durationSeconds: 300, distanceMeters: 1200 },
        { origin: 0, destination: 2, ok: false, durationSeconds: null, distanceMeters: null },
      ];
    },
    ...over,
  };
  return { maps, calls };
}

function setup(maps: LocationCapability, here: typeof HERE | null = null) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "location" ? maps : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW, here }) };
}

/** Every call here succeeds; narrows the outcome. */
async function run(...args: Parameters<typeof executeToolCall>) {
  const out = await executeToolCall(...args);
  if (out.status !== "succeeded") throw new Error(`${out.status}: ${JSON.stringify(out)}`);
  return out;
}

describe("location model", () => {
  it("decodes polylines and makes shared positions coarse", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
    expect(coarse(HERE)).toEqual({ lat: -34.601, lng: -58.383 });
  });
});

describe("location tools", () => {
  it("cafés near a landmark: resolves the landmark, searches around it, shows a map", async () => {
    const { maps, calls } = fakeMaps();
    const { ports, ctx } = setup(maps);
    const out = await run(ports, ctx, {
      name: "location.searchPlaces",
      args: { query: "cafés", near: "Obelisco, Buenos Aires" },
    });
    expect(out.status).toBe("succeeded");
    const search = calls.find((c) => c.op === "search")!.arg as { near: unknown; rank: string };
    expect(search.near).toEqual(OBELISCO);
    expect(search.rank).toBe("relevance");
    expect(out.display?.kind).toBe("map");
    const surfaces = surfacesFromOutcome("location.searchPlaces", out, { key: "k" });
    expect(surfaces[0]?.type).toBe("map");
    expect(PAYLOADS.map.safeParse(surfaces[0]!.payload).success).toBe(true);
  });

  it("closest: distance order, and the places are numbered with refs for follow-ups", async () => {
    const { maps, calls } = fakeMaps();
    const { ports, ctx } = setup(maps, HERE);
    const out = await run(ports, ctx, {
      name: "location.searchPlaces",
      args: { query: "café", near: "here", closest: true },
    });
    const output = out.output as { places: { name: string; ref: string }[] };
    expect(output.places.map((p) => p.name)).toEqual(["Café Cerca", "Café Lejos"]);
    expect(output.places[0]!.ref).toBe("place:cafe_near_001");
    const search = calls.find((c) => c.op === "search")!.arg as { near: unknown; rank: string };
    expect(search.rank).toBe("distance");
    // The provider only ever gets the coarse position.
    expect(search.near).toEqual(coarse(HERE));
    let ws = emptyWorkspace();
    ws = applyOps(
      ws,
      surfacesFromOutcome("location.searchPlaces", out, { key: "k" }).map((surface) => ({
        op: "present" as const,
        surface,
        at: NOW.toISOString(),
      })),
    );
    expect(describeWorkspace(ws, "UTC")).toContain('2) "Café Lejos"');
  });

  it("never sends the user's coordinates back to the model or into a Surface", async () => {
    const { maps } = fakeMaps();
    const { ports, ctx } = setup(maps, HERE);
    for (const call of [
      { name: "location.searchPlaces", args: { query: "farmacia", near: "here", closest: true } },
      { name: "location.reverseGeocode", args: { at: "here" } },
      { name: "location.getRoute", args: { from: "here", to: "MALBA" } },
    ]) {
      const out = await run(ports, ctx, call);
      const text = JSON.stringify([out.output, out.display]);
      expect(text, call.name).not.toContain("-34.601");
      expect(text, call.name).not.toContain("-58.383");
    }
  });

  it("without a shared position, asks instead of guessing", async () => {
    const { maps, calls } = fakeMaps();
    const { ports, ctx } = setup(maps, null);
    const out = await run(ports, ctx, {
      name: "location.searchPlaces",
      args: { query: "café", near: "here", closest: true },
    });
    expect(out.output).toMatchObject({ needsLocation: true });
    expect(out.display).toMatchObject({ kind: "map", map: { mode: "locate" } });
    expect(calls).toHaveLength(0);
  });

  it("a route: time, distance, arrival in the user's timezone, map with the line", async () => {
    const { maps, calls } = fakeMaps();
    const { ports, ctx } = setup(maps);
    const out = await run(ports, ctx, {
      name: "location.getRoute",
      args: { from: "Plaza de Mayo", to: "MALBA", departAt: "2026-10-02T18:30" },
    });
    expect(out.output).toMatchObject({
      found: true,
      mode: "drive",
      minutes: 21,
      km: 7.4,
      leaveAt: "2026-10-02T18:30",
      arriveAt: "2026-10-02T18:51",
    });
    const r = calls.find((c) => c.op === "route")!.arg as { departAt: string };
    expect(r.departAt).toBe("2026-10-02T21:30:00.000Z");
    const [surface] = surfacesFromOutcome("location.getRoute", out, { key: "k" });
    expect(surface?.title).toBe("Plaza de Mayo → MALBA");
  });

  it("a route from the shared position is stored without its line or start", async () => {
    const { maps } = fakeMaps();
    const { ports, ctx } = setup(maps, HERE);
    const out = await run(ports, ctx, {
      name: "location.getRoute",
      args: { from: "here", to: "MALBA", mode: "walk" },
    });
    const [surface] = surfacesFromOutcome("location.getRoute", out, { key: "k" });
    const live = surface!.payload as ReturnType<typeof mapPayload.parse>;
    expect(live.route?.fromHere).toBe(true);
    expect(live.route?.polyline).not.toBeNull();
    const stored = forStorage(surface as Surface).payload as typeof live;
    expect(stored.route?.polyline).toBeNull();
    expect(stored.route?.start).toBeNull();
    expect(stored.route?.durationSeconds).toBe(1260);
  });

  it("compares travel times fastest first; a missing route is said, not invented", async () => {
    const { maps } = fakeMaps();
    const { ports, ctx } = setup(maps);
    const out = await run(ports, ctx, {
      name: "location.compareTravelTimes",
      args: { from: ["Plaza de Mayo"], to: ["MALBA", "Obelisco", "Isla Martín García"] },
    });
    const times = (out.output as { times: { to: string; minutes?: number; noRoute?: true }[] })
      .times;
    expect(times[0]).toMatchObject({ to: "Obelisco", minutes: 5 });
    expect(times.at(-1)).toMatchObject({ to: "Isla Martín García", noRoute: true });
    expect(PAYLOADS.map.safeParse((out.display as { map: unknown }).map).success).toBe(true);
  });

  it("place details become a Place Surface with hours and a phone link", async () => {
    const { maps } = fakeMaps();
    const { ports, ctx } = setup(maps);
    const out = await run(ports, ctx, {
      name: "location.getPlace",
      args: { place: "place:malba_place_01" },
    });
    const [surface] = surfacesFromOutcome("location.getPlace", out, { key: "k" });
    expect(surface?.type).toBe("place");
    expect(surface?.ref).toEqual({ resource: "place", id: "malba_place_01" });
  });

  it("payloads reject markup links and out-of-range coordinates", () => {
    const base = {
      mode: "places",
      query: "x",
      center: null,
      route: null,
      comparison: null,
    } as const;
    const ok = mapPayload.safeParse({ ...base, places: [] });
    expect(ok.success).toBe(true);
    const bad = mapPayload.safeParse({
      ...base,
      places: [{ ...place("p1_place_id", "X"), mapsUrl: "javascript:alert(1)" }],
    });
    expect(bad.success).toBe(false);
    const far = mapPayload.safeParse({
      ...base,
      center: { name: "x", location: { lat: 120, lng: 0 } },
      places: [],
    });
    expect(far.success).toBe(false);
  });

  it("the model learns about Location only when maps are configured", () => {
    const base = {
      user: { displayName: null, locale: "es" as const, timezone: "UTC" },
      now: NOW,
      availableCapabilities: [],
      history: [],
      userMessage: "cafés cerca del Obelisco",
    };
    expect(buildContextPackage(base).instructions).not.toContain("location.searchPlaces");
    const on = buildContextPackage({ ...base, location: { here: false } }).instructions;
    expect(on).toContain("location.searchPlaces");
    expect(on).toContain("hasn't shared their position");
  });
});

// ── Google Maps adapter (HTTP mocked) ────────────────────────────────────────

function http(responses: Record<string, unknown>) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    requests.push({ url: u, init: init ?? {} });
    const key = Object.keys(responses).find((k) => u.includes(k));
    const body = key ? responses[key] : null;
    if (typeof body === "number") return new Response("{}", { status: body });
    return new Response(JSON.stringify(body ?? {}), { status: 200 });
  });
  return { fn: fn as unknown as typeof fetch, requests };
}

describe("Google Maps adapter", () => {
  it("text search: key header, field mask, distance rank around a point", async () => {
    const { fn, requests } = http({
      "places:searchText": {
        places: [
          {
            id: "ChIJcafe00001",
            displayName: { text: "Café Tortoni" },
            formattedAddress: "Av. de Mayo 825",
            location: { latitude: -34.6087, longitude: -58.3786 },
            primaryTypeDisplayName: { text: "Café" },
            rating: 4.4,
            userRatingCount: 50000,
            currentOpeningHours: { openNow: true },
            googleMapsUri: "https://maps.google.com/?cid=1",
          },
          { id: "no-location" },
        ],
      },
    });
    const usage: unknown[] = [];
    const g = new GoogleMapsLocation("server-key", (u) => usage.push(u), fn);
    const places = await g.searchPlaces({
      query: "café",
      near: OBELISCO,
      radiusMeters: null,
      rank: "distance",
      openNow: true,
      limit: 5,
      language: "es",
    });
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: "Café Tortoni", openNow: true, rating: 4.4 });
    expect(places[0]!.distanceMeters).toBeGreaterThan(500);
    const req = requests[0]!;
    const headers = req.init.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("server-key");
    expect(headers["X-Goog-FieldMask"]).toContain("places.displayName");
    expect(headers["X-Goog-FieldMask"]).not.toContain("*");
    expect(JSON.parse(String(req.init.body))).toMatchObject({
      textQuery: "café",
      rankPreference: "DISTANCE",
      openNow: true,
      locationBias: { circle: { center: { latitude: -34.6037, longitude: -58.3816 } } },
    });
    expect(usage).toEqual([{ api: "places.search", units: 1 }]);
  });

  it("details with a key-free photo URL and author attribution", async () => {
    const { fn, requests } = http({
      "/media?": { photoUri: "https://lh3.googleusercontent.com/photo" },
      "places/ChIJmalba0001": {
        id: "ChIJmalba0001",
        displayName: { text: "MALBA" },
        location: { latitude: -34.577, longitude: -58.403 },
        priceLevel: "PRICE_LEVEL_MODERATE",
        regularOpeningHours: { weekdayDescriptions: ["lunes: Cerrado"] },
        photos: [
          {
            name: "places/ChIJmalba0001/photos/AbC_123",
            authorAttributions: [{ displayName: "Ana", uri: "https://maps.google.com/contrib/1" }],
          },
        ],
      },
    });
    const g = new GoogleMapsLocation("k", undefined, fn);
    const p = await g.getPlace("ChIJmalba0001", "es");
    expect(p).toMatchObject({ name: "MALBA", priceLevel: 2, hours: ["lunes: Cerrado"] });
    expect(p?.photo).toEqual({
      url: "https://lh3.googleusercontent.com/photo",
      attributions: [{ name: "Ana", url: "https://maps.google.com/contrib/1" }],
    });
    expect(requests[1]!.url).toContain("skipHttpRedirect=true");
    expect(await g.getPlace("../../evil", "es")).toBeNull();
  });

  it("routes: Routes API with traffic, parses duration, keeps the user's position out of the link", async () => {
    const { fn, requests } = http({
      computeRoutes: {
        routes: [
          {
            distanceMeters: 7400,
            duration: "1260s",
            polyline: { encodedPolyline: "abc" },
            legs: [
              {
                startLocation: { latLng: { latitude: -34.601, longitude: -58.383 } },
                endLocation: { latLng: { latitude: -34.577, longitude: -58.403 } },
              },
            ],
          },
        ],
      },
    });
    const g = new GoogleMapsLocation("k", undefined, fn);
    const r = await g.route({
      origin: { location: { lat: -34.601, lng: -58.383 } },
      destination: { address: "MALBA" },
      stops: [],
      mode: "drive",
      departAt: null,
      language: "es",
    });
    expect(r).toMatchObject({ durationSeconds: 1260, distanceMeters: 7400, polyline: "abc" });
    expect(r!.mapsUrl).not.toContain("-34.601");
    expect(r!.mapsUrl).toContain("destination=MALBA");
    expect(requests[0]!.url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    });
  });

  it("route matrix: omitted index means 0; no route is reported as such", async () => {
    const { fn } = http({
      computeRouteMatrix: [
        { destinationIndex: 1, duration: "300s", distanceMeters: 1200, condition: "ROUTE_EXISTS" },
        { condition: "ROUTE_EXISTS", duration: "900s", distanceMeters: 5000 },
        { destinationIndex: 2, condition: "ROUTE_NOT_FOUND" },
      ],
    });
    const usage: { units: number }[] = [];
    const g = new GoogleMapsLocation("k", (u) => usage.push(u), fn);
    const cells = await g.matrix({
      origins: [{ address: "A" }],
      destinations: [{ address: "B" }, { address: "C" }, { address: "D" }],
      mode: "walk",
      departAt: null,
    });
    expect(cells).toContainEqual({
      origin: 0,
      destination: 0,
      ok: true,
      durationSeconds: 900,
      distanceMeters: 5000,
    });
    expect(cells).toContainEqual({
      origin: 0,
      destination: 2,
      ok: false,
      durationSeconds: null,
      distanceMeters: null,
    });
    expect(usage[0]!.units).toBe(3);
  });

  it("maps provider errors to product errors (a bad key is configuration, not a crash)", async () => {
    const g = new GoogleMapsLocation("k", undefined, http({ searchText: 403 }).fn);
    await expect(
      g.searchPlaces({
        query: "x",
        near: null,
        radiusMeters: null,
        rank: "relevance",
        openNow: false,
        limit: 1,
        language: "es",
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const geo = new GoogleMapsLocation(
      "k",
      undefined,
      http({ geocode: { status: "OVER_QUERY_LIMIT" } }).fn,
    );
    await expect(geo.geocode("x", "es")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
