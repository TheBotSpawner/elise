import { z } from "zod";

import { isSafeHref } from "./model";
import { MUSIC_FEATURES, PLAYER_STATES } from "../capabilities/music";

/**
 * The Music Surface (ADR-042): one per interaction — `current_music_playback` — whose payload
 * is the playback ELISE last read or changed. A new song updates it; it never multiplies. The
 * page keeps it live from the canonical player state (provider polling or the embedded player).
 */

const text = (max: number) => z.string().max(max);
const href = z.string().max(2000).refine(isSafeHref, "Only https: or internal links");
const provider = z.enum(["spotify", "youtube", "deezer", "device"]);
const kind = z.enum(["track", "album", "artist", "playlist", "video"]);

export const MUSIC_SURFACE_KEY = "current_music_playback";

export const musicItem = z
  .object({
    ref: text(300),
    kind,
    title: text(300),
    subtitle: text(300).nullable(),
    artwork: href.nullable(),
    durationMs: z.number().int().min(0).nullable(),
    url: href.nullable(),
    provider,
  })
  .strict();

export const musicDevice = z
  .object({
    id: text(200),
    name: text(200),
    type: z.enum(["computer", "smartphone", "speaker", "tv", "browser", "other"]),
    active: z.boolean(),
    volume: z.number().min(0).max(100).nullable(),
    supportsVolume: z.boolean(),
    restricted: z.boolean(),
  })
  .strict();

/** What is playing (the canonical Playback, validated wherever it crosses a boundary). */
export const playbackSchema = z
  .object({
    provider,
    playing: z.boolean(),
    item: musicItem.nullable(),
    context: z
      .object({ kind, title: text(300).nullable(), ref: text(300) })
      .strict()
      .nullable(),
    progressMs: z.number().int().min(0),
    durationMs: z.number().int().min(0),
    device: musicDevice.nullable(),
    volume: z.number().min(0).max(100).nullable(),
    at: text(40),
    video: z.boolean().optional(),
    state: z.enum(PLAYER_STATES).optional(),
  })
  .strict();

export const musicPayload = playbackSchema
  .extend({
    /** What this provider can do (the UI shows only controls that work). */
    features: z.array(z.enum(MUSIC_FEATURES)).max(12),
    /** Embedded playback: the queue the page's player holds. */
    queue: z.array(musicItem).max(50).optional(),
    index: z.number().int().min(0).optional(),
    /** Where playback can go (expanded view, "mandalo al parlante"). */
    devices: z.array(musicDevice).max(16).optional(),
    /** Search results the user may pick from. */
    results: z.array(musicItem).max(10).optional(),
    /** A one-line reason something couldn't happen (Premium, no device…). */
    notice: text(300).nullable().optional(),
  })
  .strict();

export type MusicPayload = z.infer<typeof musicPayload>;
