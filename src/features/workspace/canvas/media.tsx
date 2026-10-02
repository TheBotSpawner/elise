"use client";

import { ExternalLink, Globe, ImageOff, Play } from "lucide-react";
import { useState } from "react";

import { embedSrc, videoEmbed, type MediaPayload } from "@/core/workspace/media";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { VisualSize } from "./composition";

/**
 * Media primitives (ADR-021): image, gallery, video and link preview, from URLs the workspace
 * already holds. A video plays only after the user asks, inside an allow-listed player
 * (no autoplay, no third-party request before that). Audio has no provider yet.
 */
export function MediaBody({ p, size }: { p: MediaPayload; size: VisualSize }) {
  switch (p.kind) {
    case "video":
      return <Video item={p.items[0]!} size={size} caption={p.caption} />;
    case "image":
    case "gallery":
      return <Gallery p={p} size={size} />;
    case "link":
      return (
        <ul className="flex flex-col gap-2">
          {p.items.map((it) => (
            <li key={it.url}>
              <LinkPreview item={it} />
            </li>
          ))}
        </ul>
      );
  }
}

type Item = MediaPayload["items"][number];

function Picture({ item, className }: { item: Item; className?: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (!item.image || failed)
    return (
      <span
        className={cn(
          "grid place-items-center rounded-[10px] bg-[image:var(--media-tone)] text-faint",
          className,
        )}
        title={failed ? t.canvas.media.unavailable : undefined}
      >
        <ImageOff className="size-6" aria-hidden />
        <span className="sr-only">{failed ? t.canvas.media.unavailable : item.alt}</span>
      </span>
    );
  return (
    // Remote, untrusted images: plain <img>, lazy, no referrer; never proxied or enlarged.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={item.image}
      alt={item.alt || item.title}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("rounded-[10px] bg-[image:var(--media-tone)] object-cover", className)}
    />
  );
}

function Gallery({ p, size }: { p: MediaPayload; size: VisualSize }) {
  const [selected, setSelected] = useState(0);
  const many = p.items.length > 1;
  const big = size === "focus" || size === "large";
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Picture
        item={p.items[selected]!}
        className={cn("w-full", big ? "aspect-[16/10]" : "aspect-[16/9]")}
      />
      {many && (
        <ul className="grid grid-cols-6 gap-2">
          {p.items.map((it, i) => (
            <li key={it.url}>
              <button
                type="button"
                aria-label={it.title || it.alt}
                aria-pressed={i === selected}
                onClick={() => setSelected(i)}
                className={cn(
                  "block w-full rounded-[10px] outline-offset-2",
                  i === selected && "outline-2 outline-accent",
                )}
              >
                <Picture item={it} className="aspect-square w-full" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(p.caption || p.items[selected]!.title) && (
        <p className="text-[13px] leading-[1.5] text-fg2">
          {p.caption ?? p.items[selected]!.title}
        </p>
      )}
      <p className="text-[12px] text-faint">{p.items[selected]!.domain}</p>
    </div>
  );
}

function Video({ item, size, caption }: { item: Item; size: VisualSize; caption?: string }) {
  const { t } = useI18n();
  const embed = videoEmbed(item.url);
  const [state, setState] = useState<"preview" | "loading" | "playing">("preview");
  if (!embed) return <LinkPreview item={item} />;
  const play = size === "focus" || size === "large" ? "size-16" : "size-12";
  return (
    <div className="flex min-h-0 flex-col gap-2.5">
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-[image:var(--media-tone)]">
        {state === "preview" ? (
          <>
            {item.image && (
              <Picture item={item} className="absolute inset-0 size-full rounded-none" />
            )}
            <button
              type="button"
              onClick={() => setState("loading")}
              aria-label={`${t.canvas.media.play}: ${item.title}`}
              className={cn(
                "absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-[rgba(5,8,10,0.55)] text-white backdrop-blur-sm",
                play,
              )}
            >
              <Play className="ml-0.5 size-[18px] fill-current" aria-hidden />
            </button>
          </>
        ) : (
          <>
            {state === "loading" && (
              <span className="absolute inset-0 grid animate-pulse place-items-center font-mono text-[10.5px] tracking-[0.1em] text-faint uppercase">
                {t.canvas.media.loading}
              </span>
            )}
            <iframe
              src={embedSrc(embed, true)}
              title={item.title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => setState("playing")}
              className="absolute inset-0 size-full border-0"
            />
          </>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <p
          className={cn(
            "leading-[1.3] font-medium",
            size === "focus" ? "text-[20px]" : "text-[15px]",
          )}
        >
          {item.title}
        </p>
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          {caption ?? item.domain}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 text-accent-text hover:underline"
          >
            {t.canvas.media.openSource}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        </p>
      </div>
    </div>
  );
}

export function LinkPreview({ item }: { item: Item }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3">
      <span
        className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-avatar text-fg2"
        aria-hidden
      >
        <Globe className="size-[15px]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px]">{item.title || item.domain}</span>
        <span className="truncate text-[12px] text-faint">{item.domain}</span>
      </span>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex h-8 shrink-0 items-center rounded-full border border-border px-3 text-[12.5px] hover:border-accent-line"
      >
        {t.canvas.media.open}
      </a>
    </div>
  );
}
