"use client";

import { formatBytes } from "@/core/storage/accounting";
import { SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

import type { UsageProps } from "./load";

/** Usage (ADR-068): real counts for this month only — no limits, credits or costs. */
export function View({ usage }: UsageProps) {
  const { t, locale } = useI18n();
  const u = t.settingsHub.usage;
  const num = new Intl.NumberFormat(locale);
  const minutes = (s: number) => {
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  };
  const show = (v: number | null, f: (x: number) => string) => (v === null ? "—" : f(v));
  const rows = [
    { label: u.conversations, value: show(usage.conversations, (n) => num.format(n)) },
    { label: u.messages, value: show(usage.messages, (n) => num.format(n)) },
    { label: u.voice, value: show(usage.voiceSeconds, minutes) },
    { label: u.scheduled, value: show(usage.scheduledRuns, (n) => u.runs(n)) },
    { label: u.storage, value: show(usage.storageBytes, (b) => formatBytes(b, locale)) },
  ];
  const since = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${usage.since}T12:00:00Z`));
  return (
    <SettingsPage section="usage">
      <section className="flex flex-col gap-2">
        <h2 className="px-1 type-label text-faint">{u.since(since)}</h2>
        <dl className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-baseline justify-between gap-4 px-4 py-3.5 md:px-5"
            >
              <dt className="text-[14.5px]">{r.label}</dt>
              <dd className="font-mono text-[14px] text-fg2">{r.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="px-1 text-[12.5px] text-faint">{u.noLimits}</p>
    </SettingsPage>
  );
}
