import { z } from "zod";

import { isSafeHref, type Surface } from "./model";
import { TRAVEL_MODES } from "../location/model";

/**
 * Location Surfaces (ADR-023): a map of places, a route or a travel-time comparison, and one
 * place in detail. Typed data only — coordinates, names, numbers — never markup or map code;
 * the UI owns the map. The user's shared position is never part of a payload.
 */

const text = (max: number) => z.string().trim().max(max);
const https = z
  .string()
  .max(2000)
  .refine((u) => u.startsWith("https://") && isSafeHref(u), "Only https: links");
export const latLng = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .strict();

export const mapPlace = z
  .object({
    id: text(300),
    name: text(200),
    address: text(300).nullable(),
    location: latLng,
    category: text(80).nullable(),
    rating: z.number().min(0).max(5).nullable(),
    ratingCount: z.number().int().min(0).nullable(),
    openNow: z.boolean().nullable(),
    distanceMeters: z.number().int().min(0).nullable(),
    mapsUrl: https.nullable(),
  })
  .strict();

const route = z
  .object({
    mode: z.enum(TRAVEL_MODES),
    from: text(200),
    to: text(200),
    distanceMeters: z.number().int().min(0),
    durationSeconds: z.number().int().min(0),
    /** Expected arrival (ISO), when leaving now or at the asked time. */
    arrival: text(40).nullable(),
    polyline: z.string().max(40_000).nullable(),
    start: latLng.nullable(),
    end: latLng.nullable(),
    warnings: z.array(text(200)).max(5),
    /** Starts at the user's shared position: line and start are kept out of storage. */
    fromHere: z.boolean(),
    mapsUrl: https.nullable(),
  })
  .strict();

const comparison = z
  .object({
    mode: z.enum(TRAVEL_MODES),
    origins: z.array(text(200)).min(1).max(3),
    rows: z
      .array(
        z
          .object({
            origin: z.number().int().min(0).max(2),
            destination: text(200),
            durationSeconds: z.number().int().min(0).nullable(),
            distanceMeters: z.number().int().min(0).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

export const MAP_MODES = ["places", "route", "compare", "locate"] as const;

export const mapPayload = z
  .object({
    mode: z.enum(MAP_MODES),
    /** What was asked ("cafés near the Obelisk"). */
    query: text(200),
    /** The point a search was centred on (a named place, never the user). */
    center: z
      .object({ name: text(200), location: latLng })
      .strict()
      .nullable(),
    places: z.array(mapPlace).max(10),
    route: route.nullable(),
    comparison: comparison.nullable(),
  })
  .strict();

export const placePayload = mapPlace
  .extend({
    phone: text(60).nullable(),
    website: https.nullable(),
    priceLevel: z.number().int().min(0).max(4).nullable(),
    hours: z.array(text(120)).max(7),
    photo: z
      .object({
        url: https,
        attributions: z.array(z.object({ name: text(200), url: https.nullable() }).strict()).max(3),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type MapPayload = z.infer<typeof mapPayload>;
export type PlacePayload = z.infer<typeof placePayload>;

/**
 * What may be stored of a Surface: a route from the user's shared position keeps its numbers
 * and destination, never the line or the start that would reveal where the user was.
 */
export function forStorage(s: Surface): Surface {
  if (s.type !== "map") return s;
  const p = s.payload as MapPayload;
  if (!p.route?.fromHere) return s;
  return { ...s, payload: { ...p, route: { ...p.route, polyline: null, start: null } } };
}
