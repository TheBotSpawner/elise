import { requireAuthContext } from "@/application/auth-context";
import { getT } from "@/lib/i18n/server";

import { LinkRow, LocationRow, ProfileSettings } from "./general";
import { SettingsCard, SettingsPage } from "./shell";

/**
 * General (ADR-068): what applies to all of ELISE — profile, interface language, time zone,
 * location, and the way to Mi ELISE's modules (the existing configurator in Connections).
 * Rendered by /settings/general and, on wide screens, by /settings itself.
 */
export async function GeneralSection() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const g = t.settingsHub.general;
  return (
    <SettingsPage section="general">
      <ProfileSettings
        profile={{
          displayName: auth.profile.displayName ?? "",
          language: auth.profile.locale,
          timezone: auth.profile.timezone,
        }}
      />
      <SettingsCard>
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
