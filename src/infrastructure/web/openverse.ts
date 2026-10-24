import "server-only";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  IMAGE_LIMITS,
  isOnTopic,
  visualResultSchema,
  type ImageEntity,
  type VisualResult,
} from "@/core/web/images";

/**
 * Openverse (ADR-120): openly licensed images (Flickr, Wikimedia Commons…) with their creator,
 * license and source page — no key, no cost. Anonymous requests are rate-limited by Openverse;
 * a 429 is reported as such, never retried in a loop. The license is the source's metadata: the
 * source page stays the reference, linked next to every image.
 */

const API = "https://api.openverse.org/v1/images/";

const resultSchema = z.object({
  id: z.string(),
  title: z.string().nullable().catch(null),
  foreign_landing_url: z.string().nullable().catch(null),
  url: z.string().nullable().catch(null),
  thumbnail: z.string().nullable().catch(null),
  creator: z.string().nullable().catch(null),
  creator_url: z.string().nullable().catch(null),
  license: z.string().nullable().catch(null),
  license_version: z.string().nullable().catch(null),
  license_url: z.string().nullable().catch(null),
  source: z.string().nullable().catch(null),
  width: z.number().nullable().catch(null),
  height: z.number().nullable().catch(null),
  mature: z.boolean().catch(false),
  tags: z
    .array(z.object({ name: z.string() }))
    .nullable()
    .catch(null),
});

const SOURCES: Record<string, string> = {
  flickr: "Flickr",
  wikimedia: "Wikimedia Commons",
};

const licenseName = (l: string | null, v: string | null) =>
  l
    ? l === "cc0" || l === "pdm"
      ? l.toUpperCase()
      : `CC ${l.toUpperCase()} ${v ?? ""}`.trim()
    : null;

export async function openverseImages(
  entity: ImageEntity,
  opts: { count: number; page: number; signal?: AbortSignal },
): Promise<VisualResult[]> {
  const url = new URL(API);
  url.searchParams.set("q", [entity.name, entity.context].filter(Boolean).join(" "));
  // Ask for more than needed: off-topic ones are dropped below.
  url.searchParams.set("page_size", String(Math.min(20, opts.count * 4)));
  url.searchParams.set("page", String(opts.page));
  url.searchParams.set("mature", "false");
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "ELISE (image search)" },
    signal: opts.signal ?? AbortSignal.timeout(IMAGE_LIMITS.timeoutMs),
  }).catch((cause: unknown) => {
    throw new AppError("PROVIDER_UNAVAILABLE", "Openverse didn't answer", { cause });
  });
  if (r.status === 429)
    throw new AppError("RATE_LIMITED", "Openverse is rate-limiting image searches");
  if (!r.ok) throw new AppError("PROVIDER_UNAVAILABLE", "Openverse didn't answer");
  const body = z
    .object({ results: z.array(z.unknown()).catch([]) })
    .catch({ results: [] })
    .parse(await r.json().catch(() => ({})));
  return body.results.flatMap((raw) => {
    const p = resultSchema.safeParse(raw);
    if (!p.success || p.data.mature) return [];
    const x = p.data;
    const text = [x.title, ...(x.tags ?? []).map((t) => t.name)].filter(Boolean).join(" ");
    if (!isOnTopic(entity, text)) return [];
    const v = visualResultSchema.safeParse({
      id: x.id,
      provider: "openverse",
      title: (x.title ?? "")
        .replace(/^File:/, "")
        .replace(/\.(jpe?g|png|webp)$/i, "")
        .slice(0, 200),
      thumbnailUrl: x.thumbnail,
      imageUrl: x.url,
      sourcePageUrl: x.foreign_landing_url,
      sourceName: x.source ? (SOURCES[x.source] ?? x.source) : null,
      creator: x.creator?.slice(0, 160) ?? null,
      creatorUrl: x.creator_url,
      license: licenseName(x.license, x.license_version),
      licenseUrl: x.license_url,
      width: x.width,
      height: x.height,
      alt: (x.title ?? entity.name).replace(/^File:/, "").slice(0, 200),
    });
    return v.success ? [v.data] : [];
  });
}
