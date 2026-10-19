"use client";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ImportWizard } from "@/features/finance/import-wizard";
import { useI18n } from "@/lib/i18n/client";

import type { FinanceImportProps } from "./load";

export function View({ importId, status }: FinanceImportProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <BackLink href="/my-elise/finance/sources" label={t.common.backTo(t.finance.sourcesTitle)} />
      <PageHeader title={t.finance.wizard.title} subtitle={t.finance.modes.importBody} />
      <ImportWizard importId={importId} status={status} />
    </PageContainer>
  );
}
