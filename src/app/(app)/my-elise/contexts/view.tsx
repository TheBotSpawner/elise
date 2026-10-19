"use client";

import { PageContainer, PageHeader } from "@/components/shared/page";
import { ContextsIndex } from "@/features/contexts/contexts-view";
import { useI18n } from "@/lib/i18n/client";

import type { ContextsProps } from "./load";

export function View({ contexts }: ContextsProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader title={t.myElise.contexts.title} info={[t.myElise.contexts.subtitle]} />
      <ContextsIndex contexts={contexts} />
    </PageContainer>
  );
}
