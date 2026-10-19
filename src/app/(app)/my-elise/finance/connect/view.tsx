"use client";

import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ConnectSheetWizard } from "@/features/finance/connect-wizard";
import { useI18n } from "@/lib/i18n/client";

import type { FinanceConnectProps } from "./load";

export function View({ accounts, initialMode }: FinanceConnectProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <BackLink href="/my-elise/finance/sources" label={t.common.backTo(t.finance.sourcesTitle)} />
      <PageHeader title="Google Sheets" subtitle={t.finance.sourcesSubtitle} />
      <ConnectSheetWizard accounts={accounts} initialMode={initialMode} />
    </PageContainer>
  );
}
