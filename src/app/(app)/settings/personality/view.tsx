"use client";

import { PersonalitySettings } from "@/features/settings/personality-settings";
import { SettingsPage } from "@/features/settings/shell";

import type { PersonalityProps } from "./load";

export function View({ personality }: PersonalityProps) {
  return (
    <SettingsPage section="personality">
      <PersonalitySettings initial={personality} />
    </SettingsPage>
  );
}
