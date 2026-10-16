import { requireAuthContext } from "@/application/auth-context";
import { getMemory } from "@/application/memory-service";
import { MemorySettings } from "@/features/settings/memory";
import { SettingsPage } from "@/features/settings/shell";
import { getT } from "@/lib/i18n/server";

export default async function MemorySettingsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const memory = await getMemory(auth);
  return (
    <SettingsPage section="memory" info={t.settingsHub.memory.info}>
      <MemorySettings enabled={memory.enabled} facts={memory.facts} />
    </SettingsPage>
  );
}
