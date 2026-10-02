"use client";

import {
  Bike,
  Car,
  Clock,
  ExternalLink,
  Footprints,
  Globe,
  LocateFixed,
  MapPin,
  Phone,
  Star,
  TrainFront,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { decodePolyline, type LatLng, type TravelMode } from "@/core/location/model";
import type { MapPayload, PlacePayload } from "@/core/workspace/location";
import { shareLocation, stopSharing, useSharedLocation } from "@/features/location/shared-location";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import type { VisualSize } from "./composition";

/**
 * Location Surfaces (ADR-023): a map of places, a route or a travel-time comparison, and one
 * place in detail. The map is the Maps JavaScript API with Advanced Markers, loaded only when
 * a map is shown, with the restricted browser key. Without a key (or offline) the same data
 * renders as a list — the map is an aid, never the only way to read the answer.
 */

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
// Advanced Markers need a Map ID; Google's demo id is for development only.
const MAP_ID =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ||
  (process.env.NODE_ENV === "production" ? "" : "DEMO_MAP_ID");

declare global {
  interface Window {
    __eliseMapsReady?: () => void;
  }
}

let loading: Promise<void> | null = null;
/** Loads the Maps JavaScript API once (async loading, current "weekly" channel). */
function loadMaps(): Promise<void> {
  if (!KEY || !MAP_ID) return Promise.reject(new Error("maps not configured"));
  if (typeof google !== "undefined" && "importLibrary" in (google.maps ?? {}))
    return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    window.__eliseMapsReady = () => resolve();
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: KEY,
      v: "weekly",
      loading: "async",
      callback: "__eliseMapsReady",
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("maps failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const subscribeTheme = (cb: () => void) => {
  const o = new MutationObserver(cb);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => o.disconnect();
};
function useDark(): boolean {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => true,
  );
}

interface Pin {
  id: string;
  label: string;
  at: LatLng;
  /** Shown on the pin; default: its number. */
  glyph?: string;
}

/**
 * One map: pins (numbered, selectable) and an optional route line. The selection is shared
 * with the list beside it, both ways.
 */
function MapCanvas({
  pins,
  line,
  selected,
  onSelect,
  className,
}: {
  pins: Pin[];
  line: LatLng[] | null;
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const { t } = useI18n();
  const dark = useDark();
  const box = useRef<HTMLDivElement>(null);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const [failed, setFailed] = useState(!KEY || !MAP_ID);
  const select = useRef(onSelect);
  useEffect(() => {
    select.current = onSelect;
  }, [onSelect]);

  // Data is a snapshot: the map is built once per theme and content.
  const signature = JSON.stringify([pins, line?.length, dark]);
  useEffect(() => {
    if (!KEY || !MAP_ID) return;
    let cancelled = false;
    const created = new Map<string, google.maps.marker.AdvancedMarkerElement>();
    let polyline: google.maps.Polyline | null = null;
    loadMaps()
      .then(async () => {
        const [{ Map: GMap, Polyline }, { AdvancedMarkerElement, PinElement }, core] =
          await Promise.all([
            google.maps.importLibrary("maps") as Promise<google.maps.MapsLibrary>,
            google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
            google.maps.importLibrary("core") as Promise<google.maps.CoreLibrary>,
          ]);
        if (cancelled || !box.current) return;
        const map = new GMap(box.current, {
          mapId: MAP_ID,
          colorScheme: dark ? core.ColorScheme.DARK : core.ColorScheme.LIGHT,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          gestureHandling: "cooperative",
        });
        const bounds = new core.LatLngBounds();
        pins.forEach((p, i) => {
          const pin = new PinElement({
            glyphText: p.glyph ?? String(i + 1),
            background: "#0a95a6",
            borderColor: "#06707d",
            glyphColor: "#ffffff",
          });
          const marker = new AdvancedMarkerElement({
            map,
            position: p.at,
            title: p.label,
            content: pin,
            gmpClickable: true,
          });
          marker.addEventListener("gmp-click", () => select.current(p.id));
          created.set(p.id, marker);
          bounds.extend(p.at);
        });
        if (line?.length) {
          polyline = new Polyline({
            map,
            path: line,
            strokeColor: dark ? "#5ee6f0" : "#0a95a6",
            strokeOpacity: 0.9,
            strokeWeight: 5,
          });
          line.forEach((x) => bounds.extend(x));
        }
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, 48);
          if (pins.length === 1 && !line?.length) map.setZoom(16);
        }
        markers.current = created;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      created.forEach((m) => (m.map = null));
      polyline?.setMap(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when the content changes
  }, [signature]);

  useEffect(() => {
    markers.current.forEach((m, id) => {
      m.zIndex = id === selected ? 10 : 1;
      const content = m.content as HTMLElement | null;
      if (content) content.style.transform = id === selected ? "scale(1.25)" : "";
    });
  }, [selected]);

  if (failed)
    return (
      <p className={cn("flex items-center gap-2 text-[12px] text-muted", className && "py-2")}>
        <MapPin className="size-4" aria-hidden />
        {t.location.mapUnavailable}
      </p>
    );
  return (
    <div
      ref={box}
      role="region"
      aria-label={t.workspace.types.map}
      className={cn("overflow-hidden rounded-[12px] bg-[var(--surface-2)]", className)}
    />
  );
}

const MODE_ICON: Record<TravelMode, typeof Car> = {
  drive: Car,
  walk: Footprints,
  bicycle: Bike,
  transit: TrainFront,
};

function useFormat() {
  const { t, locale } = useI18n();
  return {
    duration: (s: number | null) => {
      if (s == null) return t.location.noRoute;
      const m = Math.max(1, Math.round(s / 60));
      return m < 60 ? t.location.minutes(m) : t.location.hoursMinutes(Math.floor(m / 60), m % 60);
    },
    distance: (m: number | null) =>
      m == null ? "" : m < 1000 ? t.location.meters(m) : t.location.km((m / 1000).toFixed(1)),
    time: (iso: string) =>
      new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
  };
}

export function MapBody({
  p,
  size,
  onPrompt,
}: {
  p: MapPayload;
  size: VisualSize;
  onPrompt: (text: string) => void;
}) {
  switch (p.mode) {
    case "locate":
      return <LocateCard onPrompt={onPrompt} />;
    case "route":
      return p.route ? <RouteView route={p.route} size={size} /> : null;
    case "compare":
      return p.comparison ? <Comparison c={p.comparison} /> : null;
    case "places":
      return <Places p={p} size={size} />;
  }
}

function Places({ p, size }: { p: MapPayload; size: VisualSize }) {
  const { t } = useI18n();
  const f = useFormat();
  const [selected, setSelected] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLLIElement>());
  const big = size === "focus" || size === "large";
  const pins = p.places.map((x) => ({ id: x.id, label: x.name, at: x.location }));
  const choose = (id: string) => {
    setSelected(id);
    items.current.get(id)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  return (
    <div className={cn("relative flex min-h-0 flex-col gap-3", size === "focus" && "md:flex-row")}>
      <MapCanvas
        pins={pins}
        line={null}
        selected={selected}
        onSelect={choose}
        className={cn(
          "w-full shrink-0",
          size === "focus"
            ? "h-[60vh] md:h-auto md:min-h-[420px] md:flex-1"
            : big
              ? "h-64"
              : "h-44",
        )}
      />
      <ol
        className={cn(
          "flex flex-col gap-1 overflow-y-auto",
          // Mobile focus: the list is a bottom sheet over the map.
          size === "focus" &&
            "max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[45%] max-md:rounded-t-[16px] max-md:bg-[var(--bg)] max-md:p-3 max-md:shadow-lg md:w-80",
          size !== "focus" && (big ? "max-h-72" : "max-h-40"),
        )}
      >
        {p.places.map((x, i) => (
          <li
            key={x.id}
            ref={(el) => {
              if (el) items.current.set(x.id, el);
              else items.current.delete(x.id);
            }}
          >
            <button
              type="button"
              onClick={() => setSelected(x.id)}
              aria-pressed={selected === x.id}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-2)]",
                selected === x.id && "bg-[var(--accent-soft)]",
              )}
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--accent)] font-mono text-[10px] text-white">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-fg">{x.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  {x.category && <span>{x.category}</span>}
                  {x.rating != null && (
                    <span className="inline-flex items-center gap-0.5">
                      <Star className="size-3" aria-hidden />
                      {x.rating.toFixed(1)}
                      {x.ratingCount != null && ` ${t.location.ratings(x.ratingCount)}`}
                    </span>
                  )}
                  {x.distanceMeters != null && <span>{f.distance(x.distanceMeters)}</span>}
                  {x.openNow != null && (
                    <span className={x.openNow ? "text-[var(--accent-text)]" : undefined}>
                      {x.openNow ? t.location.openNow : t.location.closedNow}
                    </span>
                  )}
                </span>
                {selected === x.id && x.address && (
                  <span className="block text-[11px] text-muted">{x.address}</span>
                )}
              </span>
              {selected === x.id && x.mapsUrl && (
                <a
                  href={x.mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 text-muted hover:text-fg"
                  aria-label={t.location.openInMaps}
                >
                  <ExternalLink className="size-4" aria-hidden />
                </a>
              )}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function RouteView({ route, size }: { route: NonNullable<MapPayload["route"]>; size: VisualSize }) {
  const { t } = useI18n();
  const f = useFormat();
  const Icon = MODE_ICON[route.mode];
  const line = route.polyline ? decodePolyline(route.polyline) : null;
  const pins = [
    ...(route.start && !route.fromHere
      ? [{ id: "a", label: route.from, at: route.start, glyph: "A" }]
      : []),
    ...(route.end ? [{ id: "b", label: route.to, at: route.end, glyph: "B" }] : []),
  ];
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-[22px] font-semibold text-fg">
          <Icon className="size-5 text-muted" aria-label={t.location.modes[route.mode]} />
          {f.duration(route.durationSeconds)}
        </span>
        <span className="text-[13px] text-muted">{f.distance(route.distanceMeters)}</span>
        {route.arrival && (
          <span className="inline-flex items-center gap-1 text-[13px] text-muted">
            <Clock className="size-3.5" aria-hidden />
            {t.location.arrive(f.time(route.arrival))}
          </span>
        )}
      </div>
      <p className="text-[12px] text-muted">
        {route.from} → {route.to}
      </p>
      {(line || pins.length > 0) && (
        <MapCanvas
          pins={pins}
          line={line}
          selected={null}
          onSelect={() => undefined}
          className={size === "focus" ? "h-[60vh]" : size === "large" ? "h-72" : "h-48"}
        />
      )}
      {route.warnings.length > 0 && (
        <ul className="text-[11px] text-muted">
          {route.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Comparison({ c }: { c: NonNullable<MapPayload["comparison"]> }) {
  const { t } = useI18n();
  const f = useFormat();
  const Icon = MODE_ICON[c.mode];
  const fastest = c.rows.find((r) => r.durationSeconds != null)?.durationSeconds ?? null;
  const longest = Math.max(1, ...c.rows.map((r) => r.durationSeconds ?? 0));
  return (
    <div className="flex flex-col gap-2">
      <p className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <Icon className="size-3.5" aria-hidden />
        {t.location.modes[c.mode]}
        {c.origins.length === 1 && ` · ${t.location.from} ${c.origins[0]}`}
      </p>
      <ol className="flex flex-col gap-1.5">
        {c.rows.map((r, i) => (
          <li key={`${r.origin}:${r.destination}:${i}`} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate text-fg">
                {c.origins.length > 1 && `${c.origins[r.origin]} → `}
                {r.destination}
              </span>
              <span className="shrink-0 font-mono text-[12px] text-fg">
                {f.duration(r.durationSeconds)}
                {r.durationSeconds != null && r.durationSeconds === fastest && (
                  <span className="ml-1.5 text-[var(--accent-text)]">{t.location.fastest}</span>
                )}
              </span>
            </span>
            {r.durationSeconds != null && (
              <span
                aria-hidden
                className="h-1 rounded-full bg-[var(--accent)]"
                style={{ width: `${Math.max(4, (r.durationSeconds / longest) * 100)}%` }}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Asks for the position once, on the user's tap; then continues the request. */
function LocateCard({ onPrompt }: { onPrompt: (text: string) => void }) {
  const { t } = useI18n();
  const sharing = useSharedLocation();
  const [state, setState] = useState<"idle" | "locating" | "denied" | "failed">("idle");
  const share = async () => {
    setState("locating");
    const result = await shareLocation();
    if (result === "shared") {
      setState("idle");
      onPrompt(t.location.prompt);
    } else setState(result);
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[14px] font-medium text-fg">{t.location.askTitle}</p>
      <p className="text-[12px] text-muted">{t.location.askBody}</p>
      {state === "denied" && <p className="text-[12px] text-fg">{t.location.denied}</p>}
      {state === "failed" && <p className="text-[12px] text-fg">{t.location.failed}</p>}
      {sharing ? (
        <div className="flex items-center gap-3 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <LocateFixed className="size-4 text-[var(--accent-text)]" aria-hidden />
            {t.location.shared}
          </span>
          <button type="button" onClick={stopSharing} className="underline hover:text-fg">
            {t.location.stopSharing}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void share()}
          disabled={state === "locating"}
          className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-white disabled:opacity-60"
        >
          <LocateFixed className="size-4" aria-hidden />
          {state === "locating" ? t.location.locating : t.location.share}
        </button>
      )}
    </div>
  );
}

export function PlaceBody({ p, size }: { p: PlacePayload; size: VisualSize }) {
  const { t } = useI18n();
  const big = size === "focus" || size === "large";
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {p.photo && (
        <figure className="flex flex-col gap-1">
          {/* A provider-issued photo URL: plain, lazy, no referrer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={p.photo.url}
            alt={p.name}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn(
              "w-full rounded-[10px] object-cover",
              big ? "aspect-[16/9]" : "aspect-[2/1]",
            )}
          />
          {p.photo.attributions.length > 0 && (
            <figcaption className="text-[10px] text-faint">
              {t.location.photoBy}:{" "}
              {p.photo.attributions.map((a, i) => (
                <span key={`${a.name}${i}`}>
                  {i > 0 && ", "}
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline">
                      {a.name}
                    </a>
                  ) : (
                    a.name
                  )}
                </span>
              ))}
            </figcaption>
          )}
        </figure>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
        {p.category && <span>{p.category}</span>}
        {p.rating != null && (
          <span className="inline-flex items-center gap-0.5">
            <Star className="size-3" aria-hidden />
            {p.rating.toFixed(1)}
            {p.ratingCount != null && ` ${t.location.ratings(p.ratingCount)}`}
          </span>
        )}
        {p.priceLevel != null && p.priceLevel > 0 && <span>{"$".repeat(p.priceLevel)}</span>}
        {p.openNow != null && (
          <span className={p.openNow ? "text-[var(--accent-text)]" : "text-fg"}>
            {p.openNow ? t.location.openNow : t.location.closedNow}
          </span>
        )}
      </div>
      {p.address && <p className="text-[13px] text-fg">{p.address}</p>}
      {big && (
        <MapCanvas
          pins={[{ id: p.id, label: p.name, at: p.location }]}
          line={null}
          selected={null}
          onSelect={() => undefined}
          className="h-48"
        />
      )}
      {p.hours.length > 0 && (
        <details className="text-[12px] text-muted" open={big}>
          <summary className="cursor-pointer text-fg">{t.location.hours}</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {p.hours.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap gap-2 text-[12px]">
        {p.mapsUrl && (
          <a className={chip} href={p.mapsUrl} target="_blank" rel="noopener noreferrer">
            <MapPin className="size-3.5" aria-hidden />
            {t.location.openInMaps}
          </a>
        )}
        {p.website && (
          <a className={chip} href={p.website} target="_blank" rel="noopener noreferrer">
            <Globe className="size-3.5" aria-hidden />
            {t.location.website}
          </a>
        )}
        {p.phone && (
          <a className={chip} href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>
            <Phone className="size-3.5" aria-hidden />
            {t.location.call}
          </a>
        )}
      </div>
    </div>
  );
}

const chip =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] px-3 py-1.5 text-fg hover:bg-[var(--surface-2)]";
