"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/**
 * Modal built on the native <dialog> (showModal): the browser traps focus, makes the page inert,
 * closes on Escape and returns focus to the opener. Clicking the backdrop also closes it.
 * Children mount only while open, so each opening starts fresh. On small screens it is a
 * bottom sheet. `busy` blocks dismissal while something is being saved.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  busy = false,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  busy?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // React's autoFocus runs before the dialog is shown, so focus the marked field here.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

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
        "mx-0 mt-auto mb-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-border bg-bg p-0 text-fg shadow-2xl",
        "sm:m-auto sm:max-w-lg sm:rounded-3xl",
        "backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        "opacity-100 transition-[opacity,translate] duration-200 starting:translate-y-2 starting:opacity-0",
        className,
      )}
    >
      {open && (
        <div className="flex flex-col gap-5 px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-7 sm:pt-6 sm:pb-6">
          <header className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h2 id={titleId} className="text-xl font-light tracking-[-0.015em]">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              aria-label={t.common.close}
              className="-mt-1 -mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-active hover:text-fg disabled:opacity-50"
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
