"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { Dialog } from "./dialog";

/**
 * Secondary and destructive actions (ADR-066): one "⋯" that opens an anchored menu where there
 * is room (pointer, from `md`) and an action sheet on phones — large rows within thumb reach,
 * destructive actions last and in red.
 */
export interface MenuAction {
  label: string;
  onClick?: () => void;
  href?: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
}

const compact = () =>
  typeof window !== "undefined" && !window.matchMedia("(min-width: 768px)").matches;

/** Destructive actions go last. */
const ordered = (items: readonly MenuAction[]) => [
  ...items.filter((i) => !i.danger),
  ...items.filter((i) => i.danger),
];

export function ActionSheet({
  open,
  onClose,
  title,
  items,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: readonly MenuAction[];
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <ul role="menu" aria-label={title} className="-mx-2 -mt-2 flex flex-col">
        {ordered(items).map((i) => (
          <li key={i.label} role="none">
            <SheetRow item={i} onDone={onClose} className="h-13 rounded-2xl px-3 text-[16px]" />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function SheetRow({
  item,
  onDone,
  className,
}: {
  item: MenuAction;
  onDone: () => void;
  className: string;
}) {
  const body = (
    <>
      {item.icon && <item.icon className="size-[18px] shrink-0 opacity-80" aria-hidden />}
      <span className="truncate">{item.label}</span>
    </>
  );
  const cls = cn(
    "flex w-full items-center gap-3 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-50",
    item.danger ? "text-danger-text" : "text-fg",
    className,
  );
  return item.href ? (
    <Link href={item.href} role="menuitem" onClick={onDone} className={cls}>
      {body}
    </Link>
  ) : (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={() => {
        onDone();
        item.onClick?.();
      }}
      className={cls}
    >
      {body}
    </button>
  );
}

export function OverflowMenu({
  label,
  items,
  trigger,
  className,
}: {
  /** Accessible name of the trigger, and the sheet's title on phones. */
  label: string;
  items: readonly MenuAction[];
  /** A custom trigger's content; default "⋯". */
  trigger?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState<"menu" | "sheet" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open !== "menu") return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      )
        setOpen(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  if (!items.length) return null;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-label={label}
        onClick={() => setOpen(open ? null : compact() ? "sheet" : "menu")}
        className={cn(
          "grid size-11 place-items-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg md:size-9",
          className,
        )}
      >
        {trigger ?? <MoreHorizontal className="size-[18px]" aria-hidden />}
      </button>
      {open === "menu" && (
        <div
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-40 mt-1 flex w-56 flex-col rounded-2xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
        >
          {ordered(items).map((i) => (
            <SheetRow
              key={i.label}
              item={i}
              onDone={() => setOpen(null)}
              className="rounded-xl px-3 py-2 text-[13.5px]"
            />
          ))}
        </div>
      )}
      <ActionSheet
        open={open === "sheet"}
        onClose={() => setOpen(null)}
        title={label}
        items={items}
      />
    </div>
  );
}

/** "Filtros · 2": opens the filter sheet; the count says how many are on. */
export function FilterButton({
  count,
  onClick,
  className,
}: {
  count: number;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className={cn(
        "inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-4 text-[14px] transition-colors md:h-9 md:text-[13px]",
        count
          ? "border-accent/50 bg-accent-soft text-accent-text"
          : "border-border text-muted hover:text-fg",
        className,
      )}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor">
        <path d="M2 4h12M4.5 8h7M7 12h2" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {t.common.filtersCount(count)}
    </button>
  );
}

/**
 * Filters in one sheet (ADR-066): full-width rows, "Limpiar" and "Aplicar" at the bottom. On
 * phones the controls never sit stacked above the content.
 */
export function FilterSheet({
  open,
  onClose,
  onClear,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t.common.filters}>
      <div className="flex flex-col gap-4 [&_select]:h-12 [&_select]:w-full md:[&_select]:h-10">
        {children}
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onClear}
          className="h-12 flex-1 rounded-full border border-border text-[15px] text-muted hover:text-fg"
        >
          {t.common.clearFilters}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-12 flex-1 rounded-full bg-fg text-[15px] font-medium text-bg"
        >
          {t.common.applyFilters}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * A row of chips or tabs that scrolls sideways on phones, edge to edge, without a scrollbar
 * (ADR-066); wraps or sits inline from `md` when `wrapFrom="md"`.
 */
export function ChipRail({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role={label ? "group" : undefined}
      aria-label={label}
      className={cn(
        "-mx-4 no-scrollbar flex snap-x gap-2 overflow-x-auto px-4 md:mx-0 md:px-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
