"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A Settings block (ADR-066). On phones it is one row — tap to open it in place — so the page
 * reads as a short grouped list instead of a long form. From `md` it is always open, as before.
 */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="max-md:border-b max-md:border-border md:mt-6 md:first:mt-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-14 w-full items-center justify-between gap-3 text-left text-[16px] md:hidden"
      >
        {title}
        <ChevronRight
          className={cn("size-4 text-faint transition-transform", open && "rotate-90")}
          aria-hidden
        />
      </button>
      <div id={id} className={cn(!open && "max-md:hidden", "max-md:pb-4")}>
        {children}
      </div>
    </section>
  );
}
