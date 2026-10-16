import { requireAuthContext } from "@/application/auth-context";
import { speechStatus } from "@/application/voice-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { isEnabled } from "@/config/flags";
import { LocationSettings } from "@/features/settings/location-settings";
import { PersonalCard } from "@/features/settings/personal-card";
import { PrivacyCard } from "@/features/settings/privacy-card";
import { SettingsForm } from "@/features/settings/settings-form";
import { SettingsGroup } from "@/features/settings/settings-group";
import { StartupSettings } from "@/features/settings/startup-settings";
import { VoiceSettings } from "@/features/settings/voice-settings";
import { getT } from "@/lib/i18n/server";

export default async function SettingsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  return (
    <PageContainer>
      <PageHeader title={t.settings.title} />
      {/* Phones (ADR-066): your ELISE first, then each block as a row that opens in place. */}
      <PersonalCard t={t} />
      <div className="mt-4 md:mt-6">
        <SettingsGroup title={`${t.settings.profile} · ${t.settings.appearance}`}>
          <SettingsForm
            email={auth.email}
            theme={auth.profile.theme}
            accent={auth.profile.accent}
            profile={{
              displayName: auth.profile.displayName ?? "",
              language: auth.profile.locale,
              timezone: auth.profile.timezone,
            }}
          />
        </SettingsGroup>
        <SettingsGroup title={t.voice.settings.title}>
          <VoiceSettings
            initial={auth.profile.voice}
            wakeAllowed={isEnabled("wakePhrase", auth)}
            speech={speechStatus()}
          />
        </SettingsGroup>
        <SettingsGroup title={t.settings.startup.title}>
          <StartupSettings />
        </SettingsGroup>
        <SettingsGroup title={t.settings.location.title}>
          <LocationSettings />
        </SettingsGroup>
        <SettingsGroup title={t.settings.privacy.title}>
          <PrivacyCard t={t} />
        </SettingsGroup>
      </div>
    </PageContainer>
  );
}
