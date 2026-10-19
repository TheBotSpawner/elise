"use client";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SourcesView } from "@/features/finance/sources-view";
import { useI18n } from "@/lib/i18n/client";

import type { FinanceSourcesProps } from "./load";

export function View({ overview, workspaceId }: FinanceSourcesProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <BackLink href="/my-elise/finance" label={t.finance.back} />
      <PageHeader title={t.finance.sourcesTitle} subtitle={t.finance.sourcesSubtitle} />
      <SourcesView {...overview} workspaceId={workspaceId} />
    </PageContainer>
  );
}
