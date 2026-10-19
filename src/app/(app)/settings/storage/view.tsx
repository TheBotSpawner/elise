"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { formatBytes, STORAGE_CATEGORIES } from "@/core/storage/accounting";
import { SettingsPage } from "@/features/settings/shell";
import { useI18n } from "@/lib/i18n/client";

import type { StorageProps } from "./load";

/** The bar shows what the used bytes are made of — there is no quota to fill. */
const TONE = {
  documents: "bg-accent",
  images: "bg-accent/55",
  attachments: "bg-accent/25",
} as const;

/**
 * Storage (ADR-068): bytes ELISE keeps — never what stays in Drive, Notion or Sheets. No limit
 * is shown because no plan defines one.
 */
export function View({ summary }: StorageProps) {
  const { t, locale } = useI18n();
  const s = t.settingsHub.storage;
  return (
    <SettingsPage section="storage">
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 md:p-6">
        <p className="text-[22px] font-light tracking-[-0.01em]">
          {s.used(formatBytes(summary.bytes, locale))}
        </p>
        {summary.bytes > 0 && (
          <div className="flex h-2 overflow-hidden rounded-full bg-track" aria-hidden>
            {STORAGE_CATEGORIES.map((c) => (
              <span
                key={c}
                className={TONE[c]}
                style={{ width: `${(summary.categories[c].bytes / summary.bytes) * 100}%` }}
              />
            ))}
          </div>
        )}
        <p className="text-[13px] text-muted">
          {s.files(summary.files)} · {s.noLimit}
        </p>
      </section>
      {summary.files === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-[13.5px] text-muted">
          {s.empty}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
          {STORAGE_CATEGORIES.map((c) => (
            <li key={c}>
              <Link
                href={`/settings/storage/${c}`}
                className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-active/50 md:px-5"
              >
                <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${TONE[c]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px]">{s.categories[c].title}</span>
                  <span className="block text-[12.5px] text-muted">
                    {formatBytes(summary.categories[c].bytes, locale)} ·{" "}
                    {s.files(summary.categories[c].files)} · {s.categories[c].hint}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="px-1 text-[12.5px] text-faint">{s.notCounted}</p>
    </SettingsPage>
  );
}
