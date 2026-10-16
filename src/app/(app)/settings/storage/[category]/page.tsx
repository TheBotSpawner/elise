import { notFound } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { storedFilesIn } from "@/application/storage-service";
import { STORAGE_CATEGORIES, type StorageCategory } from "@/core/storage/accounting";
import { SettingsPage } from "@/features/settings/shell";
import { StoredFiles } from "@/features/settings/storage";
import { getT } from "@/lib/i18n/server";

export default async function StorageCategoryPage({
  params,
}: PageProps<"/settings/storage/[category]">) {
  const { category } = await params;
  if (!(STORAGE_CATEGORIES as readonly string[]).includes(category)) notFound();
  const c = category as StorageCategory;
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  return (
    <SettingsPage
      section="storage"
      title={t.settingsHub.storage.categories[c].title}
      back={{ href: "/settings/storage", label: t.settingsHub.sections.storage.title }}
    >
      <StoredFiles files={await storedFilesIn(auth, c)} />
    </SettingsPage>
  );
}
