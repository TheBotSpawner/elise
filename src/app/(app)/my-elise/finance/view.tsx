"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { FinanceView } from "@/features/finance/finance-view";
import { useI18n } from "@/lib/i18n/client";

import type { FinanceProps } from "./load";

export function View({ overview, workspaceId }: FinanceProps) {
  const { t } = useI18n();
  return (
    <PageContainer wide>
      <PageHeader title={t.finance.title} icon={MY_ELISE_ICONS.finance} />
      <FinanceView overview={overview} workspaceId={workspaceId} />
    </PageContainer>
  );
}
