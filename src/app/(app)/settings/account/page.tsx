import { requireAuthContext } from "@/application/auth-context";
import { signOut } from "@/features/auth/actions";
import { LinkRow } from "@/features/settings/general";
import { SettingRow, SettingsCard, SettingsPage } from "@/features/settings/shell";
import { getT } from "@/lib/i18n/server";

/**
 * Account (ADR-068): only what Auth really has — name, email, how the person signs in, and
 * signing out. Security, devices, data export and account deletion aren't built yet, so there
 * are no buttons for them.
 */
export default async function AccountSettingsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const a = t.settingsHub.account;
  const { data } = await auth.db.auth.getUser();
  const user = data.user;
  const providers = [
    ...new Set([
      ...(user?.identities ?? []).map((i) => i.provider),
      ...(typeof user?.app_metadata?.provider === "string" ? [user.app_metadata.provider] : []),
    ]),
  ];
  return (
    <SettingsPage section="account">
      <SettingsCard>
        <SettingRow label={a.name} hint={auth.profile.displayName ?? "—"} />
        <SettingRow id="email" label={a.email} hint={auth.email ?? "—"} />
        <SettingRow
          label={a.signIn}
          hint={providers.map((p) => a.providers[p] ?? p).join(" · ") || "—"}
        />
        <LinkRow
          href="/onboarding?again=1"
          label={t.settingsHub.general.welcome}
          action={t.schedules.open}
        />
        <SettingRow id="sign-out" label={a.signOut}>
          <form action={signOut}>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-full border border-border px-4 text-[13px] text-danger-text hover:border-border-strong"
            >
              {a.signOut}
            </button>
          </form>
        </SettingRow>
      </SettingsCard>
      <p className="px-1 text-[12.5px] text-faint">{a.later}</p>
    </SettingsPage>
  );
}
