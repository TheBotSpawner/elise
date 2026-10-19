"use client";

import { SECTION_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { KnowledgeHome } from "@/features/knowledge/knowledge-home";
import { useI18n } from "@/lib/i18n/client";

import type { KnowledgeProps } from "./load";

export function View({
  spaces,
  workspaceId,
  backgroundAvailable,
  notionAvailable,
}: KnowledgeProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader
        title={t.knowledge.title}
        icon={SECTION_ICONS.knowledge}
        info={[t.knowledge.subtitle, t.knowledge.helper]}
      />
      <KnowledgeHome
        spaces={spaces}
        workspaceId={workspaceId}
        backgroundAvailable={backgroundAvailable}
        notionAvailable={notionAvailable}
      />
    </PageContainer>
  );
}
