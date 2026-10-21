"use client";

import { MemorySettings } from "@/features/settings/memory";
import { SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

import type { MemoryProps } from "./load";

export function View({ state, conversations, recent }: MemoryProps) {
  const { t } = useI18n();
  return (
    <SettingsPage section="memory" info={t.settingsHub.memory.info}>
      <MemorySettings state={state} conversations={conversations} recent={recent} />
    </SettingsPage>
  );
}
