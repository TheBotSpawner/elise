import { ATTACHMENT_TYPES, type SentAttachment } from "./model";

/**
 * Conversational vision (ADR-060): the images a turn sends to the model, and at what detail.
 * Pure rules — no provider, no storage. A chat image is shown to a multimodal model as is; it
 * never has to become text (or Knowledge) for ELISE to understand it.
 */

export type ImageDetail = "auto" | "low" | "high";

export const isImage = (a: { mimeType: string }) => ATTACHMENT_TYPES[a.mimeType]?.kind === "image";

// ── Detail ───────────────────────────────────────────────────────────────────

/** Requests that need every word: read, copy, extract, list, act on what is written. */
const READING =
  /\b(qu[eé] dice|le[eé]|leer|lee|transcrib\w*|copi\w*|extra\w*|[ií]tems?|items?|lista|agreg\w*|sum\w*|carg\w*|anot\w*|texto|escrit\w*|pizarr\w*|nota|notas|recibo|ticket|factura|formulario|tabla|error|mensaje de error|captura|screenshot|what does it say|read|text|extract|copy|add|list|whiteboard|receipt|invoice|form|table|handwrit\w*)\b/i;
/** File names of document-like images (screenshots, scans, whiteboards…). */
const DOCUMENT_NAME =
  /(screenshot|captura|screen ?shot|scan|escane|whiteboard|pizarra|receipt|recibo|ticket|factura|invoice|nota|note|form|learning|lista|list|board)/i;

/**
 * High detail when the words matter (reading, extracting, acting on written content; a
 * screenshot/scan-like file; a large or very tall image whose text would be downscaled away).
 * Otherwise auto: the provider picks, and a plain photo stays cheap and fast.
 */
export function imageDetail(input: {
  name: string;
  width?: number;
  height?: number;
  message: string;
}): ImageDetail {
  if (READING.test(input.message) || DOCUMENT_NAME.test(input.name)) return "high";
  const { width = 0, height = 0 } = input;
  if (width * height > 2_500_000) return "high";
  if (width && height && Math.max(width, height) / Math.min(width, height) > 2.2) return "high";
  return "auto";
}

// ── Dimensions (from the bytes; never trusted for anything but telemetry and detail) ─────

export function imageSize(
  mime: string,
  data: Uint8Array,
): { width: number; height: number } | null {
  const u16be = (i: number) => (data[i]! << 8) | data[i + 1]!;
  const u16le = (i: number) => data[i]! | (data[i + 1]! << 8);
  const u24le = (i: number) => data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16);
  const u32be = (i: number) => ((data[i]! << 24) >>> 0) + (data[i + 1]! << 16) + u16be(i + 2);
  try {
    if (mime === "image/png" && data.length >= 24) return { width: u32be(16), height: u32be(20) };
    if (mime === "image/gif" && data.length >= 10) return { width: u16le(6), height: u16le(8) };
    if (mime === "image/webp" && data.length >= 30) {
      const kind = String.fromCharCode(...data.subarray(12, 16));
      if (kind === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
      if (kind === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
      if (kind === "VP8L") {
        const b = data.subarray(21, 25);
        return {
          width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!),
          height: 1 + (((b[3]! & 0xf) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)),
        };
      }
    }
    if (mime === "image/jpeg") {
      // Walk the segments to the frame header (SOF0–SOF15, except DHT/JPG/DAC).
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return null;
        const marker = data[i + 1]!;
        const length = u16be(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { width: u16be(i + 7), height: u16be(i + 5) };
        i += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── Which earlier images a turn refers to ────────────────────────────────────

/** Words that point at something shown earlier ("esa imagen", "lo que te mandé", "the screenshot"). */
const REFERENCE =
  /\b(imagen|imágenes|imagenes|foto|fotos|captura|capturas|screenshot|screenshots|pizarr\w*|lo que te (mand|pas|envi)\w*|lo de arriba|los de arriba|las de arriba|eso que aparece|lo que aparece|que se ven?|que aparecen?|adjunt\w*|image|images|photo|photos|picture|pic|that screenshot|what i sent|above)\b/i;
/** Short anaphoric follow-ups that continue the previous request ("agregalos", "esos", "them"). */
const ANAPHORA =
  /\b(\w+[aeiáéí](los|las|lo|la)|esos|esas|estos|estas|eso|esto|ellos|ellas|them|those|these|it)\b/i;

export interface HistoryWithFiles {
  role: "user" | "assistant";
  content: string;
  attachments?: readonly SentAttachment[];
}

/** How many earlier messages may still be "the image" (≈ the last few exchanges). */
export const IMAGE_CONTEXT_WINDOW = 10;
/** Never more than this many earlier images in one request. */
export const MAX_CONTEXT_IMAGES = 4;

export type ImageContext =
  | { kind: "none" }
  /** Earlier images to show again, by history index → attachment ids. */
  | {
      kind: "resend";
      reason: "named" | "follow_up" | "reference";
      byMessage: Map<number, string[]>;
    }
  /** Several plausible images and nothing says which: ask (by name), resend none. */
  | { kind: "ambiguous"; candidates: string[] };

const normalized = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * The earlier images this turn needs, deterministic and bounded:
 * 1. this turn has its own images → none (what the user just attached is the subject);
 * 2. an earlier image named in the message ("Learning Paths.jpg", "learning paths") → that one;
 * 3. the previous user turn carried images and this is its follow-up → those images;
 * 4. the message points at an image ("esa imagen", "lo que te mandé") → the latest image turn in
 *    the window, unless several different turns had images and the reference is singular → ask.
 * Old, unrelated images are never resent.
 */
export function resolveImageContext(
  history: readonly HistoryWithFiles[],
  message: string,
  hasCurrentImages: boolean,
): ImageContext {
  if (hasCurrentImages) return { kind: "none" };
  const start = Math.max(0, history.length - IMAGE_CONTEXT_WINDOW);
  const turns: { index: number; images: SentAttachment[] }[] = [];
  for (let i = history.length - 1; i >= start; i--) {
    const m = history[i]!;
    const images = m.role === "user" ? (m.attachments ?? []).filter(isImage) : [];
    if (images.length) turns.push({ index: i, images });
  }
  if (!turns.length) return { kind: "none" };
  const pack = (
    picked: { index: number; ids: string[] }[],
    reason: "named" | "follow_up" | "reference",
  ) => {
    const byMessage = new Map<number, string[]>();
    let left = MAX_CONTEXT_IMAGES;
    for (const p of picked) {
      const ids = p.ids.slice(0, left);
      if (ids.length) byMessage.set(p.index, ids);
      left -= ids.length;
    }
    return { kind: "resend" as const, reason, byMessage };
  };

  // 2. Named explicitly (with or without the extension).
  const text = normalized(message);
  const named = turns
    .map((t) => ({
      index: t.index,
      ids: t.images
        .filter((a) => {
          const base = normalized(a.name.replace(/\.[a-z0-9]+$/i, "")).replace(/[_-]+/g, " ");
          return base.length >= 4 && text.includes(base);
        })
        .map((a) => a.id),
    }))
    .filter((t) => t.ids.length);
  if (named.length) return pack(named, "named");

  // 3. The immediate follow-up of an image turn: the last user message before this one.
  const lastUser = [...history.keys()].reverse().find((i) => history[i]!.role === "user");
  const latest = turns[0]!;
  if (lastUser === latest.index && (REFERENCE.test(message) || ANAPHORA.test(message)))
    return pack([{ index: latest.index, ids: latest.images.map((a) => a.id) }], "follow_up");

  // 4. A reference to "the image" further back in the window.
  if (!REFERENCE.test(message)) return { kind: "none" };
  const distinct = turns.flatMap((t) => t.images);
  const plural = /\b(im[aá]genes|fotos|capturas|screenshots|images|photos)\b/i.test(message);
  if (turns.length > 1 && !plural)
    return { kind: "ambiguous", candidates: distinct.map((a) => a.name).slice(0, 6) };
  return pack(
    (plural ? turns : [latest]).map((t) => ({ index: t.index, ids: t.images.map((a) => a.id) })),
    "reference",
  );
}
