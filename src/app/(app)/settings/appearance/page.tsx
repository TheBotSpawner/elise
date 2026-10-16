import { requireAuthContext } from "@/application/auth-context";
import { AppearanceSettings } from "@/features/settings/appearance";
import { SettingsPage } from "@/features/settings/shell";

export default async function AppearanceSettingsPage() {
  const auth = await requireAuthContext();
  return (
    <SettingsPage section="appearance">
      <AppearanceSettings theme={auth.profile.theme} accent={auth.profile.accent} />
    </SettingsPage>
  );
}
