"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { nativeActionAction } from "./actions";

/** Runs a native capability tool from the UI (same path as Chat) and refreshes the view. */
export function useNative() {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const act = (tool: string, args: unknown, onDone?: () => void) =>
    startTransition(async () => {
      const r = await nativeActionAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        onDone?.();
        router.refresh();
      }
    });
  return { act, pending };
}
