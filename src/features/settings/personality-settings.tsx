"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { ElisePersonality } from "@/core/personality";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { setPersonalityAction } from "./actions";
import { PersonalityOptions } from "./personality-options";
import { SettingsCard } from "./shell";

/** Settings › Personalidad (ADR-076): the same preference ELISE changes from chat or voice. */
export function PersonalitySettings({ initial }: { initial: ElisePersonality }) {
  const { t } = useI18n();
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  return (
    <SettingsCard title={t.personality.base}>
      <div id="base" className="flex flex-col gap-3 p-4">
        <p className="text-[13px] text-muted">{t.personality.hint}</p>
        <PersonalityOptions
          value={value}
          disabled={pending}
          showSample
          onChange={(p) => {
            const before = value;
            setValue(p);
            startTransition(async () => {
              const r = await setPersonalityAction(p);
              if (!r.ok) {
                setValue(before);
                toast.error(errorText(t, r.error));
              } else router.refresh();
            });
          }}
        />
      </div>
    </SettingsCard>
  );
}
