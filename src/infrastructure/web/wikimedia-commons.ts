import "server-only";

import { z } from "zod";

import { AppError } from "@/core/errors";
import {
  IMAGE_LIMITS,
  fitsWhole,
  isOnTopic,
  searchQuery,
  visualResultSchema,
  type ImageEntity,
  type VisualResult,
} from "@/core/web/images";

/**
 * Wikimedia Commons (ADR-120): freely licensed photos through the official MediaWiki API — no
 * key, no cost, about a second per search (measured 2026-10-24). Each image keeps its author,
 * license and its Commons page (the reference for its terms). Thumbnails come from Wikimedia's
 * own thumbnail service in its standard steps (960 px in the carousel, 1280 px enlarged: other
 * widths answer 400); originals, which can weigh
 * many megabytes, are never loaded.
 */

const API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "ELISE/1.0 (https://elise-lime.vercel.app; image search)";

const page = z.object({
  pageid: z.number(),
  title: z.string(),
  index: z.number().catch(0),
  imageinfo: z
    .array(
      z.object({
        thumburl: z.string().optional(),
        descriptionurl: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        mime: z.string().optional(),
        extmetadata: z
          .record(z.string(), z.object({ value: z.unknown() }).catch({ value: null }))
          .optional(),
      }),
    )
    .optional(),
});

/** Commons' metadata is HTML: plain text only (never rendered as HTML). */
const plain = (v: unknown) =>
  typeof v === "string"
    ? v
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
    : "";

export async function commonsImages(
  entity: ImageEntity,
  opts: { count: number; page: number; signal?: AbortSignal },
): Promise<VisualResult[]> {
  const url = new URL(API);
  const want = Math.min(20, opts.count * 3);
  for (const [k, v] of Object.entries({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    // Photos are bitmaps; logos and diagrams are mostly SVG drawings (shown as Wikimedia's PNG
    // render of them, never the SVG itself).
    gsrsearch: `${searchQuery(entity)}${fitsWhole(entity.kind) ? "" : " filetype:bitmap"}`,
    gsrlimit: String(want),
    gsroffset: String((opts.page - 1) * want),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1280",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|ImageDescription|ObjectName",
  }))
    url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: opts.signal ?? AbortSignal.timeout(IMAGE_LIMITS.timeoutMs),
  }).catch((cause: unknown) => {
    throw new AppError("PROVIDER_UNAVAILABLE", "Wikimedia Commons didn't answer", { cause });
  });
  if (r.status === 429) throw new AppError("RATE_LIMITED", "Wikimedia Commons is busy");
  if (!r.ok) throw new AppError("PROVIDER_UNAVAILABLE", "Wikimedia Commons didn't answer");
  const body = z
    .object({ query: z.object({ pages: z.record(z.string(), z.unknown()) }).optional() })
    .catch({})
    .parse(await r.json().catch(() => ({})));
  const pages = Object.values(body.query?.pages ?? {})
    .flatMap((p) => {
      const x = page.safeParse(p);
      return x.success ? [x.data] : [];
    })
    .sort((a, b) => a.index - b.index);
  return pages.flatMap((p) => {
    const info = p.imageinfo?.[0];
    if (!info?.thumburl || !info.descriptionurl) return [];
    const svg = info.mime === "image/svg+xml";
    if (
      info.mime &&
      !/^image\/(jpeg|png|webp)$/.test(info.mime) &&
      !(svg && fitsWhole(entity.kind))
    )
      return [];
    const meta = info.extmetadata ?? {};
    const name = p.title.replace(/^File:/, "").replace(/\.(jpe?g|png|webp)$/i, "");
    const description = plain(meta.ImageDescription?.value).slice(0, 400);
    // A logo is the brand's own file: its name must be in the file's title (a description that
    // merely mentions the brand is someone else's picture).
    const text =
      entity.kind === "logo" ? name : `${name} ${plain(meta.ObjectName?.value)} ${description}`;
    if (!isOnTopic(entity, text)) return [];
    const v = visualResultSchema.safeParse({
      id: `commons:${p.pageid}`,
      provider: "wikimedia_commons",
      title: name.slice(0, 200),
      // Wikimedia only scales down, and only to standard widths.
      thumbnailUrl:
        (info.width ?? 0) > 960 ? info.thumburl.replace(/\/1280px-/, "/960px-") : info.thumburl,
      imageUrl: info.thumburl,
      sourcePageUrl: info.descriptionurl,
      sourceName: "Wikimedia Commons",
      creator: plain(meta.Artist?.value).slice(0, 160) || null,
      license: plain(meta.LicenseShortName?.value).slice(0, 40) || null,
      licenseUrl: plain(meta.LicenseUrl?.value) || null,
      width: info.width ?? null,
      height: info.height ?? null,
      alt: (plain(meta.ObjectName?.value) || name).slice(0, 200),
    });
    return v.success ? [v.data] : [];
  });
}
