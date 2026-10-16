import { requireAuthContext } from "@/application/auth-context";
import { isEnabled } from "@/config/flags";
import { SettingsPage } from "@/features/settings/shell";
import { VoiceSettings } from "@/features/settings/voice-settings";
import { availableVoiceKeys } from "@/infrastructure/ai/voices";

export default async function VoiceSettingsPage() {
  const auth = await requireAuthContext();
  const v = auth.profile.voice;
  return (
    <SettingsPage section="voice">
      <VoiceSettings
        initial={{ continuous: v.continuous, language: v.language, voice: v.voice }}
        voices={availableVoiceKeys()}
        wakeAllowed={isEnabled("wakePhrase", auth)}
      />
    </SettingsPage>
  );
}
