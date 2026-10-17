import { requireAuthContext } from "@/application/auth-context";
import { financeSourcesOverview } from "@/application/finance-service";
import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SourcesView } from "@/features/finance/sources-view";
import { getT } from "@/lib/i18n/server";

export default async function FinanceSourcesPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const overview = await financeSourcesOverview(auth);
  return (
    <PageContainer>
      <BackLink href="/my-elise/finance" label={t.finance.back} />
      <PageHeader title={t.finance.sourcesTitle} subtitle={t.finance.sourcesSubtitle} />
      <SourcesView {...overview} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
