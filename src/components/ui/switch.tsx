"use client";

import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Accessible on/off switch. 40 × 24 track, 18 px thumb kept inside the track in both states. */
export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[var(--dur-xs)] disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-2",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-[2px] size-[18px] rounded-full shadow-sm transition-transform duration-[var(--dur-sm)] ease-[var(--ease-standard)]",
          checked ? "translate-x-4 bg-[var(--on-accent)]" : "translate-x-0 bg-muted",
        )}
      />
    </button>
  );
}
