"use client";

import { ChevronRight } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * One History folder (a Space, a Section, "Sin Espacio"): a quiet row that opens to show what
 * is inside. Which folders are open is remembered on this device only (localStorage), so
 * coming back to History doesn't mean re-opening the same folders.
 */

const KEY = "elise.history.open";
const listeners = new Set<() => void>();

function read(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function toggle(id: string) {
  let open: string[] = [];
  try {
    open = JSON.parse(read()) as string[];
  } catch {
    // A corrupted value starts over.
  }
  const next = open.includes(id) ? open.filter((x) => x !== id) : [...open, id].slice(-60);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the folder still opens, just isn't remembered.
  }
  listeners.forEach((l) => l());
}

function isOpen(id: string): boolean {
  try {
    return (JSON.parse(read()) as string[]).includes(id);
  } catch {
    return false;
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function HistoryFolder({
  id,
  label,
  count,
  meta,
  nested = false,
  children,
}: {
  id: string;
  label: string;
  count: number;
  /** Shown while closed: "3 secciones · hoy". */
  meta?: string;
  nested?: boolean;
  children: React.ReactNode;
}) {
  const open = useSyncExternalStore(
    subscribe,
    () => isOpen(id),
    () => false,
  );
  return (
    <section className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(id)}
        className={cn(
          "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-2.5 text-left transition-colors hover:bg-surface-2",
          nested ? "py-1.5" : "py-2",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-faint transition-transform duration-[var(--dur-sm)] motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate",
              nested ? "text-[14px] text-fg2" : "text-[15px] font-medium",
            )}
          >
            {label}
          </span>
          {meta && !open && <span className="block truncate text-[12px] text-faint">{meta}</span>}
        </span>
        <span className="shrink-0 font-mono text-[12px] text-faint">{count}</span>
      </button>
      {open && (
        <div className={cn("mt-1 mb-2 ml-[18px] min-w-0 border-l border-border pl-2.5 sm:pl-3.5")}>
          {children}
        </div>
      )}
    </section>
  );
}
