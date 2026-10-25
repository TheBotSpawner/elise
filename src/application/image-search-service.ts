import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import {
  dedupe,
  diversify,
  fitsWhole,
  entityKey,
  IMAGE_LIMITS,
  moreImagesUrl,
  visualResultSchema,
  type ImageEntity,
  type ImageGroup,
  type VisualResult,
} from "@/core/web/images";
import { logger } from "@/infrastructure/observability/logger";
import { rateLimit } from "@/infrastructure/rate-limit";
import { openverseImages } from "@/infrastructure/web/openverse";
import { commonsImages } from "@/infrastructure/web/wikimedia-commons";

import type { AuthContext } from "./auth-context";
import { serverMaps } from "./location-service";

/**
 * Real images for a turn (ADR-120). For an identified place, Google's own photos of that place
 * (Places API New, behind IMAGES_PLACES_ENABLED: billed per use); otherwise, and to fill up,
 * openly licensed photos: Wikimedia Commons (free, fast), then Openverse if enabled (slow). Each subject gets its own group — photos of two
 * places are never mixed — and only images a provider returned, validated, are kept.
 */

export interface ImageSearchRequest {
  entities: ImageEntity[];
  count: number;
  /** "Más fotos": the next ones, not the same again. */
  more: boolean;
  language: "es" | "en";
}

export interface ImageSearchOutcome {
  groups: ImageGroup[];
  /** Subjects with no verifiable photo (said plainly, never filled with something else). */
  missing: string[];
  moreUrl: string;
  providers: string[];
}

// ponytail: per-instance cache; a shared one only if repeat galleries prove common.
const cache = new Map<string, { at: number; value: ImageGroup }>();

const placesOn = () => serverEnv().IMAGES_PLACES_ENABLED === "true";
const commonsOn = () => serverEnv().IMAGES_COMMONS_ENABLED !== "false";
const openverseOn = () => serverEnv().IMAGES_OPENVERSE_ENABLED === "true";

export const imageSearchAvailable = () => placesOn() || commonsOn() || openverseOn();

/** The open sources, fastest first; each only fills what the previous ones didn't. */
const OPEN_SOURCES = [
  { id: "wikimedia_commons", on: commonsOn, search: commonsImages },
  { id: "openverse", on: openverseOn, search: openverseImages },
] as const;

async function placeGroup(
  entity: ImageEntity,
  req: ImageSearchRequest,
): Promise<{ group: Partial<ImageGroup>; images: VisualResult[] } | null> {
  if (!placesOn() || entity.kind !== "place") return null;
  const maps = (() => {
    try {
      return serverMaps();
    } catch {
      return null;
    }
  })();
  if (!maps) return null;
  const found = await maps
    .placePhotos(
      [entity.name, entity.context].filter(Boolean).join(", "),
      req.language,
      req.count,
      req.more ? req.count : 0,
    )
    .catch((e: unknown) => {
      logger.warn("images.places_failed", { code: e instanceof AppError ? e.code : "unknown" });
      return null;
    });
  if (!found) return null;
  const images = found.photos.flatMap((p) => {
    const credit = p.attributions.map((a) => a.name).filter(Boolean);
    const v = visualResultSchema.safeParse({
      id: p.id,
      provider: "google_places",
      title: found.name,
      thumbnailUrl: p.url,
      imageUrl: p.url,
      // Google's place page is the photos' home and where the authors are credited too.
      sourcePageUrl: found.mapsUrl ?? p.attributions[0]?.url,
      sourceName: "Google Maps",
      creator: credit.join(", ") || null,
      creatorUrl: p.attributions[0]?.url ?? null,
      alt: found.name,
    });
    return v.success ? [v.data] : [];
  });
  return {
    group: {
      name: found.name,
      context: found.address,
      mapsUrl: found.mapsUrl,
    },
    images,
  };
}

async function entityGroup(
  auth: AuthContext,
  entity: ImageEntity,
  req: ImageSearchRequest,
): Promise<{ group: ImageGroup; providers: string[] }> {
  const key = `${auth.workspaceId}|${entityKey(entity)}|${entity.kind}|${req.count}|${req.more}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < IMAGE_LIMITS.cacheMs)
    return { group: hit.value, providers: ["cache"] };
  const providers: string[] = [];
  const place = await placeGroup(entity, req);
  let images = place?.images ?? [];
  if (images.length) providers.push("google_places");
  for (const source of OPEN_SOURCES) {
    if (images.length >= req.count || !source.on()) continue;
    const open = await source
      .search(entity, { count: req.count, page: req.more ? 2 : 1 })
      .catch((e: unknown) => {
        logger.warn("images.source_failed", {
          source: source.id,
          code: e instanceof AppError ? e.code : "unknown",
        });
        return [];
      });
    if (open.length) providers.push(source.id);
    images = dedupe([...images, ...open]);
  }
  const group: ImageGroup = {
    key: entityKey(entity),
    name: place?.group.name ?? entity.name,
    context: place?.group.context ?? entity.context ?? null,
    mapsUrl: place?.group.mapsUrl ?? null,
    fit: fitsWhole(entity.kind) ? "contain" : "cover",
    images: diversify(images).slice(0, req.count),
  };
  if (group.images.length) {
    cache.set(key, { at: Date.now(), value: group });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return { group, providers };
}

export async function searchImages(
  auth: AuthContext,
  req: ImageSearchRequest,
): Promise<ImageSearchOutcome> {
  if (!imageSearchAvailable())
    throw new AppError("CAPABILITY_UNAVAILABLE", "Image search isn't available", {
      recovery: "none",
    });
  rateLimit(
    `images:${auth.workspaceId}`,
    IMAGE_LIMITS.dailySearches,
    24 * 3_600_000,
    "The daily image search limit for this workspace was reached.",
  );
  const started = Date.now();
  const results = await Promise.all(req.entities.map((e) => entityGroup(auth, e, req)));
  const groups = results.map((r) => r.group);
  const providers = [...new Set(results.flatMap((r) => r.providers))];
  logger.info("images.searched", {
    workspace_id: auth.workspaceId,
    entities: req.entities.length,
    images: groups.reduce((n, g) => n + g.images.length, 0),
    empty: groups.filter((g) => !g.images.length).length,
    providers,
    latency_ms: Date.now() - started,
  });
  return {
    groups: groups.filter((g) => g.images.length),
    missing: groups.filter((g) => !g.images.length).map((g) => g.name),
    moreUrl: moreImagesUrl(req.entities),
    providers,
  };
}
