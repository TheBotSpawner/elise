"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type PointerEvent, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * Modal built on the native <dialog> (showModal): the browser traps focus, makes the page inert,
 * closes on Escape and returns focus to the opener. Clicking the backdrop also closes it.
 * Children mount only while open, so each opening starts fresh. `busy` blocks dismissal while
 * something is being saved.
 *
 * On phones (ADR-066) it is a bottom sheet with a drag handle — pull it down to dismiss — sized
 * to its content. `size="form"` is for editors: full screen on phones, with "Cancelar" and the
 * title in a header that stays put, the fields scrolling under it, and the form's own action row
 * (marked `data-sheet-actions`) kept at the bottom, above the home indicator. From `sm` up both
 * are a centered dialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  busy = false,
  size = "default",
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  busy?: boolean;
  size?: "default" | "form";
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const form = size === "form";

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.style.translate = "";
      dialog.showModal();
      // React's autoFocus runs before the dialog is shown, so focus the marked field here.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Swipe down on the handle (phones): follows the finger, dismisses past 96px.
  const onPointerDown = (e: PointerEvent) => {
    if (busy || e.pointerType === "mouse") return;
    drag.current = { y: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current || !ref.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    ref.current.style.transition = "none";
    ref.current.style.translate = `0 ${drag.current.dy}px`;
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !ref.current) return;
    ref.current.style.transition = "";
    if (d.dy > 96) onClose();
    else ref.current.style.translate = "";
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      onMouseDown={(e) => {
        // A press on the <dialog> itself (not its content) is a press on the backdrop.
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      className={cn(
        "mx-0 mb-0 w-full max-w-none overflow-y-auto overscroll-contain border-border bg-bg p-0 text-fg shadow-2xl",
        form
          ? "mt-0 h-dvh max-h-none border-0 max-sm:rounded-none"
          : "mt-auto max-h-[92dvh] rounded-t-3xl border",
        "sm:m-auto sm:h-auto sm:max-h-[92dvh] sm:max-w-lg sm:rounded-3xl sm:border",
        "backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        "opacity-100 transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0",
        className,
      )}
    >
      {open && (
        <div
          className={cn(
            "flex flex-col gap-5 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-7 sm:pt-6 sm:pb-6",
            form ? "min-h-full pt-[env(safe-area-inset-top)] sm:min-h-0" : "pt-2",
          )}
          data-sheet={form ? "form" : "default"}
        >
          {!form && (
            <div
              aria-hidden
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="-mx-5 -mb-3 flex h-6 touch-none items-center justify-center sm:hidden"
            >
              <span className="h-1 w-9 rounded-full bg-border-strong" />
            </div>
          )}
          <header
            className={cn(
              "flex items-start justify-between gap-4",
              // Phones, form: the header stays while the fields scroll.
              form &&
                "max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:-mx-5 max-sm:items-center max-sm:border-b max-sm:border-border max-sm:bg-bg/95 max-sm:px-3 max-sm:py-2 max-sm:backdrop-blur-md",
            )}
          >
            {form && (
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="h-11 shrink-0 rounded-full px-2 text-[15px] text-muted hover:text-fg disabled:opacity-50 sm:hidden"
              >
                {t.common.cancel}
              </button>
            )}
            <div
              className={cn(
                "flex min-w-0 flex-col gap-1",
                form && "max-sm:flex-1 max-sm:items-center max-sm:text-center",
              )}
            >
              <h2
                id={titleId}
                className={cn(
                  "text-xl font-light tracking-[-0.015em]",
                  form && "max-sm:truncate max-sm:text-[17px] max-sm:font-normal",
                )}
              >
                {title}
              </h2>
              {description && (
                <p
                  id={descriptionId}
                  className={cn("text-sm text-muted", form && "max-sm:sr-only")}
                >
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={t.common.close}
              className={cn(
                "-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-active hover:text-fg disabled:opacity-50",
                // Phones, form: "Cancelar" closes; this slot only balances the title.
                form && "max-sm:invisible",
              )}
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          {children}
        </div>
      )}
    </dialog>
  );
}
