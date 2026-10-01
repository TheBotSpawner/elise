import { requireAuthContext } from "@/application/auth-context";
import { listContextProfiles } from "@/application/contexts-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ContextsIndex } from "@/features/contexts/contexts-view";
import { getT } from "@/lib/i18n/server";

/** Context Profiles: secondary management; Home is where contexts are used (ADR-016). */
export default async function ContextsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const profiles = await listContextProfiles(auth, true);
  return (
    <PageContainer>
      <PageHeader title={t.myElise.contexts.title} subtitle={t.myElise.contexts.subtitle} />
      <ContextsIndex
        contexts={profiles.map((p) => ({
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
