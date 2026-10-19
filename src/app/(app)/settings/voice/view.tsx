"use client";

import { SettingsPage } from "@/features/settings/shell";
import { VoiceSettings } from "@/features/settings/voice-settings";

import type { VoiceProps } from "./load";

export function View({ initial, voices, wakeAllowed }: VoiceProps) {
  return (
    <SettingsPage section="voice">
      <VoiceSettings initial={initial} voices={voices} wakeAllowed={wakeAllowed} />
    </SettingsPage>
  );
}
