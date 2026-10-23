import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import { LOCATION_SIGNAL } from "@/core/agents/tool-selection";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  describeItinerary,
  distinctItineraries,
  meetsModes,
  type LocationCapability,
  type Route,
  type TransitItinerary,
} from "@/core/location/model";
import { mapPayload } from "@/core/workspace/location";
import { GoogleMapsLocation, transitItinerary } from "@/infrastructure/location/google-maps";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

vi.mock("server-only", () => ({}));

/**
 * ADR-113: public transport with its lines. Fixtures follow Google's Routes v2 schema
 * (RouteLegStep / RouteLegStepTransitDetails) — synthetic, never a verified real trip.
 */

const TZ = "America/Argentina/Buenos_Aires";
const NOW = new Date("2026-10-23T14:00:00-03:00");
const ll = (latitude: number, longitude: number) => ({ latLng: { latitude, longitude } });
const walkStep = (s: number, m: number) => ({
  travelMode: "WALK",
  staticDuration: `${s}s`,
  distanceMeters: m,
});
const ride = (o: {
  type: string;
  short?: string;
  name?: string;
  headsign?: string;
  from?: string;
  to?: string;
  dep?: string;
  arr?: string;
  stops?: number;
  color?: string;
  vehicleName?: string;
}) => ({
  travelMode: "TRANSIT",
  staticDuration: "900s",
  distanceMeters: 4200,
  transitDetails: {
    ...(o.headsign ? { headsign: o.headsign } : {}),
    ...(o.stops !== undefined ? { stopCount: o.stops } : {}),
    stopDetails: {
      ...(o.from ? { departureStop: { name: o.from, location: ll(-34.58, -58.42) } } : {}),
      ...(o.to ? { arrivalStop: { name: o.to, location: ll(-34.6, -58.44) } } : {}),
      ...(o.dep ? { departureTime: o.dep } : {}),
      ...(o.arr ? { arrivalTime: o.arr } : {}),
    },
    transitLine: {
      ...(o.short ? { nameShort: o.short } : {}),
      ...(o.name ? { name: o.name } : {}),
      ...(o.color ? { color: o.color, textColor: "#ffffff" } : {}),
      agencies: [{ name: "Operadora de prueba" }],
      vehicle: { type: o.type, ...(o.vehicleName ? { name: { text: o.vehicleName } } : {}) },
    },
  },
});
const raw = (steps: unknown[], duration = 1980) =>
  ({
    distanceMeters: 6100,
    duration: `${duration}s`,
    polyline: { encodedPolyline: "abc" },
    legs: [{ startLocation: ll(-34.57, -58.44), endLocation: ll(-34.6, -58.45), steps }],
  }) as Parameters<typeof transitItinerary>[0];

const BUS = raw([
  walkStep(180, 210),
  walkStep(60, 80),
  ride({
    type: "BUS",
    short: "152",
    name: "Línea 152",
    headsign: "Olivos",
    from: "Av. Cabildo 2000",
    to: "Av. Santa Fe y Pueyrredón",
    dep: "2026-10-23T17:05:00Z",
    arr: "2026-10-23T17:25:00Z",
    stops: 14,
    color: "#1e88e5",
    vehicleName: "Colectivo",
  }),
  walkStep(300, 350),
]);
const BUS_SUBWAY = raw([
  walkStep(120, 150),
  ride({
    type: "BUS",
    short: "60",
    from: "Parada A",
    to: "Estación Plaza Italia",
    dep: "2026-10-23T17:05:00Z",
    arr: "2026-10-23T17:15:00Z",
  }),
  walkStep(120, 90),
  ride({
    type: "SUBWAY",
    short: "D",
    name: "Línea D",
    headsign: "Catedral",
    from: "Plaza Italia",
    to: "Pueyrredón",
    dep: "2026-10-23T17:20:00Z",
    arr: "2026-10-23T17:26:00Z",
    stops: 3,
  }),
]);
const TRAIN_BUS = raw([
  ride({ type: "HEAVY_RAIL", name: "Mitre", headsign: "Retiro", from: "Belgrano C", to: "Retiro" }),
  ride({ type: "BUS", short: "152" }),
]);

describe("Google's transit steps → an itinerary", () => {
  it("walk + bus + walk: line, direction, stops and times exactly as given; walks merged", () => {
    const it = transitItinerary(BUS)!;
    expect(it.legs.map((l) => l.kind)).toEqual(["walk", "transit", "walk"]);
    expect(it.legs[0]).toEqual({ kind: "walk", durationSeconds: 240, distanceMeters: 290 });
    expect(it.legs[1]).toMatchObject({
      vehicle: "bus",
      vehicleName: "Colectivo",
      line: "152",
      lineName: "Línea 152",
      headsign: "Olivos",
      board: { name: "Av. Cabildo 2000" },
      alight: { name: "Av. Santa Fe y Pueyrredón" },
      stops: 14,
      color: "#1e88e5",
      agency: "Operadora de prueba",
    });
    expect(it).toMatchObject({ transfers: 0, walkMeters: 640, walkSeconds: 540 });
    // Leaving = the first ride minus the walk to it; arriving = the last ride plus the walk after.
    expect(it.departAt).toBe("2026-10-23T17:01:00.000Z");
    expect(it.arriveAt).toBe("2026-10-23T17:30:00.000Z");
  });

  it("bus + subway with a walk between: one transfer, letters as lines", () => {
    const it = transitItinerary(BUS_SUBWAY)!;
    expect(it.transfers).toBe(1);
    expect(
      it.legs
        .filter((l) => l.kind === "transit")
        .map((l) => [l.kind === "transit" && l.vehicle, l.kind === "transit" && l.line]),
    ).toEqual([
      ["bus", "60"],
      ["subway", "D"],
    ]);
  });

  it("missing fields stay missing: no direction, no stops, a line known only by its name", () => {
    const it = transitItinerary(TRAIN_BUS)!;
    const [train, bus] = it.legs as Extract<
      TransitItinerary["legs"][number],
      { kind: "transit" }
    >[];
    expect(train).toMatchObject({
      vehicle: "train",
      line: "Mitre",
      lineName: null,
      headsign: "Retiro",
    });
    expect(bus).toMatchObject({
      line: "152",
      headsign: null,
      board: { name: null },
      stops: null,
      departAt: null,
    });
    expect(it.departAt).toBeNull();
    expect(transitItinerary({ duration: "60s", legs: [{}] })).toBeNull();
  });

  it("what the model reads keeps every line, stop and walk", () => {
    expect(describeItinerary(transitItinerary(BUS)!, TZ, "es")).toEqual([
      "Caminar 4 min (290 m)",
      'Colectivo 152, hacia "Olivos", subir en Av. Cabildo 2000 14:05, bajar en Av. Santa Fe y Pueyrredón 14:25, 14 paradas',
      "Caminar 5 min (350 m)",
    ]);
    expect(describeItinerary(transitItinerary(TRAIN_BUS)!, TZ, "es")[1]).toBe("Colectivo 152");
  });

  it("Google's 'Autobús' / 'Subterráneo' are said the Argentine way; the same trip later is one option", () => {
    const g = transitItinerary(
      raw([
        ride({
          type: "SUBWAY",
          short: "D",
          vehicleName: "Subterráneo",
          from: "Catedral",
          to: "Juramento",
        }),
      ]),
    )!;
    expect(describeItinerary(g, TZ, "es")[0]).toMatch(/^Subte D/);
    const later = transitItinerary(
      raw([
        ride({
          type: "SUBWAY",
          short: "D",
          vehicleName: "Subterráneo",
          from: "Catedral",
          to: "Juramento",
          dep: "2026-10-23T17:30:00Z",
        }),
      ]),
    )!;
    expect(distinctItineraries([g, later, transitItinerary(BUS)!])).toHaveLength(2);
  });

  it("'solo colectivo' is not met by an itinerary with subte", () => {
    expect(meetsModes(transitItinerary(BUS)!, ["bus"])).toBe(true);
    expect(meetsModes(transitItinerary(BUS_SUBWAY)!, ["bus"])).toBe(false);
    expect(meetsModes(transitItinerary(BUS_SUBWAY)!, ["bus", "subway"])).toBe(true);
  });
});

describe("the Routes request", () => {
  const http = (body: unknown) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { fn: fn as unknown as typeof fetch, requests };
  };
  const headers = (init: RequestInit) => new Headers(init.headers as HeadersInit);

  it("transit: TRANSIT, alternatives, preferences, arrival time only, steps in the field mask (never *)", async () => {
    const { fn, requests } = http({ routes: [BUS, BUS_SUBWAY] });
    const g = new GoogleMapsLocation("k", undefined, fn);
    const arriveBy = new Date(Date.now() + 86_400_000).toISOString();
    const r = await g.route({
      origin: { address: "Conde 3095, CABA" },
      destination: { address: "Ramón Falcón 3167, CABA" },
      stops: [{ address: "ignored" }],
      mode: "transit",
      departAt: new Date(Date.now() + 3_600_000).toISOString(),
      arriveBy,
      transitModes: ["bus"],
      transitPreference: "fewer_transfers",
      language: "es",
    });
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body).toMatchObject({
      travelMode: "TRANSIT",
      computeAlternativeRoutes: true,
      transitPreferences: { allowedTravelModes: ["BUS"], routingPreference: "FEWER_TRANSFERS" },
      arrivalTime: arriveBy,
      languageCode: "es-419",
    });
    expect(body.departureTime).toBeUndefined();
    expect(body.intermediates).toBeUndefined();
    expect(body.routingPreference).toBeUndefined();
    const mask = headers(requests[0]!.init).get("X-Goog-FieldMask")!;
    expect(mask).toContain("routes.legs.steps.transitDetails");
    expect(mask).toContain("routes.legs.steps.staticDuration");
    expect(mask).not.toContain("*");
    expect(r?.itineraries?.map((i) => i.transfers)).toEqual([0, 1]);
  });

  it("driving is unchanged: no transit fields, no steps in the mask", async () => {
    const { fn, requests } = http({ routes: [raw([])] });
    const g = new GoogleMapsLocation("k", undefined, fn);
    const r = await g.route({
      origin: { address: "A" },
      destination: { address: "B" },
      stops: [],
      mode: "drive",
      departAt: null,
      language: "es",
    });
    const body = JSON.parse(String(requests[0]!.init.body));
    expect(body.transitPreferences).toBeUndefined();
    expect(body.computeAlternativeRoutes).toBeUndefined();
    expect(headers(requests[0]!.init).get("X-Goog-FieldMask")).not.toContain("steps");
    expect(r?.itineraries).toBeUndefined();
  });
});

describe("location.getRoute with transit", () => {
  const route = (itineraries: TransitItinerary[] | undefined): Route => ({
    mode: "transit",
    distanceMeters: 6100,
    durationSeconds: 1980,
    polyline: null,
    warnings: [],
    start: null,
    end: null,
    mapsUrl: null,
    ...(itineraries ? { itineraries } : {}),
  });
  function setup(r: Route) {
    const calls: Parameters<LocationCapability["route"]>[0][] = [];
    const maps = {
      geocode: async () => [],
      searchPlaces: async () => [],
      route: async (q: Parameters<LocationCapability["route"]>[0]) => {
        calls.push(q);
        return r;
      },
    } as unknown as LocationCapability;
    const { ports } = makePorts([]);
    ports.providers = {
      get: ((c: string) => (c === "location" ? maps : undefined)) as ProviderFactory["get"],
    };
    const call = async (args: unknown) => {
      const out = await executeToolCall(ports, makeCtx({ now: NOW, timezone: TZ }), {
        name: "location.getRoute",
        args,
      });
      if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
      return out;
    };
    return { calls, call };
  }
  const BUS_IT = transitItinerary(BUS)!;
  const MIXED_IT = transitItinerary(BUS_SUBWAY)!;

  it("the lines reach the model and the card; the answer must say them (not only the time)", async () => {
    const s = setup(route([BUS_IT, MIXED_IT]));
    const out = await s.call({ from: "-34.570,-58.440", to: "-34.600,-58.450", mode: "transit" });
    const o = out.output as { itineraries: { steps: string[] }[]; instructions: string };
    expect(o.itineraries[0]!.steps[1]).toContain("Colectivo 152");
    expect(o.itineraries[0]!.steps[1]).toContain('hacia "Olivos"');
    expect(o.instructions).toMatch(/say WHICH line/);
    expect(o.instructions).toMatch(/never only the total time/);
    const map = mapPayload.parse((out.display as { map: unknown }).map);
    expect(map.route!.itineraries[0]!.legs[1]).toMatchObject({
      kind: "transit",
      line: "152",
      headsign: "Olivos",
      board: "Av. Cabildo 2000",
    });
    expect(map.route!.itineraries).toHaveLength(2);
  });

  it("'solo colectivo': an itinerary with subte is never offered as meeting it", async () => {
    const s = setup(route([MIXED_IT, BUS_IT]));
    const out = await s.call({
      from: "-34.570,-58.440",
      to: "-34.600,-58.450",
      mode: "transit",
      transitModes: ["bus"],
      onlyTransitModes: true,
    });
    const o = out.output as { itineraries: { steps: string[] }[] };
    expect(o.itineraries).toHaveLength(1);
    expect(o.itineraries[0]!.steps.join(" ")).not.toContain("Subte");
    const none = setup(route([MIXED_IT]));
    const o2 = (
      await none.call({
        from: "-34.570,-58.440",
        to: "-34.600,-58.450",
        mode: "transit",
        transitModes: ["bus"],
        onlyTransitModes: true,
      })
    ).output as {
      noneOnlyWith?: string[];
      instructions: string;
      itineraries: { usesOtherVehicles?: boolean }[];
    };
    expect(o2.noneOnlyWith).toEqual(["bus"]);
    expect(o2.itineraries[0]!.usesOtherVehicles).toBe(true);
    expect(o2.instructions).toMatch(/No itinerary uses only the vehicle/);
  });

  it("'llegar a las 14:15 mañana' is an arrival time (Buenos Aires), transit implied, never both times", async () => {
    const s = setup(route([BUS_IT]));
    await s.call({ from: "-34.570,-58.440", to: "-34.600,-58.450", arriveBy: "2026-10-24T14:15" });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]).toMatchObject({
      mode: "transit",
      departAt: null,
      arriveBy: "2026-10-24T17:15:00.000Z",
    });
  });

  it("no lines from the provider → says so, never invents one", async () => {
    const s = setup(route([]));
    const o = (await s.call({ from: "-34.570,-58.440", to: "-34.600,-58.450", mode: "transit" }))
      .output as {
      stepsMissing?: boolean;
      instructions: string;
    };
    expect(o.stepsMissing).toBe(true);
    expect(o.instructions).toMatch(/never name a line from memory/);
  });
});

describe("intent", () => {
  it("rioplatense transit questions bring the location tools", () => {
    for (const q of [
      "¿qué bondi me tomo para ir a Palermo?",
      "¿qué línea me deja cerca?",
      "¿qué combinación hago?",
      "¿dónde me bajo?",
      "¿por qué ramal?",
    ])
      expect(LOCATION_SIGNAL.test(q), q).toBe(true);
  });
});
