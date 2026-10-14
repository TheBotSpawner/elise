import { requireAuthContext } from "@/application/auth-context";
import { financeOverview, parseFinanceFilters } from "@/application/finance-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { FinanceView } from "@/features/finance/finance-view";
import { getT } from "@/lib/i18n/server";

export default async function FinancePage({ searchParams }: PageProps<"/my-elise/finance">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const overview = await financeOverview(auth, parseFinanceFilters(params));
  return (
    <PageContainer wide>
      <PageHeader title={t.finance.title} icon={MY_ELISE_ICONS.finance} />
      <FinanceView overview={overview} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
