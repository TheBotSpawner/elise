import { requireAuthContext } from "@/application/auth-context";
import { knowledgeSetup, listSpaces } from "@/application/knowledge-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { KnowledgeHome } from "@/features/knowledge/knowledge-home";
import { getT } from "@/lib/i18n/server";

export default async function KnowledgePage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const spaces = await listSpaces(auth);
  return (
    <PageContainer>
      <PageHeader title={t.knowledge.title} subtitle={t.knowledge.subtitle} />
      <KnowledgeHome
        spaces={spaces}
        workspaceId={auth.workspaceId}
        backgroundAvailable={knowledgeSetup().backgroundAvailable}
      />
    </PageContainer>
  );
}
