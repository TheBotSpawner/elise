"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { completionFeedback, primeCompletionSound } from "@/features/feedback/completion";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { nativeActionAction } from "./actions";

/** Runs a native capability tool from the UI (same path as Chat) and refreshes the view. */
export function useNative() {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const act = (tool: string, args: unknown, onDone?: () => void) => {
    // A goal completed by the user (ADR-072): felt once the server confirms it.
    const goal = tool === "goals.complete" ? (args as { goal?: unknown } | null)?.goal : undefined;
    if (typeof goal === "string") primeCompletionSound();
    startTransition(async () => {
      const r = await nativeActionAction(tool, args);
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        if (typeof goal === "string")
          completionFeedback({
            kind: "goal",
            key: `goal:${goal}`,
            element: document.querySelector(`[data-goal-ring="${CSS.escape(goal)}"]`),
          });
        onDone?.();
        router.refresh();
      }
    });
  };
  return { act, pending };
}
