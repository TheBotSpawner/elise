import { z } from "zod";

import { isSafeHref } from "../workspace/model";

/**
 * Real images for a question (ADR-120): photos of a place, a product or a thing, found by an
 * allowed provider — never generated, never guessed from a snippet, never scraped from a search
 * engine's results page. Every image carries where it comes from and who to credit.
 *
 * Pure: the contract, how results are kept on topic (a model name must match exactly: an
 * "RM4 mini" is never shown as the "RM4C mini") and deduplicated, and the gallery's payload.
 */

const https = z
  .string()
  .max(2000)
  .refine((u) => u.startsWith("https://") && isSafeHref(u), "Only https: links");

export const IMAGE_PROVIDERS = ["wikimedia_commons", "openverse", "google_places"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/** One image as a provider returned it, validated (never built by the model). */
export const visualResultSchema = z
  .object({
    id: z.string().min(1).max(200),
    provider: z.enum(IMAGE_PROVIDERS),
    title: z.string().trim().max(200),
    thumbnailUrl: https,
    /** The full image, only where the provider allows using it directly. */
    imageUrl: https.nullable().default(null),
    sourcePageUrl: https,
    sourceName: z.string().trim().max(120).nullable().default(null),
    creator: z.string().trim().max(160).nullable().default(null),
    creatorUrl: https.nullable().default(null),
    license: z.string().trim().max(40).nullable().default(null),
    licenseUrl: https.nullable().default(null),
    width: z.number().int().positive().max(100_000).nullable().default(null),
    height: z.number().int().positive().max(100_000).nullable().default(null),
    alt: z.string().trim().max(200),
  })
  .strict();
export type VisualResult = z.infer<typeof visualResultSchema>;

/** What the model asks for: one or more named subjects, each disambiguated. */
export const imageEntitySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .describe('The exact subject: "Playa Kenepa Grandi", "Broadlink RM4C Mini", "Baby Beach".'),
    context: z
      .string()
      .trim()
      .max(100)
      .optional()
      .describe('Where it is or what it belongs to, to tell it apart: "Curaçao", "Aruba".'),
    kind: z
      .enum(["place", "product", "thing"])
      .default("thing")
      .describe("place: a beach, museum, hotel, landmark; product: a model to buy; thing: else."),
  })
  .strict();
export type ImageEntity = z.infer<typeof imageEntitySchema>;

/** One subject's photos in the gallery, labeled (never mixed with another subject's). */
export const imageGroupSchema = z
  .object({
    key: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    context: z.string().trim().max(120).nullable().default(null),
    /** The provider's own place page, when the photos are of an identified place. */
    mapsUrl: https.nullable().default(null),
    images: z.array(visualResultSchema).max(10),
  })
  .strict();
export type ImageGroup = z.infer<typeof imageGroupSchema>;

export const imageGalleryPayload = z
  .object({
    groups: z.array(imageGroupSchema).min(1).max(5),
    /** A public image search, opened outside ELISE — not a result of any API. */
    moreUrl: https.nullable().default(null),
  })
  .strict();
export type ImageGalleryPayload = z.infer<typeof imageGalleryPayload>;

export const IMAGE_LIMITS = {
  perEntityDefault: 4,
  perEntityMax: 8,
  entitiesMax: 5,
  /** Per workspace per day, on top of web search's own limits (cost and fair use). */
  dailySearches: 120,
  cacheMs: 30 * 60_000,
  timeoutMs: 7_000,
} as const;

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Words that name the kind of thing, not which one ("Playa", "beach", "the"). */
const GENERIC = new Set([
  "playa",
  "playas",
  "beach",
  "beaches",
  "the",
  "el",
  "la",
  "los",
  "las",
  "de",
  "del",
  "of",
  "y",
  "and",
  "museo",
  "museum",
  "hotel",
  "resort",
  "parque",
  "park",
  "isla",
  "island",
]);

const tokens = (s: string) =>
  fold(s)
    .split(" ")
    .filter((w) => w.length >= 2 && !GENERIC.has(w));

/**
 * On topic: every distinctive word of the name is in the image's text (so "RM4C" never matches an
 * "RM4" photo), and for a one-word name, a word of its context too (a "Baby Beach" elsewhere
 * isn't Aruba's).
 */
export function isOnTopic(entity: Pick<ImageEntity, "name" | "context">, text: string): boolean {
  const have = new Set(fold(text).split(" "));
  const name = tokens(entity.name);
  if (!name.length || !name.every((w) => have.has(w))) return false;
  // A one-word name ("Baby" Beach, "Eagle" Beach) exists in many places: its context must be
  // there too. Two or more distinctive words ("Kenepa Grandi", "RM4C mini") already tell it apart.
  const context = entity.context && name.length < 2 ? tokens(entity.context) : [];
  return !context.length || context.some((w) => have.has(w));
}

/**
 * What to ask a search engine for: the name's distinctive words (a Spanish "Playa" isn't in
 * English file names) plus the context, accents folded ("Curaçao" → "curacao"). A one-word name
 * keeps its full form ("Baby Beach").
 */
export function searchQuery(entity: Pick<ImageEntity, "name" | "context">): string {
  const name = tokens(entity.name);
  const subject = name.length >= 2 ? name.join(" ") : fold(entity.name);
  return [subject, entity.context ? fold(entity.context) : ""].filter(Boolean).join(" ");
}

/** The same photo through two paths, or the same page twice: kept once. */
export function dedupe(images: readonly VisualResult[]): VisualResult[] {
  const seen = new Set<string>();
  return images.filter((i) => {
    const keys = [
      `${i.provider}:${i.id}`,
      i.sourcePageUrl,
      `${fold(i.title)}|${fold(i.creator ?? "")}|${i.width}x${i.height}`,
    ];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

/** Variety first: one photo per author before a second from the same one (near-duplicates). */
export function diversify(images: readonly VisualResult[]): VisualResult[] {
  const seen = new Set<string>();
  const first: VisualResult[] = [];
  const later: VisualResult[] = [];
  for (const i of images) {
    const who = fold(i.creator ?? i.id);
    (seen.has(who) ? later : first).push(i);
    seen.add(who);
  }
  return [...first, ...later];
}

/** A stable key per subject: "más fotos de la segunda" updates that subject's photos. */
export const entityKey = (e: Pick<ImageEntity, "name" | "context">) =>
  fold(`${e.name} ${e.context ?? ""}`)
    .replace(/ /g, "-")
    .slice(0, 160);

/** The public image search for the same subjects, as an outside link (never an API result). */
export function moreImagesUrl(entities: readonly Pick<ImageEntity, "name" | "context">[]) {
  const q = entities
    .map((e) => [e.name, e.context].filter(Boolean).join(" "))
    .join(" ")
    .slice(0, 200);
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
