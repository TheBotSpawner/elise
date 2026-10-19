"use client";

import { signOut } from "@/features/auth/actions";
import { LinkRow } from "@/features/settings/general";
import { SettingRow, SettingsCard, SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

import type { AccountProps } from "./load";

/**
 * Account (ADR-068): only what Auth really has — name, email, how the person signs in, and
 * signing out. Security, devices, data export and account deletion aren't built yet, so there
 * are no buttons for them.
 */
export function View({ displayName, email, providers }: AccountProps) {
  const { t } = useI18n();
  const a = t.settingsHub.account;
  return (
    <SettingsPage section="account">
      <SettingsCard>
        <SettingRow label={a.name} hint={displayName ?? "—"} />
        <SettingRow id="email" label={a.email} hint={email ?? "—"} />
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
