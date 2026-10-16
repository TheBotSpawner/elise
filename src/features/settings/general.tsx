"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  enableDeviceLocation,
  setDeviceLocationEnabled,
  useDeviceLocation,
} from "@/features/location/shared-location";
import { LOCALES, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { timezoneOptions } from "@/lib/timezones";

import { updateProfile } from "./actions";
import { SettingRow, SettingsCard } from "./shell";

/** General (ADR-068): name, interface language and time zone — saved together, audited. */
export function ProfileSettings({
  profile,
}: {
  profile: { displayName: string; language: Locale; timezone: string };
}) {
  const { t } = useI18n();
  const g = t.settingsHub.general;
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(profile);
  // Canonical IANA ids stored; friendly, searchable labels shown ("Buenos Aires, Argentina").
  const timezones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return timezoneOptions(zones.includes(profile.timezone) ? zones : [profile.timezone, ...zones]);
  }, [profile.timezone]);
  const dirty = JSON.stringify(values) !== JSON.stringify(profile);

  function save(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateProfile(values);
      if (result.ok) toast.success(t.settings.saved);
      else toast.error(t.errors.codes[result.error.code]);
    });
  }

  return (
    <form onSubmit={save}>
      <SettingsCard title={g.profile}>
        <SettingRow id="name" label={g.name} stack>
          <Input
            id="displayName"
            aria-label={g.name}
            value={values.displayName}
            maxLength={120}
            required
            onChange={(e) => setValues({ ...values, displayName: e.target.value })}
            className="sm:w-72"
          />
        </SettingRow>
        <SettingRow id="language" label={g.language} hint={g.languageHint} stack>
          <Select
            id="language"
            aria-label={g.language}
            value={values.language}
            onChange={(e) => setValues({ ...values, language: e.target.value as Locale })}
            className="sm:w-72"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t.settings.languages[l]}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow id="timezone" label={g.timezone} hint={g.timezoneHint} stack>
          <div className="sm:w-72">
            <Combobox
              id="timezone"
              value={values.timezone}
              options={timezones}
              placeholder={t.settings.timezoneSearch}
              emptyText={t.settings.timezoneNone}
              onChange={(timezone) => setValues({ ...values, timezone })}
            />
          </div>
        </SettingRow>
        <div className="flex justify-end px-4 py-3 md:px-5">
          <Button type="submit" size="sm" disabled={pending || !dirty}>
            {g.save}
          </Button>
        </div>
      </SettingsCard>
    </form>
  );
}

/**
 * Location (ADR-028): a per-device opt-in — the browser keeps the permission; ELISE keeps no
 * position and never tracks in the background.
 */
export function LocationRow() {
  const { t } = useI18n();
  const s = t.settings.location;
  const { enabled, status, accuracy } = useDeviceLocation();
  const [asking, setAsking] = useState(false);
  const blocked = status === "blocked";
  const unavailable = status === "unavailable";

  async function toggle(on: boolean) {
    if (!on) return setDeviceLocationEnabled(false);
    setAsking(true);
    await enableDeviceLocation();
    setAsking(false);
  }

  const state = unavailable
    ? s.unavailable
    : blocked
      ? `${s.blocked}. ${s.blockedHint}`
      : status === "allowed"
        ? `${s.allowed}${enabled && accuracy !== null ? ` · ${s.accuracy(accuracy)}` : ""}`
        : status === "needs_permission"
          ? s.needsPermission
          : "";
  return (
    <SettingRow id="location" label={s.use} hint={state || undefined} info={[s.useHint]}>
      <Switch
        checked={enabled && !blocked && !unavailable}
        disabled={asking || blocked || unavailable}
        aria-label={s.use}
        onCheckedChange={(on) => void toggle(on)}
      />
    </SettingRow>
  );
}

/** A row that opens another place (Mi ELISE's modules, the welcome). */
export function LinkRow({
  id,
  href,
  label,
  hint,
  action,
}: {
  id?: string;
  href: string;
  label: string;
  hint?: string;
  action: string;
}) {
  return (
    <SettingRow id={id} label={label} hint={hint}>
      <Link
        href={href}
        className="inline-flex h-9 items-center gap-1 rounded-full border border-border px-3.5 text-[13px] text-fg2 hover:border-border-strong hover:text-fg"
      >
        {action}
        <ChevronRight className="size-3.5" aria-hidden />
      </Link>
    </SettingRow>
  );
}
