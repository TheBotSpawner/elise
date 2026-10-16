import { requireAuthContext } from "@/application/auth-context";
import { speechStatus } from "@/application/voice-service";
import { isEnabled } from "@/config/flags";
import { SettingsPage } from "@/features/settings/shell";
import { VoiceSettings } from "@/features/settings/voice-settings";

export default async function VoiceSettingsPage() {
  const auth = await requireAuthContext();
  const v = auth.profile.voice;
  return (
    <SettingsPage section="voice">
      <VoiceSettings
        initial={{ continuous: v.continuous, language: v.language, voice: v.voice }}
        profiles={speechStatus().profiles}
        wakeAllowed={isEnabled("wakePhrase", auth)}
      />
    </SettingsPage>
  );
}
