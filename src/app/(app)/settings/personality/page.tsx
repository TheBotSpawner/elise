import { requireAuthContext } from "@/application/auth-context";
import { PersonalitySettings } from "@/features/settings/personality-settings";
import { SettingsPage } from "@/features/settings/shell";

export default async function PersonalitySettingsPage() {
  const auth = await requireAuthContext();
  return (
    <SettingsPage section="personality">
      <PersonalitySettings initial={auth.profile.personality} />
    </SettingsPage>
  );
}
