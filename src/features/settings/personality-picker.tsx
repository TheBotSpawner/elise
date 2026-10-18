"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { setPersonalityAction } from "./actions";
import { PersonalityOptions } from "./personality-options";

/**
 * "Cambiá tu personalidad" with no target (ADR-076): the five choices in the chat. Picking one
 * saves the same preference as Settings › Personalidad, from the next reply on.
 */
export function PersonalityPicker({ p }: { p: SurfacePayloads["personality"] }) {
  const { t } = useI18n();
  const router = useRouter();
  const [value, setValue] = useState(p.current);
  const [pending, startTransition] = useTransition();
  return (
    <PersonalityOptions
      name="personality-chat"
      value={value}
      disabled={pending}
      onChange={(next) => {
        const before = value;
        setValue(next);
        startTransition(async () => {
          const r = await setPersonalityAction(next);
          if (!r.ok) {
            setValue(before);
            return void toast.error(errorText(t, r.error));
          }
          toast.success(t.personality.saved);
          router.refresh();
        });
      }}
    />
  );
}
