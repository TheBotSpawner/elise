"use client";

import { SettingsIndex } from "@/features/settings/shell";

import { View as GeneralView } from "./general/view";
import type { SettingsIndexProps } from "./load";

/**
 * /settings (ADR-068): on phones the list of categories; on wide screens the sidebar already
 * lists them, so General is shown.
 */
export function View(props: SettingsIndexProps) {
  return (
    <>
      <SettingsIndex />
      <div className="max-md:hidden">
        <GeneralView {...props} />
      </div>
    </>
  );
}
