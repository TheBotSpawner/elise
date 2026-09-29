import { BookOpen } from "lucide-react";

import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { getT } from "@/lib/i18n/server";

export default async function KnowledgePage() {
  const { t } = await getT();
  return (
    <PageContainer>
      <PageHeader title={t.knowledge.title} />
      <EmptyState icon={BookOpen} title={t.knowledge.emptyTitle} body={t.knowledge.emptyBody} />
    </PageContainer>
  );
}
