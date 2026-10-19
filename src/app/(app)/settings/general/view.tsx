"use client";

import { DateOrderRow, LinkRow, LocationRow, ProfileSettings } from "@/features/settings/general";
import { SettingsCard, SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

import type { GeneralProps } from "./load";

/**
 * General (ADR-068): what applies to all of ELISE — profile, interface language, time zone,
 * location, and the way to Mi ELISE's modules (the existing configurator in Connections).
 * Rendered by /settings/general and, on wide screens, by /settings itself.
 */
export function View({ profile }: GeneralProps) {
  const { t } = useI18n();
  const g = t.settingsHub.general;
  return (
    <SettingsPage section="general">
      <ProfileSettings profile={profile} />
      <SettingsCard>
        <DateOrderRow />
        <LocationRow />
        <LinkRow
          id="my-elise"
          href="/connections#mi-elise"
          label={g.myElise}
          hint={g.myEliseHint}
          action={g.manage}
        />
      </SettingsCard>
    </SettingsPage>
  );
}
