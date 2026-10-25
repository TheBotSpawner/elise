"use client";

import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, MapPin, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type TouchEvent } from "react";

import type { ImageGalleryPayload, ImageGroup, VisualResult } from "@/core/web/images";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { VisualSize } from "./composition";

/**
 * Real photos (ADR-120): one labeled carousel per subject — never two places' photos mixed —
 * with arrows, swipe, ←/→ and a counter; one photo shows alone. Opening a photo shows it whole
 * (object-contain) with its subject, credit, license and "Ver fuente". Remote images load lazily
 * straight from their source with no referrer; a broken one becomes a quiet placeholder.
 */
export function ImageGalleryBody({ p, size }: { p: ImageGalleryPayload; size: VisualSize }) {
  const { t } = useI18n();
  const g = t.canvas.gallery;
  const [open, setOpen] = useState<{ group: ImageGroup; index: number } | null>(null);
  const big = size === "focus" || size === "large";
  return (
    <div className="flex min-h-0 flex-col gap-5">
      {p.groups.map((group) => (
        <Carousel
          key={group.key}
          group={group}
          tall={big && p.groups.length === 1}
          onOpen={(index) => setOpen({ group, index })}
        />
      ))}
      {p.moreUrl && (
        <a
          href={p.moreUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={g.external}
          className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-accent-text hover:underline"
        >
          {g.more}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
      {open && <Lightbox group={open.group} start={open.index} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Carousel({
  group,
  tall,
  onOpen,
}: {
  group: ImageGroup;
  tall: boolean;
  onOpen: (index: number) => void;
}) {
  const { t } = useI18n();
  const g = t.canvas.gallery;
  const [i, setI] = useState(0);
  const touch = useRef<number | null>(null);
  const n = group.images.length;
  const go = (d: number) => setI((x) => (x + d + n) % n);
  const image = group.images[i]!;
  const onKey = (e: KeyboardEvent) => {
    if (n < 2) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    go(e.key === "ArrowRight" ? 1 : -1);
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    const dx = start === null ? 0 : (e.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  };
  return (
    <section
      aria-roledescription="carousel"
      aria-label={g.label(group.name)}
      tabIndex={0}
      onKeyDown={onKey}
      className="flex flex-col gap-2 rounded-xl outline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <header className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14.5px] font-medium">{group.name}</span>
          {group.context && (
            <span className="truncate text-[12px] text-faint">{group.context}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[12px]">
          {group.mapsUrl && (
            <a
              href={group.mapsUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 text-accent-text hover:underline"
            >
              <MapPin className="size-3" aria-hidden />
              {g.map}
            </a>
          )}
          {n > 1 && (
            <span className="font-mono text-faint tabular-nums" aria-live="polite">
              {g.of(i + 1, n)}
            </span>
          )}
        </span>
      </header>
      <div
        className="relative overflow-hidden rounded-[12px]"
        onTouchStart={(e) => (touch.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={onTouchEnd}
      >
        <button
          type="button"
          onClick={() => onOpen(i)}
          aria-label={g.enlarge(group.name)}
          className="block w-full cursor-zoom-in"
        >
          <Photo
            key={image.id}
            image={image}
            className={cn(
              "w-full",
              // Logos and diagrams whole, on a light card; photos fill the frame.
              group.fit === "contain" ? "bg-white object-contain p-4" : "object-cover",
              tall ? "aspect-[16/10]" : "aspect-[16/9]",
            )}
          />
        </button>
        {n > 1 && (
          <>
            <Arrow side="left" label={g.previous} onClick={() => go(-1)} />
            <Arrow side="right" label={g.next} onClick={() => go(1)} />
          </>
        )}
      </div>
      {n > 1 && (
        <ul className="flex gap-1.5 overflow-x-auto pb-0.5">
          {group.images.map((im, k) => (
            <li key={im.id} className="shrink-0">
              <button
                type="button"
                aria-label={`${im.alt} · ${g.of(k + 1, n)}`}
                aria-current={k === i}
                onClick={() => setI(k)}
                className={cn(
                  "block rounded-[8px] outline-offset-1",
                  k === i ? "outline-2 outline-accent" : "opacity-70 hover:opacity-100",
                )}
              >
                <Photo
                  image={im}
                  thumb
                  className={cn(
                    "size-12",
                    group.fit === "contain" ? "bg-white object-contain p-1" : "object-cover",
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Credit image={image} />
    </section>
  );
}

function Arrow({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-[rgba(5,8,10,0.45)] text-white backdrop-blur-sm hover:bg-[rgba(5,8,10,0.65)]",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

/** A remote, untrusted image: plain <img>, lazy, no referrer; a placeholder while loading or broken. */
function Photo({
  image,
  className,
  thumb = false,
  whole = false,
}: {
  image: VisualResult;
  className?: string;
  thumb?: boolean;
  whole?: boolean;
}) {
  const { t } = useI18n();
  const primary = whole ? (image.imageUrl ?? image.thumbnailUrl) : image.thumbnailUrl;
  const [src, setSrc] = useState(primary);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed")
    return (
      <span
        className={cn("grid place-items-center bg-[image:var(--media-tone)] text-faint", className)}
        title={t.canvas.gallery.unavailable}
      >
        <ImageOff className={thumb ? "size-4" : "size-6"} aria-hidden />
        <span className="sr-only">{t.canvas.gallery.unavailable}</span>
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote photos from many hosts; never proxied.
    <img
      src={src}
      alt={image.alt}
      loading={whole ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={() => setState("ready")}
      onError={() => {
        // The full image may block hotlinking: fall back to the provider's thumbnail once.
        if (src !== image.thumbnailUrl) setSrc(image.thumbnailUrl);
        else setState("failed");
      }}
      className={cn(
        "bg-[image:var(--media-tone)] transition-opacity motion-reduce:transition-none",
        state === "loading" ? "opacity-60" : "opacity-100",
        className,
      )}
    />
  );
}

function Credit({ image }: { image: VisualResult }) {
  const { t } = useI18n();
  const g = t.canvas.gallery;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] leading-[1.5] text-faint">
      {image.creator &&
        (image.creatorUrl ? (
          <a
            href={image.creatorUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="hover:underline"
          >
            {g.photoBy(image.creator)}
          </a>
        ) : (
          <span>{g.photoBy(image.creator)}</span>
        ))}
      {image.license &&
        (image.licenseUrl ? (
          <a
            href={image.licenseUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="hover:underline"
          >
            {image.license}
          </a>
        ) : (
          <span>{image.license}</span>
        ))}
      {image.sourceName && <span>{image.sourceName}</span>}
      <a
        href={image.sourcePageUrl}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="inline-flex items-center gap-1 text-accent-text hover:underline"
      >
        {g.viewSource}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </p>
  );
}

/** The photo whole, on a native modal dialog: focus trapped, Escape closes, ←/→ move. */
function Lightbox({
  group,
  start,
  onClose,
}: {
  group: ImageGroup;
  start: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const g = t.canvas.gallery;
  const ref = useRef<HTMLDialogElement>(null);
  const [i, setI] = useState(start);
  const n = group.images.length;
  const image = group.images[i]!;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  const go = (d: number) => setI((x) => (x + d + n) % n);
  return (
    <dialog
      ref={ref}
      aria-label={g.label(group.name)}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (n < 2) return;
        if (e.key === "ArrowRight") go(1);
        if (e.key === "ArrowLeft") go(-1);
      }}
      className="m-auto h-[min(92vh,900px)] w-[min(96vw,1400px)] max-w-none rounded-2xl border border-border bg-surface p-0 text-fg backdrop:bg-black/70"
    >
      <div className="flex h-full flex-col gap-3 p-3 sm:p-4">
        <header className="flex items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[15px] font-medium">{group.name}</span>
            <span className="truncate text-[12px] text-faint">
              {[group.context, n > 1 ? g.of(i + 1, n) : null].filter(Boolean).join(" · ")}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={g.close}
            className="grid size-9 place-items-center rounded-full hover:bg-active"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="relative min-h-0 flex-1">
          <Photo
            key={image.id}
            image={image}
            whole
            className={cn(
              "size-full rounded-xl object-contain",
              group.fit === "contain" && "bg-white p-6",
            )}
          />
          {n > 1 && (
            <>
              <Arrow side="left" label={g.previous} onClick={() => go(-1)} />
              <Arrow side="right" label={g.next} onClick={() => go(1)} />
            </>
          )}
        </div>
        <Credit image={image} />
      </div>
    </dialog>
  );
}
