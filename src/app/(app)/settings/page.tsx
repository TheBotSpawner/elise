import { cookies } from "next/headers";

import { requireAuthContext } from "@/application/auth-context";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SettingsForm } from "@/features/settings/settings-form";
import { getT } from "@/lib/i18n/server";
import { isTheme, THEME_COOKIE } from "@/lib/theme";

export default async function SettingsPage() {
  const [auth, { t }, cookieStore] = await Promise.all([requireAuthContext(), getT(), cookies()]);
  const stored = cookieStore.get(THEME_COOKIE)?.value;
  return (
    <PageContainer>
      <PageHeader title={t.settings.title} />
      <SettingsForm
        email={auth.email}
        theme={isTheme(stored) ? stored : "system"}
        profile={{
          displayName: auth.profile.displayName ?? "",
          language: auth.profile.locale,
          timezone: auth.profile.timezone,
        }}
      />
    </PageContainer>
  );
}
