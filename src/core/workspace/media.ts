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

export { embedSrc, isImageUrl, videoEmbed, type VideoEmbed } from "./media-embed";
