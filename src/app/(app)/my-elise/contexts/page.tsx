import { requireAuthContext } from "@/application/auth-context";
import { listContextProfiles } from "@/application/contexts-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ContextsIndex } from "@/features/contexts/contexts-view";
import { getT } from "@/lib/i18n/server";

/**
 * Contexts from before Sections (ADR-018), kept reachable while they aren't a Section yet:
 * creating a Section with the same name adopts one. Not in the navigation.
 */
export default async function ContextsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const profiles = await listContextProfiles(auth, true);
  return (
    <PageContainer>
      <PageHeader title={t.myElise.contexts.title} subtitle={t.myElise.contexts.subtitle} />
      <ContextsIndex
        contexts={profiles
          .filter((p) => !p.section)
          .map((p) => ({
            id: p.id,
            name: p.name,
            kind: p.kind,
            icon: p.icon,
            accent: p.accent,
            status: p.status,
            description: p.description,
            links: p.links.filter((l) => l.confirmed).length,
          }))}
      />
    </PageContainer>
  );
}
