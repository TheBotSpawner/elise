"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** Small pieces shared by the My Elise workspaces (Habits, Goals). */

export function IconTile({
  icon,
  size = "md",
}: {
  icon: string | null;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-xl bg-surface-2",
        size === "sm" && "size-7 text-[15px]",
        size === "md" && "size-9 text-[18px]",
        size === "lg" && "size-12 text-[24px]",
      )}
    >
      {icon ?? <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  );
}

export function Bar({ value, flag = false }: { value: number | null; flag?: boolean }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
      <span
        className={cn(
          "block h-full rounded-full transition-[width] duration-300",
          flag ? "bg-approval" : "bg-accent",
        )}
        style={{ width: `${Math.round((value ?? 0) * 100)}%` }}
      />
    </span>
  );
}

export function Menu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onClick: () => void; danger?: boolean }[];
}) {
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
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen(!open)}
        className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-1 flex w-52 flex-col rounded-2xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
        >
          {items.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={cn(
                "flex w-full rounded-xl px-3 py-2 text-left text-[13.5px] hover:bg-surface-2",
                i.danger && "hover:text-danger-text",
              )}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
