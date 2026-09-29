"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { LOCALES, type Locale } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { setTheme, updateProfile } from "./actions";

export function SettingsForm({
  profile,
  theme,
  email,
}: {
  profile: { displayName: string; language: Locale; timezone: string };
  theme: Theme;
  email: string | null;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState(profile);
  const timezones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);

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
                onClick={() => startTransition(() => setTheme(option))}
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
            <Select
              id="timezone"
              value={values.timezone}
              onChange={(e) => setValues({ ...values, timezone: e.target.value })}
            >
              {[values.timezone, ...timezones.filter((z) => z !== values.timezone)].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
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
