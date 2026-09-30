"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Input, Label, Select } from "@/components/ui/input";
import { LOCALES, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { ACCENTS, applyAppearance, type Accent, type Theme } from "@/lib/theme";
import { timezoneOptions } from "@/lib/timezones";
import { cn } from "@/lib/utils";

import { setAccent, setTheme, updateProfile } from "./actions";

/** Swatches of the approved accents (the tokens themselves live in globals.css). */
const SWATCHES: Record<Accent, string> = {
  cyan: "#1fb8c8",
  blue: "#4f86e8",
  violet: "#9272e6",
  green: "#2fae6c",
  amber: "#d49a35",
};

export function SettingsForm({
  profile,
  theme,
  accent,
  email,
}: {
  profile: { displayName: string; language: Locale; timezone: string };
  theme: Theme;
  accent: Accent;
  email: string | null;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(profile);
  // Canonical IANA ids stored; friendly, searchable labels shown ("Buenos Aires, Argentina").
  const timezones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    return timezoneOptions(zones.includes(profile.timezone) ? zones : [profile.timezone, ...zones]);
  }, [profile.timezone]);

  function save(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateProfile(values);
      if (result.ok) toast.success(t.settings.saved);
      else toast.error(t.errors.codes[result.error.code]);
    });
  }

  const themeIcons = { system: Monitor, dark: Moon, light: Sun } as const;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="mb-4 font-medium">{t.settings.appearance}</h2>
        <div role="radiogroup" aria-label={t.settings.theme} className="grid grid-cols-3 gap-2">
          {(Object.keys(themeIcons) as Theme[]).map((option) => {
            const Icon = themeIcons[option];
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={theme === option}
                onClick={() => {
                  // Crossfade colour tokens and apply instantly; persist in the background.
                  applyAppearance({ theme: option });
                  startTransition(() => setTheme(option));
                }}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs transition-colors",
                  theme === option
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border text-muted hover:border-border-strong",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {t.settings.themes[option]}
              </button>
            );
          })}
        </div>
        <div
          role="radiogroup"
          aria-label={t.settings.accent}
          className="mt-4 flex flex-wrap items-center gap-3"
        >
          <span className="mr-1 text-xs text-muted">{t.settings.accent}</span>
          {ACCENTS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={accent === option}
              aria-label={t.settings.accents[option]}
              title={t.settings.accents[option]}
              style={{ background: SWATCHES[option] }}
              onClick={() => {
                applyAppearance({ accent: option });
                startTransition(() => setAccent(option));
              }}
              className={cn(
                "size-7 rounded-full border-2 transition-shadow",
                accent === option ? "border-fg" : "border-transparent",
              )}
            />
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 font-medium">{t.settings.profile}</h2>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="displayName">{t.settings.displayName}</Label>
            <Input
              id="displayName"
              value={values.displayName}
              maxLength={120}
              required
              onChange={(e) => setValues({ ...values, displayName: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="language">{t.settings.language}</Label>
            <Select
              id="language"
              value={values.language}
              onChange={(e) => setValues({ ...values, language: e.target.value as Locale })}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {t.settings.languages[l]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">{t.settings.timezone}</Label>
            <Combobox
              id="timezone"
              value={values.timezone}
              options={timezones}
              placeholder={t.settings.timezoneSearch}
              emptyText={t.settings.timezoneNone}
              onChange={(timezone) => setValues({ ...values, timezone })}
            />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {t.settings.save}
            </Button>
          </div>
        </form>
      </Card>

      {email && (
        <Card className="p-5">
          <h2 className="mb-1 font-medium">{t.settings.account}</h2>
          <p className="text-sm text-muted">{email}</p>
        </Card>
      )}
    </div>
  );
}
