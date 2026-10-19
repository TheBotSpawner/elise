"use client";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { StructuredSetup } from "@/features/structured/setup";
import { useI18n } from "@/lib/i18n/client";

import type { NewStructuredSourceProps } from "./load";

export function View({ workspaces, edit }: NewStructuredSourceProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <BackLink href="/connections" label={t.common.backTo(t.structured.back)} />
      <PageHeader title={edit ? edit.name : t.structured.connect} info={[t.structured.subtitle]} />
      <StructuredSetup workspaces={workspaces} edit={edit} />
    </PageContainer>
  );
}
