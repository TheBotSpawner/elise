/**
 * Video embeds from known URLs (ADR-021), without schema code: the browser imports this, so it
 * must stay free of the payload validators.
 */

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
