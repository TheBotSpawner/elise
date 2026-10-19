"use client";

import { SettingsPage } from "@/features/settings/shell";
import { StoredFiles } from "@/features/settings/storage";
import { useI18n } from "@/lib/i18n/client";

import type { StorageCategoryProps } from "./load";

export function View({ category, files }: StorageCategoryProps) {
  const { t } = useI18n();
  return (
    <SettingsPage
      section="storage"
      title={t.settingsHub.storage.categories[category].title}
      back={{ href: "/settings/storage", label: t.settingsHub.sections.storage.title }}
    >
      <StoredFiles files={files} />
    </SettingsPage>
  );
}
