import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { financeBooks, financeReport, parseReportParams } from "@/application/finance-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { todayIn } from "@/core/time";
import { ReportView } from "@/features/finance/report-view";
import { getT } from "@/lib/i18n/server";

export default async function FinanceReportPage({
  searchParams,
}: PageProps<"/my-elise/finance/reports">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const input = parseReportParams(params);
  const [report, books] = await Promise.all([financeReport(auth, input), financeBooks(auth)]);
  return (
    <PageContainer>
      <Link href="/my-elise/finance" className="text-[13px] text-muted hover:text-fg">
        {t.finance.back}
      </Link>
      <PageHeader title={t.finance.reports.title} subtitle={t.finance.reports.subtitle} />
      <ReportView report={report} books={books} today={todayIn(auth.profile.timezone)} />
    </PageContainer>
  );
}
