import { requireAuthContext } from "@/application/auth-context";
import { speechStatus } from "@/application/voice-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { isEnabled } from "@/config/flags";
import { LocationSettings } from "@/features/settings/location-settings";
import { PrivacyCard } from "@/features/settings/privacy-card";
import { SettingsForm } from "@/features/settings/settings-form";
import { StartupSettings } from "@/features/settings/startup-settings";
import { VoiceSettings } from "@/features/settings/voice-settings";
import { getT } from "@/lib/i18n/server";

export default async function SettingsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  return (
    <PageContainer>
      <PageHeader title={t.settings.title} />
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
      <div className="mt-6">
        <VoiceSettings
          initial={auth.profile.voice}
          wakeAllowed={isEnabled("wakePhrase", auth)}
          speech={speechStatus()}
        />
      </div>
      <div className="mt-6">
        <StartupSettings />
      </div>
      <div className="mt-6">
        <LocationSettings />
      </div>
      <div className="mt-6">
        <PrivacyCard t={t} />
      </div>
    </PageContainer>
  );
}
