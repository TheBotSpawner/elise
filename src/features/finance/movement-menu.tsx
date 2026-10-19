"use client";

import { CheckSquare, Copy, Pencil, Square, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/**
 * Long press on touch (ADR-083): hold still for half a second and the movement is selected.
 * Moving the finger (scrolling) cancels it, and the tap that ends a long press never also opens
 * the movement. Mouse and keyboard keep their own paths (right-click menu, "Seleccionar").
 */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const touch = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: PointerEvent) => {
      touch.current = e.pointerType !== "mouse";
      fired.current = false;
      if (!touch.current) return;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    /** True once: swallow the click that ends a long press. */
    consumeClick: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
    /** Touch long-press also raises contextmenu on Android: that one is ours, not the browser's. */
    isTouch: () => touch.current,
  };
}

export interface MovementMenuState {
  x: number;
  y: number;
  selected: boolean;
  editable: boolean;
}

/**
 * ELISE's own context menu for a movement (desktop right-click): Seleccionar / Quitar de la
 * selección, Editar, Duplicar, Eliminar. Keyboard: arrows move, Escape closes, focus returns to the row.
 * The same actions stay reachable without it (the movement's detail, the "Seleccionar" button).
 */
export function MovementMenu({
  state,
  onClose,
  onToggleSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  state: MovementMenuState | null;
  onClose: () => void;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const b = t.finance.bulk;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(state.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - r.height - 8)),
    });
    ref.current.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const outside = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [state, onClose]);

  if (!state) return null;
  const items = [
    {
      label: state.selected ? b.menuDeselect : b.menuSelect,
      Icon: state.selected ? Square : CheckSquare,
      run: onToggleSelect,
      show: state.editable,
    },
    { label: b.menuEdit, Icon: Pencil, run: onEdit, show: state.editable },
    { label: t.finance.v21.detail.duplicate, Icon: Copy, run: onDuplicate, show: true },
    { label: b.menuDelete, Icon: Trash2, run: onDelete, show: state.editable, danger: true },
  ].filter((i) => i.show);
  if (!items.length) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={b.menuLabel}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const all = [
          ...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []),
        ];
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        all[(at + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      }}
      style={pos ?? { left: state.x, top: state.y, visibility: "hidden" }}
      className="fixed z-50 min-w-48 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] p-1.5 shadow-2xl backdrop-blur-xl"
    >
      {items.map(({ label, Icon, run, danger }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            run();
          }}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-active focus-visible:bg-active focus-visible:outline-none",
            danger && "text-danger-text",
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
