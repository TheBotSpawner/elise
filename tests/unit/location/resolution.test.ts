// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import {
  deviceLocationPlan,
  usableDeviceLocation,
  type LatLng,
  type LocationCapability,
  type Place,
  type Route,
} from "@/core/location/model";
import {
  confidenceOf,
  implausibleRoute,
  plausiblePairs,
  rankCandidates,
} from "@/core/location/resolve";
import {
  deviceLocationEnabled,
  locationForTurn,
  setDeviceLocationEnabled,
  stopSharing,
} from "@/features/location/shared-location";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Geographic resolution (ADR-028) with synthetic cities: "Northport" (where the user is) and
 * "Southfield" (~640 km away) both have a "Main Avenue 1200". An address without a city must
 * resolve to the one near the context; an explicit city must always win; a true tie asks.
 */

const NORTHPORT = { lat: -34.6, lng: -58.4 };
const SOUTHFIELD = { lat: -31.4, lng: -64.2 };
const NEIGHBOURHOOD = { lat: -34.58, lng: -58.43 };

const place = (id: string, address: string, location: LatLng): Place => ({
  id,
  name: address,
  address,
  location,
  category: null,
  rating: null,
  ratingCount: null,
  priceLevel: null,
  openNow: null,
  hours: [],
  phone: null,
  website: null,
  mapsUrl: null,
  photo: null,
  distanceMeters: null,
});

const far = place("far", "Main Avenue 1200, Southfield, Westland", SOUTHFIELD);
const near = place("near", "Main Avenue 1200, Northport, Westland", {
  lat: -34.603,
  lng: -58.39,
});
const hood = place("hood", "Greenhill, Northport, Westland", NEIGHBOURHOOD);

describe("candidate ranking", () => {
  it("an address without a city resolves near the context, not to the geocoder's first pick", () => {
    const ranked = rankCandidates("Main Avenue 1200", [far, near], [NEIGHBOURHOOD]);
    expect(ranked[0]!.place.id).toBe("near");
    expect(confidenceOf(ranked)).toBe("medium");
  });

  it("an explicit city always beats proximity", () => {
    const ranked = rankCandidates("Main Avenue 1200, Southfield", [near, far], [NEIGHBOURHOOD]);
    expect(ranked[0]!.place.id).toBe("far");
    expect(confidenceOf(ranked)).toBe("high");
  });

  it("two equally good, far-apart matches with no context to decide → ask", () => {
    expect(confidenceOf(rankCandidates("Main Avenue 1200", [far, near], []))).toBe("low");
  });

  it("the same place found twice is one confident answer", () => {
    const twin = { ...near, id: "near-2", location: { lat: -34.6035, lng: -58.3905 } };
    expect(confidenceOf(rankCandidates("Main Avenue 1200", [near, twin], []))).toBe("high");
  });

  it("a route's ends are paired plausibly; a route far longer than its ends allow is doubtful", () => {
    const from = rankCandidates("Greenhill", [hood], []);
    const to = rankCandidates("Main Avenue 1200", [far, near], []);
    expect(plausiblePairs(from, to)[0]![1].place.id).toBe("near");
    const route = { distanceMeters: 900_000, durationSeconds: 3600, mode: "drive" };
    expect(implausibleRoute(route, NORTHPORT, { lat: -34.62, lng: -58.4 })).toBe(true);
    expect(implausibleRoute({ ...route, distanceMeters: 4_000 }, NORTHPORT, near.location)).toBe(
      false,
    );
  });
});

// ── location.getRoute end to end with a fake provider ────────────────────────

function maps(routeFor: (destinationId: string | undefined) => Partial<Route> | null = () => ({})) {
  const calls: { op: string; arg: unknown }[] = [];
  const capability: LocationCapability = {
    // The geocoder knows only the far one (its "first answer"), and Greenhill.
    geocode: async (address, _lang, bias) => {
      calls.push({ op: "geocode", arg: { address, bias } });
      if (/greenhill/i.test(address)) return [hood];
      if (/southfield/i.test(address)) return [far];
      return /main avenue/i.test(address) ? [far] : [];
    },
    // A place search around the context finds the nearby one too.
    searchPlaces: async (q) => {
      calls.push({ op: "search", arg: q });
      return /main avenue/i.test(q.query) && q.near ? [near] : [];
    },
    getPlace: async () => null,
    reverseGeocode: async () => [],
    route: async (r) => {
      calls.push({ op: "route", arg: r });
      const id = "placeId" in r.destination ? r.destination.placeId : undefined;
      const over = routeFor(id);
      if (!over) return null;
      return {
        mode: r.mode,
        distanceMeters: 5_000,
        durationSeconds: 1_080,
        polyline: null,
        warnings: [],
        start: NEIGHBOURHOOD,
        end: id === "far" ? SOUTHFIELD : near.location,
        mapsUrl: null,
        ...over,
      };
    },
    matrix: async () => [],
  };
  return { capability, calls };
}

function setup(capability: LocationCapability, here: LatLng | null = null) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "location" ? capability : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ here }) };
}

const destinationOf = (calls: { op: string; arg: unknown }[]) =>
  (calls.find((c) => c.op === "route")!.arg as { destination: { placeId?: string } }).destination;

describe("location.getRoute resolution", () => {
  it("from a named neighbourhood to an address without a city: the nearby one, first attempt", async () => {
    const { capability, calls } = maps();
    const { ports, ctx } = setup(capability);
    const out = await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { from: "Greenhill", to: "Main Avenue 1200", mode: "drive" },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { found: true } });
    expect(destinationOf(calls)).toEqual({ placeId: "near" });
    // The pick is said, so a wrong one can be corrected.
    expect(
      (out as { output: { resolved: { taken: string; assumed: boolean }[] } }).output.resolved,
    ).toContainEqual(expect.objectContaining({ taken: near.address, assumed: true }));
  });

  it("no origin named + the device location → the route starts there, no question", async () => {
    const { capability, calls } = maps();
    const { ports, ctx } = setup(capability, { lat: -34.6012345, lng: -58.3912345 });
    const out = await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { to: "Main Avenue 1200", mode: "drive" },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { found: true } });
    const r = calls.find((c) => c.op === "route")!.arg as { origin: { location: LatLng } };
    expect(r.origin).toEqual({ location: { lat: -34.601, lng: -58.391 } });
    expect(destinationOf(calls)).toEqual({ placeId: "near" });
    // The geocoder was biased around the (coarse) position.
    expect((calls[0]!.arg as { bias: LatLng }).bias).toEqual({ lat: -34.601, lng: -58.391 });
  });

  it("no origin and no location → asks to share it (never guesses)", async () => {
    const { capability } = maps();
    const { ports, ctx } = setup(capability);
    const out = await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { to: "Main Avenue 1200" },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { needsLocation: true } });
  });

  it("an explicit origin wins over the device location", async () => {
    const { capability, calls } = maps();
    const { ports, ctx } = setup(capability, { lat: 10, lng: 10 });
    await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { from: "Greenhill", to: "Main Avenue 1200, Southfield", mode: "drive" },
    });
    const r = calls.find((c) => c.op === "route")!.arg as {
      origin: { placeId?: string };
      destination: { placeId?: string };
    };
    expect(r.origin).toEqual({ placeId: "hood" });
    expect(r.destination).toEqual({ placeId: "far" });
  });

  it("a route that doesn't fit its ends is retried with the next plausible candidate", async () => {
    const { capability, calls } = maps((id) =>
      id === "near" ? { distanceMeters: 2_000_000, durationSeconds: 90_000 } : {},
    );
    const { ports, ctx } = setup(capability);
    const out = await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { from: "Greenhill", to: "Main Avenue 1200", mode: "drive" },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { found: true } });
    expect(calls.filter((c) => c.op === "route").map((c) => destinationOf([c]))).toEqual([
      { placeId: "near" },
      { placeId: "far" },
    ]);
  });

  it("a true tie with no context shows both and asks", async () => {
    const both: LocationCapability = {
      ...maps().capability,
      geocode: async () => [far, near],
    };
    const { ports, ctx } = setup(both);
    const out = await executeToolCall(ports, ctx, {
      name: "location.getRoute",
      args: { from: "Main Avenue 1200", to: "Greenhill Station" },
    });
    expect(out).toMatchObject({ status: "succeeded", output: { ambiguous: true } });
  });
});

// ── Device location (browser) ────────────────────────────────────────────────

describe("device location", () => {
  const now = 1_000_000_000;
  it("fresh samples are reused; location questions refresh stale ones; old ones expire", () => {
    const at = (ageMs: number) => ({ capturedAt: now - ageMs, accuracyMeters: 30 });
    expect(deviceLocationPlan(at(60_000), now, true)).toBe("use");
    expect(deviceLocationPlan(at(5 * 60_000), now, true)).toBe("refresh");
    expect(deviceLocationPlan(at(5 * 60_000), now, false)).toBe("use");
    expect(deviceLocationPlan(at(20 * 60_000), now, false)).toBe("none");
    expect(deviceLocationPlan(null, now, true)).toBe("refresh");
    expect(usableDeviceLocation({ capturedAt: now, accuracyMeters: 20_000 }, now)).toBe(false);
  });

  it("only with the setting on: a location question captures once, coarse; others don't ask", async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({
        coords: { latitude: -34.60123456, longitude: -58.38345678, accuracy: 25 },
      } as GeolocationPosition),
    );
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    stopSharing();
    expect(await locationForTurn("¿cuánto tardo hasta el centro?")).toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();

    setDeviceLocationEnabled(true);
    expect(deviceLocationEnabled()).toBe(true);
    expect(await locationForTurn("¿cuánto tardo hasta el centro?")).toEqual({
      lat: -34.601,
      lng: -58.383,
    });
    // A follow-up reuses the fresh sample instead of asking the browser again.
    expect(await locationForTurn("¿y caminando?")).toEqual({ lat: -34.601, lng: -58.383 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    // Nothing about the position is persisted: only the on/off preference.
    expect(Object.keys(localStorage)).toEqual(["elise.location.device"]);
    stopSharing();
    expect(deviceLocationEnabled()).toBe(false);
  });
});
