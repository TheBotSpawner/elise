"use client";

import {
  ExternalLink,
  MonitorSpeaker,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import type { MusicPayload } from "@/core/workspace/music";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { musicAction } from "./actions";
import {
  controlMusic,
  listMusicDevices,
  receiveMusic,
  startMusicPolling,
  type MusicOp,
} from "./controller";
import { formatTime, liveProgress, musicStore } from "./store";
import { setYouTubeHost, stopYouTube } from "./youtube-player";

const PROVIDER_NAME: Record<MusicPayload["provider"], string> = {
  spotify: "Spotify",
  youtube: "YouTube",
  deezer: "Deezer",
  device: "ELISE",
};

/** The canonical state, live: re-renders on every change. */
export function useMusic() {
  return useSyncExternalStore(musicStore.subscribe, musicStore.get, musicStore.get);
}

/** Ticks once a second while playing, so progress moves without polling. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Decorative: bars that breathe while playing and rest when paused (no audio analysis). */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("elise-eq text-accent", className)} data-playing={playing}>
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function useControl() {
  const { t } = useI18n();
  return async (op: MusicOp, args: Record<string, unknown> = {}) => {
    const r = await controlMusic(op, args);
    if (!r.ok) toast.error(errorText(t, r.error));
  };
}

function Artwork({ src, size }: { src: string | null; size: number }) {
  return src ? (
    // Provider artwork (https only, validated in the payload); decorative next to the title.
    // eslint-disable-next-line @next/next/no-img-element -- remote provider images, any host
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-xl object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="grid shrink-0 place-items-center rounded-xl bg-surface-2 text-faint"
      style={{ width: size, height: size }}
    >
      <Music className="size-1/3" aria-hidden />
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  primary = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40",
        primary
          ? "size-10 bg-fg text-bg hover:opacity-90"
          : "size-9 text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The Music Surface (ADR-042). Compact: artwork, song, artist, play/pause, next, a quiet
 * playing indicator. Larger: progress, previous, volume, device, choices, provider link. It
 * shows the live state when this page's player state is for the same provider, and the
 * Surface's own snapshot otherwise.
 */
export function MusicSurfaceBody({
  p: snapshot,
  size,
}: {
  p: MusicPayload;
  size: "micro" | "small" | "medium" | "large" | "expanded" | "focus";
}) {
  const { t } = useI18n();
  const live = useMusic();
  const control = useControl();
  const same = live.payload?.provider === snapshot.provider;
  const p: MusicPayload = same
    ? {
        ...snapshot,
        ...live.payload!,
        results: live.payload!.results ?? snapshot.results,
        devices: live.payload!.devices ?? snapshot.devices,
        notice: snapshot.notice,
      }
    : snapshot;
  const now = useNow(p.playing);
  const at = same ? live.at : Date.parse(snapshot.at) || now;
  const progress = liveProgress(p, at, now);
  const compact = size === "micro" || size === "small";
  const has = (f: MusicPayload["features"][number]) => p.features.includes(f);
  const item = p.item;
  const name = PROVIDER_NAME[p.provider];
  async function playResult(r: NonNullable<MusicPayload["results"]>[number]) {
    const x = await musicAction("play", { ref: r.ref, kind: r.kind, query: r.title });
    if (!x.ok) toast.error(errorText(t, x.error));
    else if (x.display) await receiveMusic(x.display);
  }

  const controls = (
    <div className="flex items-center gap-1">
      {!compact && (
        <IconButton label={t.music.previous} onClick={() => void control("previous")}>
          <SkipBack className="size-4" />
        </IconButton>
      )}
      <IconButton
        primary
        label={p.playing ? t.music.pause : t.music.play}
        onClick={() => void control(p.playing ? "pause" : "resume")}
        disabled={!item}
      >
        {p.playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </IconButton>
      <IconButton label={t.music.next} onClick={() => void control("next")} disabled={!item}>
        <SkipForward className="size-4" />
      </IconButton>
    </div>
  );

  if (compact)
    return (
      <div className="flex min-w-0 items-center gap-3">
        <Artwork src={item?.artwork ?? null} size={44} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 truncate text-[14px] font-medium">
            <Equalizer playing={p.playing} />
            <span className="truncate">{item?.title ?? t.music.nothing}</span>
          </p>
          <p className="truncate text-[12.5px] text-muted">{item?.subtitle ?? name}</p>
        </div>
        {controls}
      </div>
    );

  const large = size === "large" || size === "expanded" || size === "focus";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={cn("flex min-w-0 gap-4", large ? "flex-col sm:flex-row" : "items-center")}>
        <Artwork src={item?.artwork ?? null} size={large ? 168 : 72} />
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-1">
          <p className="flex items-center gap-2 text-[12px] text-faint">
            <Equalizer playing={p.playing} />
            {p.playing ? t.music.playing : t.music.paused}
            {p.device && <span>· {t.music.on(p.device.name)}</span>}
          </p>
          <p
            className={cn("truncate font-medium", large ? "text-[22px] font-light" : "text-[16px]")}
          >
            {item?.title ?? t.music.nothing}
          </p>
          {item?.subtitle && <p className="truncate text-[14px] text-muted">{item.subtitle}</p>}
          {p.context?.title && (
            <p className="truncate text-[12.5px] text-faint">{t.music.from(p.context.title)}</p>
          )}
        </div>
      </div>

      {item && (
        <div className="flex flex-col gap-1">
          <input
            type="range"
            aria-label={t.music.title}
            min={0}
            max={Math.max(1, p.durationMs)}
            value={Math.min(progress, p.durationMs || progress)}
            disabled={!has("seek")}
            onChange={(e) => void control("seek", { ms: Number(e.target.value) })}
            className="h-1 w-full cursor-pointer accent-[var(--color-accent)] disabled:cursor-default"
          />
          <div className="flex justify-between font-mono text-[11.5px] text-faint">
            <span>{formatTime(progress)}</span>
            <span>{p.durationMs ? formatTime(p.durationMs) : ""}</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {controls}
        <div className="flex items-center gap-2">
          {has("volume") && p.volume !== null && (
            <label className="flex items-center gap-2 text-muted">
              <Volume2 className="size-4" aria-hidden />
              <span className="sr-only">{t.music.volume}</span>
              <input
                type="range"
                min={0}
                max={100}
                defaultValue={p.volume}
                key={p.volume}
                onPointerUp={(e) =>
                  void control("setVolume", { percent: Number(e.currentTarget.value) })
                }
                onKeyUp={(e) =>
                  void control("setVolume", { percent: Number(e.currentTarget.value) })
                }
                className="h-1 w-24 accent-[var(--color-accent)]"
              />
            </label>
          )}
          {has("devices") && (
            <IconButton label={t.music.devices} onClick={() => void listMusicDevices()}>
              <MonitorSpeaker className="size-4" />
            </IconButton>
          )}
          {item?.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t.music.open(name)}
            </a>
          )}
        </div>
      </div>

      {live.autoplayBlocked && same && (
        <p className="text-[12.5px] text-approval-text">{t.music.tapToStart}</p>
      )}
      {p.notice && <p className="text-[12.5px] text-approval-text">{p.notice}</p>}
      {p.provider === "youtube" && <p className="text-[12px] text-faint">{t.music.embeddedNote}</p>}

      {p.devices && p.devices.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="type-label text-faint">{t.music.devices}</h3>
          <ul className="flex flex-wrap gap-1.5">
            {p.devices.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  disabled={d.restricted || d.active}
                  onClick={() => void control("transfer", { device: d.name })}
                  className={cn(
                    "h-8 rounded-full border px-3 text-[12.5px] transition-colors",
                    d.active
                      ? "border-accent-line text-accent-text"
                      : "border-border text-muted hover:border-border-strong hover:text-fg",
                  )}
                >
                  {d.type === "browser" ? t.music.thisBrowser : d.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.results && p.results.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="type-label text-faint">{t.music.results}</h3>
          <ul className="flex flex-col">
            {p.results.slice(0, 6).map((r) => (
              <li key={r.ref}>
                <button
                  type="button"
                  onClick={() => void playResult(r)}
                  className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <Artwork src={r.artwork} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{r.title}</span>
                    <span className="block truncate text-[12px] text-muted">
                      {[r.kind, r.subtitle].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {p.queue && p.queue.length > 1 && large && (
        <section className="flex flex-col gap-1">
          <h3 className="type-label text-faint">{t.music.queue}</h3>
          <ol className="flex flex-col text-[13px] text-muted">
            {p.queue.slice((p.index ?? 0) + 1, (p.index ?? 0) + 6).map((q) => (
              <li key={q.ref} className="truncate py-0.5">
                {q.title}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * The YouTube player's frame (ADR-042): visible whenever YouTube plays — YouTube forbids
 * background or hidden players — compact in a corner, larger when video was asked for.
 * Closing it stops playback.
 */
function YouTubeFrame() {
  const { t } = useI18n();
  const live = useMusic();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setYouTubeHost(ref.current);
    return () => setYouTubeHost(null);
  }, []);
  const active = live.payload?.provider === "youtube";
  const video = Boolean(live.payload?.video);
  return (
    <div
      className={cn(
        "fixed right-4 bottom-4 z-40 overflow-hidden rounded-2xl border border-border bg-black shadow-2xl transition-[opacity,width,height]",
        active ? "opacity-100" : "pointer-events-none opacity-0",
        // At least 200×200 px of player (YouTube's minimum viewport), 16:9 when watching.
        video
          ? "h-[270px] w-[min(480px,calc(100vw-32px))]"
          : "h-[200px] w-[min(356px,calc(100vw-32px))]",
      )}
      aria-hidden={!active}
    >
      <div ref={ref} className="size-full" />
      {active && (
        <button
          type="button"
          aria-label={t.music.pause}
          onClick={stopYouTube}
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Pages where the Live Canvas (with its Music Surface) is on screen. */
const CANVAS = /^\/($|chat\/)/;

/**
 * A quiet mini-player in the app shell (ADR-042 §I) when music plays and the Canvas isn't on
 * screen: the same canonical state, never a second player. Its title returns to the Canvas.
 */
function MiniPlayer() {
  const { t } = useI18n();
  const live = useMusic();
  const control = useControl();
  const path = usePathname();
  const p = live.payload;
  if (!p?.item || CANVAS.test(path) || p.provider === "youtube") return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex w-[min(420px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-border bg-[var(--menu-bg)] px-3 py-2 shadow-xl backdrop-blur">
      <Artwork src={p.item.artwork} size={36} />
      <Link href="/" className="min-w-0 flex-1" title={t.music.backToCanvas}>
        <span className="flex items-center gap-2 truncate text-[13.5px] font-medium">
          <Equalizer playing={p.playing} />
          <span className="truncate">{p.item.title}</span>
        </span>
        <span className="block truncate text-[12px] text-muted">{p.item.subtitle}</span>
      </Link>
      <IconButton
        label={p.playing ? t.music.pause : t.music.play}
        onClick={() => void control(p.playing ? "pause" : "resume")}
      >
        {p.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </IconButton>
      <IconButton label={t.music.next} onClick={() => void control("next")}>
        <SkipForward className="size-4" />
      </IconButton>
    </div>
  );
}

/** Mounted once in the app shell: follows the provider, hosts the players, the mini-player. */
export function MusicController() {
  useEffect(() => startMusicPolling(), []);
  return (
    <>
      <YouTubeFrame />
      <MiniPlayer />
    </>
  );
}
