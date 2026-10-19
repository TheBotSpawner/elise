"use client";

import { SettingsPage } from "@/features/settings/shell";
import { ShortcutsView } from "@/features/shortcuts/shortcuts-view";
import { useI18n } from "@/lib/i18n/client";

import type { ShortcutsProps } from "./load";

/** Shortcuts (ADR-017, ADR-068): a Settings category; used by saying or typing their phrase. */
export function View({ shortcuts, contexts }: ShortcutsProps) {
  const { t } = useI18n();
  return (
    <SettingsPage section="shortcuts" info={[t.shortcuts.subtitle]}>
      <ShortcutsView shortcuts={shortcuts} contexts={contexts} />
    </SettingsPage>
  );
}
