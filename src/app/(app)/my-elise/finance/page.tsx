import { requireAuthContext } from "@/application/auth-context";
import { financeOverview, parseFinanceFilters } from "@/application/finance-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { todayIn } from "@/core/time";
import { FinanceView } from "@/features/finance/finance-view";
import { getT } from "@/lib/i18n/server";

export default async function FinancePage({ searchParams }: PageProps<"/my-elise/finance">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const overview = await financeOverview(auth, parseFinanceFilters(params));
  return (
    <PageContainer>
      <PageHeader title={t.finance.title} subtitle={t.finance.subtitle} />
      <FinanceView
        overview={overview}
        workspaceId={auth.workspaceId}
        today={todayIn(auth.profile.timezone)}
      />
    </PageContainer>
  );
}
