import { SettingsShell } from "@/features/settings/shell";

/** Settings (ADR-068): one shell — sidebar on wide screens, a list of categories on phones. */
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return <SettingsShell>{children}</SettingsShell>;
}
