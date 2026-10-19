"use client";

import { PageContainer, PageHeader } from "@/components/shared/page";
import { FinanceNav } from "@/features/finance/finance-view";
import { ReportView } from "@/features/finance/report-view";
import { useI18n } from "@/lib/i18n/client";

import type { FinanceReportProps } from "./load";

export function View({ report, books, today }: FinanceReportProps) {
  const { t } = useI18n();
  return (
    <PageContainer wide>
      <PageHeader title={t.finance.title} info={[t.finance.reports.subtitle]} />
      <div className="mb-5">
        <FinanceNav active="reports" reportsHref="/my-elise/finance/reports" />
      </div>
      <ReportView report={report} books={books} today={today} />
    </PageContainer>
  );
}
