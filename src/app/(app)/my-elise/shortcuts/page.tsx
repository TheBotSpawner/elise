import { requireAuthContext } from "@/application/auth-context";
import { contextOptions } from "@/application/contexts-service";
import { shortcutStore } from "@/application/shortcuts-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ShortcutsView } from "@/features/shortcuts/shortcuts-view";
import { getT } from "@/lib/i18n/server";

/** Shortcuts (ADR-017): managed here; used by saying or typing their phrase at Home. */
export default async function ShortcutsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const [shortcuts, contexts] = await Promise.all([
    shortcutStore(auth).list(),
    contextOptions(auth),
  ]);
  return (
    <PageContainer>
      <PageHeader title={t.shortcuts.title} subtitle={t.shortcuts.subtitle} />
      <ShortcutsView
        shortcuts={shortcuts}
        contexts={contexts.map((c) => ({ id: c.id, name: c.name }))}
      />
    </PageContainer>
  );
}
