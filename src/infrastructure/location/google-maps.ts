import "server-only";

import { AppError } from "@/core/errors";
import {
  distanceMeters,
  type CityPlace,
  type CitySuggestion,
  LOCATION_LIMITS,
  type LatLng,
  type LocationProvider,
  type MatrixCell,
  type Place,
  type PlaceSearch,
  type Route,
  type TransitItinerary,
  type TransitLeg,
  type TransitMode,
  type TransitRide,
  type TransitWalk,
  type TravelMode,
  vehicleOf,
  type Waypoint,
} from "@/core/location/model";

/**
 * Google Maps Platform adapter (ADR-023), verified against the current APIs (2026-10):
 * - Places API (New): POST places:searchText, POST places:autocomplete (city level, with a
 *   session token), GET places/{id}, GET {photo}/media
 *   (skipHttpRedirect → a key-free photoUri). Never the legacy Places API.
 * - Routes API: directions/v2:computeRoutes and distanceMatrix/v2:computeRouteMatrix. Never
 *   the legacy Directions / Distance Matrix APIs.
 * - Geocoding API: geocode/json (address and latlng).
 * Every Places/Routes request sends a field mask with only what ELISE shows (cost). Uses the
 * server key, which must be restricted to these APIs and never reaches the browser.
 */

export interface MapsUsage {
  /** "places.search", "places.details", "places.photo", "geocode", "routes", "routes.matrix". */
  api: string;
  /** Billable elements (1 per request; origins × destinations for a matrix). */
  units: number;
}

const PLACES = "https://places.googleapis.com/v1";
const ROUTES = "https://routes.googleapis.com";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

const SEARCH_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.primaryTypeDisplayName",
  "places.rating",
  "places.userRatingCount",
  "places.currentOpeningHours.openNow",
  "places.googleMapsUri",
].join(",");

const DETAIL_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "primaryTypeDisplayName",
  "rating",
  "userRatingCount",
  "priceLevel",
  "currentOpeningHours.openNow",
  "regularOpeningHours.weekdayDescriptions",
  "nationalPhoneNumber",
  "websiteUri",
  "googleMapsUri",
  "photos",
].join(",");

const MODE: Record<TravelMode, string> = {
  drive: "DRIVE",
  walk: "WALK",
  bicycle: "BICYCLE",
  transit: "TRANSIT",
};

const PRICE: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

interface GPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  currentOpeningHours?: { openNow?: boolean };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  photos?: { name?: string; authorAttributions?: { displayName?: string; uri?: string }[] }[];
}

const API_NAMES: Record<string, string> = {
  places: "Places API (New)",
  routes: "Routes API",
  geocode: "Geocoding API",
};
const apiName = (what: string) => API_NAMES[what.split(".")[0] ?? ""] ?? what;

/**
 * Google's own reason for a refused request → a precise setup error. "Maps isn't available"
 * is never the answer when the real cause is a key restriction or an API left disabled.
 */
export function setupFailure(reason: string, what: string): AppError | null {
  const api = apiName(what);
  const setup = (code: string, message: string) =>
    new AppError("CAPABILITY_UNAVAILABLE", `Maps setup: ${message}`, {
      recovery: "configure",
      details: { setup: code, api },
    });
  if (/REFERRER|referer restrictions/i.test(reason))
    return setup(
      "key_referrer_restricted",
      `the Maps key only accepts requests from websites (HTTP referrer restriction), so ELISE's server can't call the ${api}. Set GOOGLE_MAPS_SERVER_API_KEY to a server key, or remove the website restriction from the development key.`,
    );
  if (/SERVICE_DISABLED|not activated|has not been used in project|is disabled/i.test(reason))
    return setup(
      "api_disabled",
      `the ${api} isn't enabled in the Google Cloud project. Enable it in the console.`,
    );
  if (/API_KEY_SERVICE_BLOCKED|not authorized to use this API/i.test(reason))
    return setup(
      "api_not_allowed",
      `the Maps key isn't allowed to call the ${api} (API restrictions). Add it to the key's allowed APIs.`,
    );
  if (/API_KEY_INVALID|API key not valid/i.test(reason))
    return setup("key_invalid", "the Maps key isn't valid.");
  if (/BILLING/i.test(reason))
    return setup("billing", "billing isn't enabled on the Google Cloud project.");
  return null;
}

/** The refusal reason Google put in an error body (reason codes and message). */
async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; status?: string; details?: { reason?: string }[] };
    };
    return [
      body.error?.status,
      body.error?.message,
      ...(body.error?.details ?? []).map((d) => d.reason),
    ]
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}

function failure(status: number, what: string, reason = ""): AppError {
  const setup =
    status === 401 || status === 403 || status === 400 ? setupFailure(reason, what) : null;
  if (setup) return setup;
  if (status === 401 || status === 403)
    return new AppError("CAPABILITY_UNAVAILABLE", `Maps isn't configured correctly (${what})`, {
      recovery: "configure",
    });
  if (status === 429) return new AppError("RATE_LIMITED", "Maps is busy. Try again in a moment.");
  if (status === 400 || status === 404)
    return new AppError("VALIDATION_ERROR", `Maps couldn't use that request (${what})`, {
      recovery: "review",
    });
  return new AppError("PROVIDER_UNAVAILABLE", "Maps is unavailable right now", {
    recovery: "retry",
  });
}

const https = (u: string | undefined) => (u && u.startsWith("https://") ? u : null);

function toPlace(g: GPlace, from: LatLng | null): Place | null {
  const lat = g.location?.latitude;
  const lng = g.location?.longitude;
  if (!g.id || lat == null || lng == null) return null;
  const location = { lat, lng };
  return {
    id: g.id,
    name: g.displayName?.text ?? g.formattedAddress ?? "",
    address: g.formattedAddress ?? null,
    location,
    category: g.primaryTypeDisplayName?.text ?? null,
    rating: g.rating ?? null,
    ratingCount: g.userRatingCount ?? null,
    priceLevel: g.priceLevel ? (PRICE[g.priceLevel] ?? null) : null,
    openNow: g.currentOpeningHours?.openNow ?? null,
    hours: g.regularOpeningHours?.weekdayDescriptions ?? [],
    phone: g.nationalPhoneNumber ?? null,
    website: https(g.websiteUri),
    mapsUrl: https(g.googleMapsUri),
    photo: null,
    distanceMeters: from ? distanceMeters(from, location) : null,
  };
}

function waypoint(w: Waypoint) {
  if ("placeId" in w) return { placeId: w.placeId };
  if ("location" in w)
    return { location: { latLng: { latitude: w.location.lat, longitude: w.location.lng } } };
  return { address: w.address };
}

const seconds = (d: string | undefined) => (d ? Math.round(Number.parseFloat(d)) : null);
const point = (l: { latLng?: { latitude?: number; longitude?: number } } | undefined) =>
  l?.latLng?.latitude != null && l.latLng.longitude != null
    ? { lat: l.latLng.latitude, lng: l.latLng.longitude }
    : null;

const TRAVEL: Record<TravelMode, string> = {
  drive: "driving",
  walk: "walking",
  bicycle: "bicycling",
  transit: "transit",
};

/**
 * The trip on Google Maps (Maps URLs). A raw position is left out: without an origin, Maps
 * starts from wherever the user opens it, so no coordinates of theirs end up in a link.
 */
function directionsUrl(
  r: Parameters<LocationProvider["route"]>[0],
  start: LatLng | null,
  end: LatLng | null,
): string {
  const u = new URL("https://www.google.com/maps/dir/");
  u.searchParams.set("api", "1");
  const put = (name: "origin" | "destination", w: Waypoint, at: LatLng | null) => {
    if ("address" in w) u.searchParams.set(name, w.address);
    else if ("placeId" in w && at) {
      u.searchParams.set(name, `${at.lat},${at.lng}`);
      u.searchParams.set(`${name}_place_id`, w.placeId);
    }
  };
  put("origin", r.origin, start);
  put("destination", r.destination, end);
  u.searchParams.set("travelmode", TRAVEL[r.mode]);
  return u.toString();
}

/** Departure times in the past are rejected by the API: those mean "now". */
const ROUTE_FIELDS =
  "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.warnings,routes.legs.startLocation,routes.legs.endLocation";
/** Exactly the step fields an itinerary needs (never "*"). */
const TRANSIT_FIELDS =
  "routes.legs.steps.travelMode,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails";

const TRANSIT_MODE: Record<TransitMode, string> = {
  bus: "BUS",
  subway: "SUBWAY",
  train: "TRAIN",
  light_rail: "LIGHT_RAIL",
};

type RawLatLng = { latLng?: { latitude?: number; longitude?: number } };
interface RawStep {
  travelMode?: string;
  distanceMeters?: number;
  staticDuration?: string;
  transitDetails?: {
    headsign?: string;
    stopCount?: number;
    stopDetails?: {
      departureStop?: { name?: string; location?: RawLatLng };
      arrivalStop?: { name?: string; location?: RawLatLng };
      departureTime?: string;
      arrivalTime?: string;
    };
    transitLine?: {
      name?: string;
      nameShort?: string;
      color?: string;
      textColor?: string;
      agencies?: { name?: string }[];
      vehicle?: { type?: string; name?: { text?: string } };
    };
  };
}
interface RawRoute {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  warnings?: string[];
  legs?: { startLocation?: RawLatLng; endLocation?: RawLatLng; steps?: RawStep[] }[];
}

const text = (v: unknown, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const isoOrNull = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const hexColor = (v: unknown) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;

/**
 * ADR-113: one provider route → an itinerary, exactly as given. Walking steps in a row become
 * one walk; each transit step becomes a ride with its line, direction, stops and scheduled times.
 * A missing field stays null — never filled in. Null when the route has no steps at all.
 */
export function transitItinerary(route: RawRoute): TransitItinerary | null {
  const steps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
  const total = seconds(route.duration);
  if (!steps.length || total == null) return null;
  const legs: TransitLeg[] = [];
  for (const s of steps) {
    const d = s.transitDetails;
    if (s.travelMode === "TRANSIT" && d) {
      const line = d.transitLine;
      const short = text(line?.nameShort, 40);
      const name = text(line?.name, 120);
      legs.push({
        kind: "transit",
        vehicle: vehicleOf(line?.vehicle?.type),
        vehicleName: text(line?.vehicle?.name?.text, 40),
        line: short ?? name,
        lineName: short && name && name !== short ? name : null,
        color: hexColor(line?.color),
        textColor: hexColor(line?.textColor),
        agency: text(line?.agencies?.[0]?.name, 80),
        headsign: text(d.headsign, 120),
        board: {
          name: text(d.stopDetails?.departureStop?.name),
          location: point(d.stopDetails?.departureStop?.location),
        },
        alight: {
          name: text(d.stopDetails?.arrivalStop?.name),
          location: point(d.stopDetails?.arrivalStop?.location),
        },
        departAt: isoOrNull(d.stopDetails?.departureTime),
        arriveAt: isoOrNull(d.stopDetails?.arrivalTime),
        stops: typeof d.stopCount === "number" && d.stopCount >= 0 ? d.stopCount : null,
        durationSeconds: seconds(s.staticDuration) ?? null,
        distanceMeters: typeof s.distanceMeters === "number" ? s.distanceMeters : null,
      });
      continue;
    }
    const sec = seconds(s.staticDuration) ?? 0;
    const meters = s.distanceMeters ?? 0;
    const last = legs.at(-1);
    if (last?.kind === "walk") {
      last.durationSeconds += sec;
      last.distanceMeters += meters;
    } else legs.push({ kind: "walk", durationSeconds: sec, distanceMeters: meters });
  }
  const rides = legs.filter((l): l is TransitRide => l.kind === "transit");
  const walks = legs.filter((l): l is TransitWalk => l.kind === "walk");
  const before = legs[0]?.kind === "walk" ? legs[0].durationSeconds : 0;
  const after = legs.at(-1)?.kind === "walk" ? (legs.at(-1) as TransitWalk).durationSeconds : 0;
  const first = rides[0]?.departAt;
  const lastArrive = rides.at(-1)?.arriveAt;
  return {
    durationSeconds: total,
    distanceMeters: route.distanceMeters ?? 0,
    departAt: first ? new Date(Date.parse(first) - before * 1000).toISOString() : null,
    arriveAt: lastArrive ? new Date(Date.parse(lastArrive) + after * 1000).toISOString() : null,
    walkMeters: walks.reduce((s, w) => s + w.distanceMeters, 0),
    walkSeconds: walks.reduce((s, w) => s + w.durationSeconds, 0),
    transfers: Math.max(0, rides.length - 1),
    legs,
    polyline: route.polyline?.encodedPolyline ?? null,
  };
}

const future = (iso: string | null) =>
  iso && Date.parse(iso) > Date.now() + 60_000 ? new Date(iso).toISOString() : undefined;

export class GoogleMapsLocation implements LocationProvider {
  readonly id = "google_maps";

  constructor(
    private readonly key: string,
    private readonly onUsage: (u: MapsUsage) => void = () => undefined,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call<T>(
    api: string,
    url: string,
    init: { method?: "GET" | "POST"; body?: unknown; fields?: string },
    signal?: AbortSignal,
    units = 1,
  ): Promise<T> {
    const response = await this.http(url, {
      method: init.method ?? "GET",
      headers: {
        "X-Goog-Api-Key": this.key,
        ...(init.fields ? { "X-Goog-FieldMask": init.fields } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal,
    });
    this.onUsage({ api, units });
    if (!response.ok) throw failure(response.status, api, await reasonOf(response));
    return (await response.json()) as T;
  }

  async searchPlaces(q: PlaceSearch, signal?: AbortSignal): Promise<Place[]> {
    const body = {
      textQuery: q.query,
      pageSize: Math.min(q.limit, 20),
      languageCode: q.language,
      ...(q.openNow ? { openNow: true } : {}),
      ...(q.near
        ? {
            rankPreference: q.rank === "distance" ? "DISTANCE" : "RELEVANCE",
            locationBias: {
              circle: {
                center: { latitude: q.near.lat, longitude: q.near.lng },
                radius: Math.min(q.radiusMeters ?? LOCATION_LIMITS.defaultRadiusMeters, 50_000),
              },
            },
          }
        : {}),
    };
    const data = await this.call<{ places?: GPlace[] }>(
      "places.search",
      `${PLACES}/places:searchText`,
      { method: "POST", body, fields: SEARCH_FIELDS },
      signal,
    );
    return (data.places ?? []).map((g) => toPlace(g, q.near)).filter((p): p is Place => Boolean(p));
  }

  /**
   * Places Autocomplete (New), city level: localities and administrative areas — the types a
   * forecast needs, never businesses, POIs or street addresses. One session token covers the
   * typing and the details call that ends it.
   */
  async suggestCities(
    input: string,
    language: "es" | "en",
    sessionToken: string,
    signal?: AbortSignal,
    /** Biases (never restricts) toward the person's country: "ar" → Córdoba, Argentina first. */
    regionCode?: string | null,
  ): Promise<CitySuggestion[]> {
    const data = await this.call<{
      suggestions?: {
        placePrediction?: {
          placeId: string;
          text?: { text: string };
          structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
        };
      }[];
    }>(
      "places.autocomplete",
      `${PLACES}/places:autocomplete`,
      {
        method: "POST",
        body: {
          input,
          languageCode: language,
          sessionToken,
          ...(regionCode ? { regionCode: regionCode.toLowerCase() } : {}),
          includedPrimaryTypes: [
            "locality",
            "administrative_area_level_1",
            "administrative_area_level_2",
            "sublocality",
            "postal_town",
          ],
        },
      },
      signal,
    );
    return (data.suggestions ?? []).flatMap((s) => {
      const p = s.placePrediction;
      if (!p) return [];
      return [
        {
          placeId: p.placeId,
          label: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          detail: p.structuredFormat?.secondaryText?.text ?? null,
        },
      ];
    });
  }

  async cityDetails(
    placeId: string,
    language: "es" | "en",
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<CityPlace | null> {
    const url = new URL(`${PLACES}/places/${encodeURIComponent(placeId)}`);
    url.searchParams.set("languageCode", language);
    url.searchParams.set("sessionToken", sessionToken);
    const p = await this.call<{
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      addressComponents?: { longText: string; shortText: string; types: string[] }[];
    }>(
      "places.details",
      url.toString(),
      { fields: "id,displayName,formattedAddress,location,addressComponents" },
      signal,
    );
    if (!p.location) return null;
    const part = (type: string) => p.addressComponents?.find((c) => c.types.includes(type));
    const city = part("locality")?.longText ?? part("administrative_area_level_2")?.longText;
    return {
      placeId: p.id,
      displayName: p.formattedAddress ?? p.displayName?.text ?? "",
      city: city ?? p.displayName?.text ?? null,
      region: part("administrative_area_level_1")?.longText ?? null,
      country: part("country")?.longText ?? null,
      countryCode: part("country")?.shortText ?? null,
      lat: p.location.latitude,
      lng: p.location.longitude,
    };
  }

  async getPlace(id: string, language: "es" | "en", signal?: AbortSignal): Promise<Place | null> {
    if (!/^[\w-]{10,300}$/.test(id)) return null;
    let g: GPlace;
    try {
      g = await this.call<GPlace>(
        "places.details",
        `${PLACES}/places/${id}?languageCode=${language}`,
        { fields: DETAIL_FIELDS },
        signal,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "VALIDATION_ERROR") return null;
      throw error;
    }
    const place = toPlace(g, null);
    if (!place) return null;
    const photo = g.photos?.[0];
    if (photo?.name && /^places\/[\w-]+\/photos\/[\w-]+$/.test(photo.name)) {
      // A photo is optional: a failure here never fails the place.
      const media = await this.call<{ photoUri?: string }>(
        "places.photo",
        `${PLACES}/${photo.name}/media?maxWidthPx=800&skipHttpRedirect=true`,
        {},
        signal,
      ).catch(() => null);
      const url = https(media?.photoUri);
      if (url)
        place.photo = {
          url,
          attributions: (photo.authorAttributions ?? []).slice(0, 3).map((a) => ({
            name: a.displayName ?? "",
            url: https(a.uri),
          })),
        };
    }
    return place;
  }

  private async geocodeQuery(
    params: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<Place[]> {
    // The Geocoding web service takes the key as a parameter (server-side only).
    const url = `${GEOCODE}?${params}&language=${language}&key=${encodeURIComponent(this.key)}`;
    const response = await this.http(url, { signal });
    this.onUsage({ api: "geocode", units: 1 });
    if (!response.ok) throw failure(response.status, "geocode");
    const data = (await response.json()) as {
      status?: string;
      error_message?: string;
      results?: {
        place_id?: string;
        formatted_address?: string;
        geometry?: { location?: { lat?: number; lng?: number } };
      }[];
    };
    if (data.status === "REQUEST_DENIED")
      throw setupFailure(data.error_message ?? "", "geocode") ?? failure(403, "geocode");
    if (data.status === "OVER_QUERY_LIMIT") throw failure(429, "geocode");
    return (data.results ?? []).slice(0, 5).flatMap((r) => {
      const lat = r.geometry?.location?.lat;
      const lng = r.geometry?.location?.lng;
      if (!r.place_id || lat == null || lng == null) return [];
      return [
        {
          id: r.place_id,
          name: r.formatted_address ?? "",
          address: r.formatted_address ?? null,
          location: { lat, lng },
          category: null,
          rating: null,
          ratingCount: null,
          priceLevel: null,
          openNow: null,
          hours: [],
          phone: null,
          website: null,
          mapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${r.place_id}`,
          photo: null,
          distanceMeters: null,
        },
      ];
    });
  }

  geocode(address: string, language: "es" | "en", near?: LatLng | null, signal?: AbortSignal) {
    // A viewport bias (±0.3°, ~30 km) around the context: a preference, not a filter.
    const bounds = near
      ? `&bounds=${near.lat - 0.3},${near.lng - 0.3}|${near.lat + 0.3},${near.lng + 0.3}`
      : "";
    return this.geocodeQuery(`address=${encodeURIComponent(address)}${bounds}`, language, signal);
  }

  reverseGeocode(at: LatLng, language: "es" | "en", signal?: AbortSignal) {
    return this.geocodeQuery(`latlng=${at.lat},${at.lng}`, language, signal);
  }

  async route(
    r: Parameters<LocationProvider["route"]>[0],
    signal?: AbortSignal,
  ): Promise<Route | null> {
    const transit = r.mode === "transit";
    // ADR-113: transit can be planned to arrive by a time; never both times (API rule).
    const arrival = transit ? future(r.arriveBy ?? null) : undefined;
    const departure = arrival ? undefined : future(r.departAt);
    const body = {
      origin: waypoint(r.origin),
      destination: waypoint(r.destination),
      // Transit routes can't have stops (API rule).
      ...(r.stops.length && !transit ? { intermediates: r.stops.map(waypoint) } : {}),
      travelMode: MODE[r.mode],
      ...(r.mode === "drive" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
      ...(departure ? { departureTime: departure } : {}),
      ...(arrival ? { arrivalTime: arrival } : {}),
      ...(transit
        ? {
            // Alternatives let ELISE pick by transfers or walking, not only by time.
            computeAlternativeRoutes: true,
            ...(r.transitModes?.length || r.transitPreference
              ? {
                  transitPreferences: {
                    ...(r.transitModes?.length
                      ? { allowedTravelModes: r.transitModes.map((m) => TRANSIT_MODE[m]) }
                      : {}),
                    ...(r.transitPreference
                      ? {
                          routingPreference:
                            r.transitPreference === "less_walking"
                              ? "LESS_WALKING"
                              : "FEWER_TRANSFERS",
                        }
                      : {}),
                  },
                }
              : {}),
          }
        : {}),
      languageCode: r.language === "es" ? "es-419" : r.language,
    };
    const data = await this.call<{ routes?: RawRoute[] }>(
      "routes",
      `${ROUTES}/directions/v2:computeRoutes`,
      {
        method: "POST",
        body,
        // Transit asks for its steps (lines, stops, times): without them only the total time
        // reached ELISE — the original "tardás 30 minutos" without a line.
        fields: transit ? `${ROUTE_FIELDS},${TRANSIT_FIELDS}` : ROUTE_FIELDS,
      },
      signal,
    );
    const best = data.routes?.[0];
    const duration = seconds(best?.duration);
    if (!best || duration == null) return null;
    const legs = best.legs ?? [];
    const itineraries = transit
      ? (data.routes ?? []).flatMap((x) => {
          const it = transitItinerary(x);
          return it ? [it] : [];
        })
      : [];
    return {
      ...(transit ? { itineraries } : {}),
      mode: r.mode,
      distanceMeters: best.distanceMeters ?? 0,
      durationSeconds: duration,
      polyline: best.polyline?.encodedPolyline ?? null,
      warnings: (best.warnings ?? []).slice(0, 5),
      start: point(legs[0]?.startLocation),
      end: point(legs.at(-1)?.endLocation),
      mapsUrl: directionsUrl(r, point(legs[0]?.startLocation), point(legs.at(-1)?.endLocation)),
    };
  }

  async matrix(
    m: Parameters<LocationProvider["matrix"]>[0],
    signal?: AbortSignal,
  ): Promise<MatrixCell[]> {
    const departure = future(m.departAt);
    const data = await this.call<
      {
        originIndex?: number;
        destinationIndex?: number;
        duration?: string;
        distanceMeters?: number;
        condition?: string;
      }[]
    >(
      "routes.matrix",
      `${ROUTES}/distanceMatrix/v2:computeRouteMatrix`,
      {
        method: "POST",
        body: {
          origins: m.origins.map((w) => ({ waypoint: waypoint(w) })),
          destinations: m.destinations.map((w) => ({ waypoint: waypoint(w) })),
          travelMode: MODE[m.mode],
          ...(m.mode === "drive" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
          ...(departure ? { departureTime: departure } : {}),
        },
        fields: "originIndex,destinationIndex,duration,distanceMeters,condition",
      },
      signal,
      m.origins.length * m.destinations.length,
    );
    // Index 0 is omitted from the JSON (proto default).
    return data.map((e) => {
      const ok = e.condition === "ROUTE_EXISTS";
      return {
        origin: e.originIndex ?? 0,
        destination: e.destinationIndex ?? 0,
        ok,
        durationSeconds: ok ? seconds(e.duration) : null,
        distanceMeters: ok ? (e.distanceMeters ?? 0) : null,
      };
    });
  }
}
