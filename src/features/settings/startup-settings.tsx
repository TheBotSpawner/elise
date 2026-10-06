"use client";

import { useSyncExternalStore } from "react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setStartupSoundEnabled, startupSoundEnabled } from "@/features/boot/startup-sound";
import { useI18n } from "@/lib/i18n/client";

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** The startup sound (ADR-046): on by default, a per-device choice like other sounds. */
export function StartupSettings() {
  const { t } = useI18n();
  const s = t.settings.startup;
  const on = useSyncExternalStore(subscribe, startupSoundEnabled, () => true);
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-medium">{s.title}</h2>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{s.sound}</p>
          <p className="text-[13px] text-muted">{s.soundHint}</p>
        </div>
        <Switch
          checked={on}
          aria-label={s.sound}
          onCheckedChange={(next) => {
            setStartupSoundEnabled(next);
            listeners.forEach((l) => l());
          }}
        />
      </div>
    </Card>
  );
}
