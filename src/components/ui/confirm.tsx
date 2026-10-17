"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { useI18n } from "@/lib/i18n/client";

import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * ELISE's own confirmation (ADR-075): never the browser's `confirm()`. `useConfirm()` returns a
 * function that opens one shared dialog (a bottom sheet on phones) and resolves to the answer:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: "Eliminar “Regalos”", body: "…", destructive: true }))) return;
 */
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Deleting, disconnecting, discarding: the confirm button says so in danger style. */
  destructive?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const answer = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog open={options !== null} onClose={() => answer(false)} title={options?.title ?? ""}>
        {options?.body && (
          <div className="text-[14px] leading-[1.55] text-muted">{options.body}</div>
        )}
        <div className="flex flex-wrap justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>button]:w-full">
          <Button type="button" variant="secondary" onClick={() => answer(false)}>
            {options?.cancelLabel ?? t.common.cancel}
          </Button>
          <Button
            type="button"
            data-autofocus
            variant={options?.destructive ? "danger" : "primary"}
            onClick={() => answer(true)}
          >
            {options?.confirmLabel ?? t.common.confirm}
          </Button>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** The confirmation function; outside a provider it falls back to "no" (never the browser's). */
export function useConfirm(): Ask {
  return useContext(ConfirmContext) ?? (async () => false);
}
