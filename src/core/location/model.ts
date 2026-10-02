/**
 * Location (ADR-023): places, addresses and travel in the physical world. Canonical and
 * vendor-free: the Core knows "Location", never the maps provider behind it. Distinct from Web
 * (pages about the world) — Location answers where things are and how long it takes to get there.
 *
 * The user's own position is never read silently: it exists only when the user shared it for
 * this session, it is coarse (rounded), and it is never stored or logged.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface PlacePhoto {
  /** A short-lived, key-free image URL the provider issued for this photo. */
  url: string;
  /** Authors the provider requires to be credited next to the photo. */
  attributions: { name: string; url: string | null }[];
}

export interface Place {
  /** Provider place id (opaque). */
  id: string;
  name: string;
  address: string | null;
  location: LatLng;
  /** Provider's primary type in plain words ("Cafe", "Museum"). */
  category: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** 0 (free) – 4 (very expensive). */
  priceLevel: number | null;
  openNow: boolean | null;
  /** Weekly hours, one line per day, as the provider words them. */
  hours: string[];
  phone: string | null;
  website: string | null;
  /** The place on the provider's own map (opening it is the user's choice). */
  mapsUrl: string | null;
  photo: PlacePhoto | null;
  /** Straight-line metres from the search centre, when there is one. */
  distanceMeters: number | null;
}

export type TravelMode = "drive" | "walk" | "bicycle" | "transit";
export const TRAVEL_MODES = ["drive", "walk", "bicycle", "transit"] as const;

/** Where a route starts, stops or ends. */
export type Waypoint = { address: string } | { placeId: string } | { location: LatLng };

export interface Route {
  mode: TravelMode;
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline (Google's polyline algorithm), for drawing only. */
  polyline: string | null;
  /** Provider notices the user must see (tolls, closures). */
  warnings: string[];
  /** Start and end as the provider resolved them, for markers. */
  start: LatLng | null;
  end: LatLng | null;
  /** The same trip on the provider's own map; never carries a raw user position. */
  mapsUrl: string | null;
}

export interface MatrixCell {
  origin: number;
  destination: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /** False when no route exists for this pair and mode. */
  ok: boolean;
}

export interface PlaceSearch {
  query: string;
  /** Bias (or rank by distance) around this point. */
  near: LatLng | null;
  radiusMeters: number | null;
  /** "Closest" asks for distance order; otherwise relevance. */
  rank: "relevance" | "distance";
  openNow: boolean;
  limit: number;
  language: "es" | "en";
}

/** A maps provider (Google Maps Platform…), isolated in infrastructure. */
export interface LocationProvider {
  readonly id: string;
  searchPlaces(q: PlaceSearch, signal?: AbortSignal): Promise<Place[]>;
  getPlace(id: string, language: "es" | "en", signal?: AbortSignal): Promise<Place | null>;
  /** `near` biases ambiguous addresses toward a region (never restricts them). */
  geocode(
    address: string,
    language: "es" | "en",
    near?: LatLng | null,
    signal?: AbortSignal,
  ): Promise<Place[]>;
  reverseGeocode(at: LatLng, language: "es" | "en", signal?: AbortSignal): Promise<Place[]>;
  route(
    r: {
      origin: Waypoint;
      destination: Waypoint;
      stops: Waypoint[];
      mode: TravelMode;
      departAt: string | null;
      language: "es" | "en";
    },
    signal?: AbortSignal,
  ): Promise<Route | null>;
  matrix(
    m: { origins: Waypoint[]; destinations: Waypoint[]; mode: TravelMode; departAt: string | null },
    signal?: AbortSignal,
  ): Promise<MatrixCell[]>;
}

/** What tools use: the provider behind a cache, timeouts and usage tracking. */
export type LocationCapability = Omit<LocationProvider, "id">;

export const LOCATION_LIMITS = {
  placesPerSearch: 8,
  defaultRadiusMeters: 2_000,
  maxRadiusMeters: 50_000,
  stops: 5,
  matrixOrigins: 3,
  matrixDestinations: 10,
  timeoutMs: 8_000,
  /** Places and geocodes change slowly; routes depend on traffic. */
  cachePlaceMs: 10 * 60_000,
  cacheRouteMs: 2 * 60_000,
  /** Decimal places kept from a shared position (3 ≈ 110 m). */
  sharedPrecision: 3,
  /** A shared position is forgotten after this long. */
  sharedTtlMs: 15 * 60_000,
} as const;

/**
 * The device's own position (ADR-028), as any runtime reports it (browser now; Desktop
 * Companion or a native app later). Ephemeral: one recent sample in memory, never a history.
 */
export type DeviceLocationStatus = "allowed" | "blocked" | "unavailable" | "needs_permission";

export interface DeviceLocation {
  status: DeviceLocationStatus;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** Epoch ms. */
  capturedAt: number;
  source: "device";
}

export const DEVICE_LOCATION_LIMITS = {
  /** A sample this recent is reused as is. */
  freshMs: 2 * 60_000,
  /** Older than this it is never used (the user may have moved). */
  maxAgeMs: 15 * 60_000,
  /** Worse than this (IP-level guesses) it isn't used as "here". */
  maxAccuracyMeters: 5_000,
  /** How long a turn may wait for a fresh fix before going on without it. */
  captureTimeoutMs: 3_500,
} as const;

/**
 * Whether a turn can use the sample as is, should refresh it first, or has nothing usable.
 * A location question ("¿cuánto tardo…?", "cafés cerca") refreshes anything not fresh; other
 * turns reuse a sample still within its age, so "here" keeps working in follow-ups.
 */
export function deviceLocationPlan(
  sample: Pick<DeviceLocation, "capturedAt" | "accuracyMeters"> | null,
  now: number,
  locationTurn: boolean,
): "use" | "refresh" | "none" {
  const age = sample ? now - sample.capturedAt : Number.POSITIVE_INFINITY;
  if (sample && age <= DEVICE_LOCATION_LIMITS.freshMs) return "use";
  if (locationTurn) return "refresh";
  return sample && age <= DEVICE_LOCATION_LIMITS.maxAgeMs ? "use" : "none";
}

/** A sample good enough to stand for "here" right now. */
export function usableDeviceLocation(
  sample: Pick<DeviceLocation, "capturedAt" | "accuracyMeters"> | null,
  now: number,
): boolean {
  return (
    !!sample &&
    now - sample.capturedAt <= DEVICE_LOCATION_LIMITS.maxAgeMs &&
    sample.accuracyMeters <= DEVICE_LOCATION_LIMITS.maxAccuracyMeters
  );
}

/** A shared position, made coarse before it leaves the browser and again on the server. */
export function coarse(p: LatLng): LatLng {
  const f = 10 ** LOCATION_LIMITS.sharedPrecision;
  return { lat: Math.round(p.lat * f) / f, lng: Math.round(p.lng * f) / f };
}

/** Great-circle distance in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

/** Decodes an encoded polyline (precision 5) into points. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && i < encoded.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}
