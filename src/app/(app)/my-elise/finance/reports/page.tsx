import { requireAuthContext } from "@/application/auth-context";
import { financeBooks, financeReport, parseReportParams } from "@/application/finance-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { todayIn } from "@/core/time";
import { FinanceNav } from "@/features/finance/finance-view";
import { ReportView } from "@/features/finance/report-view";
import { getT } from "@/lib/i18n/server";

export default async function FinanceReportPage({
  searchParams,
}: PageProps<"/my-elise/finance/reports">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const input = parseReportParams(params);
  const [report, books] = await Promise.all([financeReport(auth, input), financeBooks(auth)]);
  return (
    <PageContainer wide>
      <PageHeader title={t.finance.title} subtitle={t.finance.reports.subtitle} />
      <div className="mb-5">
        <FinanceNav active="reports" reportsHref="/my-elise/finance/reports" />
      </div>
      <ReportView report={report} books={books} today={todayIn(auth.profile.timezone)} />
    </PageContainer>
  );
}
