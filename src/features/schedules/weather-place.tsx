"use client";

import { MapPin, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import type { CitySuggestion } from "@/core/location/model";
import type { WeatherPlace } from "@/core/schedules/schedule";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { suggestWeatherCitiesAction, weatherCityAction } from "./actions";

/**
 * The weather block's city (ADR-069): typed, then chosen from Google Places suggestions at city
 * level, so a forecast never depends on spelling. What is saved is the place (id, names,
 * coordinates). A schedule that only has an old text name keeps working until it's re-picked;
 * where Places isn't available (a dev setup), the text is used as before.
 */
export function WeatherPlacePicker({
  id,
  place,
  legacy,
  onChange,
}: {
  id: string;
  place: WeatherPlace | null;
  /** An older schedule's free-text city. */
  legacy: string | null;
  onChange: (next: { place: WeatherPlace | null; text: string | null }) => void;
}) {
  const { t } = useI18n();
  const w = t.schedules.weatherPicker;
  const listId = useId();
  const [query, setQuery] = useState(place?.displayName ?? legacy ?? "");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CitySuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  // One session per search: Google bills typing + the chosen place together.
  const session = useRef<string>(crypto.randomUUID());
  const shown = place?.displayName ?? legacy ?? "";
  // The latest callback, without re-running the search effect when the parent re-renders.
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  const searching = query.trim().length >= 2 && query !== shown;
  // Suggestions belong to what's typed now; a cleared or picked field shows none.
  const visible = searching ? items : [];

  useEffect(() => {
    if (!open || unavailable) return;
    const q = query.trim();
    if (q.length < 2 || q === shown) return;
    let live = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      const r = await suggestWeatherCitiesAction(q, session.current);
      if (!live) return;
      setLoading(false);
      if (r.ok) {
        setItems(r.value);
        setActive(0);
      } else if (r.error.code === "CAPABILITY_UNAVAILABLE") {
        // Without Places, what was typed is the city, as before.
        setUnavailable(true);
        changed.current({ place: null, text: q });
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, open, unavailable, shown]);

  async function pick(s: CitySuggestion) {
    setOpen(false);
    setQuery(s.detail ? `${s.label}, ${s.detail}` : s.label);
    const r = await weatherCityAction(s.placeId, session.current);
    session.current = crypto.randomUUID();
    if (r.ok) {
      setQuery(r.value.displayName);
      onChange({ place: r.value, text: r.value.city ?? r.value.displayName });
    } else setQuery(shown);
  }

  // Without Places, the old behavior: the typed city is saved as text.
  if (unavailable)
    return (
      <div className="flex flex-col gap-1.5">
        <Input
          id={id}
          value={query}
          maxLength={120}
          placeholder={w.search}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange({ place: null, text: e.target.value.trim() ? e.target.value : null });
          }}
        />
        <p className="text-[12.5px] text-faint">{w.unavailable}</p>
      </div>
    );

  return (
    <div className="relative flex flex-col gap-1.5">
      <div className="relative">
        <MapPin
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
        />
        <input
          id={id}
          role="combobox"
          aria-expanded={open && visible.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={query}
          placeholder={w.search}
          onFocus={(e) => {
            setOpen(true);
            // Phones: keep the field and its suggestions above the keyboard.
            const field = e.currentTarget;
            setTimeout(() => field.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
          }}
          onBlur={() =>
            setTimeout(() => {
              setOpen(false);
              // Only a chosen city is saved: typed text that wasn't picked goes back.
              setQuery(shown);
            }, 150)
          }
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open && visible[active]) {
              e.preventDefault();
              void pick(visible[active]);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setQuery(shown);
            }
          }}
          className="h-11 w-full rounded-xl border border-border bg-surface pr-10 pl-9 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none md:h-10"
        />
        {(place || legacy) && (
          <button
            type="button"
            aria-label={w.clear}
            onClick={() => {
              setQuery("");
              onChange({ place: null, text: null });
            }}
            className="absolute top-1/2 right-1 grid size-9 -translate-y-1/2 place-items-center rounded-full text-faint hover:text-fg"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {open && searching && (visible.length > 0 || !loading) && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full z-50 mt-1 max-h-64 w-full overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-[var(--overlay-bg)] p-1 shadow-[var(--menu-shadow)]"
        >
          {visible.length === 0 ? (
            <li className="px-3 py-2.5 text-[13px] text-muted">{w.none}</li>
          ) : (
            visible.map((s, i) => (
              <li
                key={s.placeId}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(s)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer flex-col justify-center rounded-lg px-3 py-2 text-sm",
                  i === active && "bg-active",
                )}
              >
                <span className="truncate text-fg">{s.label}</span>
                {s.detail && <span className="truncate text-[12px] text-faint">{s.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
      {!place && legacy && <p className="text-[12.5px] text-faint">{w.legacy}</p>}
    </div>
  );
}
