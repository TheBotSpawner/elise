"use client";

import { useMemo } from "react";

import { Combobox } from "@/components/ui/combobox";
import { canonicalTimezone } from "@/core/time";
import { useI18n } from "@/lib/i18n/client";
import { prefersArgentina, timezoneOptions } from "@/lib/timezones";

/**
 * The one timezone picker (ADR-069): "Buenos Aires, Argentina · UTC-3", searchable by city,
 * country, offset or IANA id; always yields the canonical id. Argentina first for people who
 * likely live there — easier to find, never chosen for them.
 */
export function TimezonePicker({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const current = canonicalTimezone(value);
  const options = useMemo(
    () =>
      timezoneOptions(Intl.supportedValuesOf("timeZone"), new Date(), {
        locale,
        current,
        preferArgentina: prefersArgentina(locale, current),
      }),
    [locale, current],
  );
  return (
    <Combobox
      id={id}
      value={current}
      options={options}
      placeholder={t.settings.timezoneSearch}
      emptyText={t.settings.timezoneNone}
      onChange={(zone) => onChange(canonicalTimezone(zone))}
      className={className}
    />
  );
}
