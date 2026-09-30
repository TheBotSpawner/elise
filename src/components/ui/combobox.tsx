"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary line ("America/Argentina · GMT-3"). */
  detail?: string;
  /** Extra words the search matches ("Argentina", the raw id). */
  keywords?: string;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const MAX_SHOWN = 80;

/**
 * Searchable single select (WAI-ARIA combobox + listbox). Typing filters; ↑/↓ move, Enter
 * picks, Escape closes and restores the selection. For long lists (timezones) where a native
 * select would be hundreds of rows.
 */
export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  emptyText,
  className,
}: {
  id?: string;
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText: string;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const matches = useMemo(() => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return options.slice(0, MAX_SHOWN);
    return options
      .filter((o) => {
        const hay = norm(`${o.label} ${o.detail ?? ""} ${o.keywords ?? ""}`);
        return words.every((w) => hay.includes(w));
      })
      .slice(0, MAX_SHOWN);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function pick(option: ComboboxOption) {
    onChange(option.value);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={root} className={cn("relative", className)}>
      <div className="relative">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={open ? query : (selected?.label ?? "")}
          placeholder={open ? (selected?.label ?? placeholder) : placeholder}
          onFocus={() => {
            setOpen(true);
            setActive(
              Math.max(
                0,
                matches.findIndex((m) => m.value === value),
              ),
            );
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open) {
              e.preventDefault();
              if (matches[active]) pick(matches[active]);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              setQuery("");
            } else if (e.key === "Tab") setOpen(false);
          }}
          className="h-10 w-full rounded-xl border border-border bg-surface pr-9 pl-3 text-sm text-fg transition-colors placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
        />
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
      </div>
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1.5 max-h-72 w-full overflow-y-auto rounded-xl border border-border-strong bg-[var(--overlay-bg)] p-1 shadow-[var(--menu-shadow)]"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-muted">{emptyText}</li>
          ) : (
            matches.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm text-fg",
                  i === active && "bg-active",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.detail && (
                    <span className="block truncate text-[12px] text-faint">{o.detail}</span>
                  )}
                </span>
                {o.value === value && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
