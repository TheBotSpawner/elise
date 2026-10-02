import { z } from "zod";

import { isSafeHref } from "./model";

/**
 * Media Surfaces (ADR-021): images, galleries, video and link previews built only from URLs
 * the workspace already holds. Video plays through an allow-listed player by id — never
 * through embed HTML. Audio playback has no provider yet: the type exists, nothing fakes it.
 */

const https = z
  .string()
  .max(2000)
  .refine((u) => u.startsWith("https://") && isSafeHref(u), "Only https: links");

export const MEDIA_KINDS = ["image", "gallery", "video", "link"] as const;

export const mediaPayload = z
  .object({
    kind: z.enum(MEDIA_KINDS),
    items: z
      .array(
        z
          .object({
            url: https,
            title: z.string().trim().max(200),
            /** The site it comes from ("youtube.com"). */
            domain: z.string().trim().max(200),
            /** A preview image, when the source provides one. */
            image: https.nullable().default(null),
            alt: z.string().trim().max(200).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    caption: z.string().trim().max(240).optional(),
  })
  .strict();

export type MediaPayload = z.infer<typeof mediaPayload>;

export type VideoEmbed = { provider: "youtube" | "vimeo"; id: string; start: number };

/**
 * A playable video from a known URL: YouTube or Vimeo, identified by a strict id. Anything
 * else is shown as a link, never framed.
 */
export function videoEmbed(url: string): VideoEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const start = Math.max(
    0,
    Math.min(86_400, Number.parseInt(u.searchParams.get("t") ?? "0", 10) || 0),
  );
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const id =
      u.pathname === "/watch"
        ? u.searchParams.get("v")
        : (/^\/(?:embed|shorts|live)\/([^/]+)/.exec(u.pathname)?.[1] ?? null);
    return id && /^[\w-]{11}$/.test(id) ? { provider: "youtube", id, start } : null;
  }
  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    return /^[\w-]{11}$/.test(id) ? { provider: "youtube", id, start } : null;
  }
  if (host === "vimeo.com") {
    const id = /^\/(\d{6,12})$/.exec(u.pathname)?.[1];
    return id ? { provider: "vimeo", id, start } : null;
  }
  return null;
}

/** The only frame sources a Video Surface may load (mirrored by the CSP frame-src). */
export function embedSrc(e: VideoEmbed, autoplay: boolean): string {
  return e.provider === "youtube"
    ? `https://www.youtube-nocookie.com/embed/${e.id}?rel=0&modestbranding=1${e.start ? `&start=${e.start}` : ""}${autoplay ? "&autoplay=1" : ""}`
    : `https://player.vimeo.com/video/${e.id}?dnt=1${autoplay ? "&autoplay=1" : ""}${e.start ? `#t=${e.start}s` : ""}`;
}

/** Image URLs a Surface may show directly (by extension); other pages become link previews. */
export const isImageUrl = (url: string) => {
  try {
    return /\.(?:avif|gif|jpe?g|png|webp)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
};
