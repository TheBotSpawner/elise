import { requireAuthContext } from "@/application/auth-context";
import { contextOptions } from "@/application/contexts-service";
import { shortcutStore } from "@/application/shortcuts-service";
import { SettingsPage } from "@/features/settings/shell";
import { ShortcutsView } from "@/features/shortcuts/shortcuts-view";
import { getT } from "@/lib/i18n/server";

/** Shortcuts (ADR-017, ADR-068): a Settings category; used by saying or typing their phrase. */
export default async function ShortcutsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const [shortcuts, contexts] = await Promise.all([
    shortcutStore(auth).list(),
    contextOptions(auth),
  ]);
  return (
    <SettingsPage section="shortcuts" info={[t.shortcuts.subtitle]}>
      <ShortcutsView
        shortcuts={shortcuts}
        contexts={contexts.map((c) => ({ id: c.id, name: c.name }))}
      />
    </SettingsPage>
  );
}
