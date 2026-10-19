"use client";

import { AppearanceSettings } from "@/features/settings/appearance";
import { SettingsPage } from "@/features/settings/shell";

import type { AppearanceProps } from "./load";

export function View({ theme, accent }: AppearanceProps) {
  return (
    <SettingsPage section="appearance">
      <AppearanceSettings theme={theme} accent={accent} />
    </SettingsPage>
  );
}
