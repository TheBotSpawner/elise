"use client";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SourceDetail } from "@/features/structured/source-detail";
import { useI18n } from "@/lib/i18n/client";

import type { StructuredSourceProps } from "./load";

export function View({ source, workspaceId }: StructuredSourceProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <BackLink href="/connections" label={t.common.backTo(t.structured.back)} />
      <PageHeader title={source.name} subtitle={source.context ?? undefined} />
      <SourceDetail source={source} workspaceId={workspaceId} />
    </PageContainer>
  );
}
