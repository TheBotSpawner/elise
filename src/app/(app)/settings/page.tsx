import { GeneralSection } from "@/features/settings/sections";
import { SettingsIndex } from "@/features/settings/shell";

/**
 * /settings (ADR-068): on phones the list of categories; on wide screens the sidebar already
 * lists them, so General is shown.
 */
export default function SettingsPage() {
  return (
    <>
      <SettingsIndex />
      <div className="max-md:hidden">
        <GeneralSection />
      </div>
    </>
  );
}
