"use client";

import { Check, ChevronDown, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { spaceColor } from "@/core/knowledge/appearance";
import type { ActiveContext } from "@/core/workspace/model";
import { SPACE_HEX } from "@/features/knowledge/appearance";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export type ContextOption = Omit<ActiveContext, "turn">;

/**
 * The interaction's active context (ADR-016 §6): a small pill, never a header. Click to
 * switch to another context or clear it; managing contexts lives under My Elise.
 */
export function ContextIndicator({
  context,
  options,
  onChange,
  disabled,
}: {
  context: ContextOption;
  options: ContextOption[];
  onChange: (next: ContextOption | null) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  const dot = (accent: string | null) => SPACE_HEX[spaceColor(accent)];
  const c = t.workspace.context;
  return (
    <div ref={root} className="pointer-events-auto relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${c.label}: ${context.name}. ${c.switch}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 max-w-[260px] items-center gap-2 rounded-full border border-border bg-[var(--menu-bg)] px-3 text-[13px] backdrop-blur transition-colors hover:border-border-strong disabled:opacity-60"
      >
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot(context.accent) }}
        />
        <span className="truncate">{context.name}</span>
        <span className="shrink-0 text-faint">{c.kinds[context.kind]}</span>
        <ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-40 mb-2 flex w-64 flex-col overflow-hidden rounded-2xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
        >
          <p className="px-3 pt-2 pb-1 type-label text-faint">{c.switch}</p>
          <ul className="max-h-64 overflow-y-auto">
            {options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    if (o.id !== context.id) onChange(o);
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13.5px] hover:bg-surface-2"
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: dot(o.accent) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{o.name}</span>
                  <span className="text-[12px] text-faint">{c.kinds[o.kind]}</span>
                  {o.id === context.id && (
                    <Check className="size-3.5 text-accent-text" aria-hidden />
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex flex-col border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChange(null);
              }}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-2 text-left text-[13.5px] text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <X className="size-3.5" aria-hidden />
              {c.clear}
            </button>
            <Link
              href="/my-elise/contexts"
              role="menuitem"
              className="rounded-xl px-3 py-2 text-[13px] text-accent-text hover:bg-surface-2"
            >
              {c.manage}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
