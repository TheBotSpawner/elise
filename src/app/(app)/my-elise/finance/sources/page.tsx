import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { financeSourcesOverview } from "@/application/finance-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SourcesView } from "@/features/finance/sources-view";
import { getT } from "@/lib/i18n/server";

export default async function FinanceSourcesPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const overview = await financeSourcesOverview(auth);
  return (
    <PageContainer>
      <Link href="/my-elise/finance" className="text-[13px] text-muted hover:text-fg">
        {t.finance.back}
      </Link>
      <PageHeader title={t.finance.sourcesTitle} subtitle={t.finance.sourcesSubtitle} />
      <SourcesView {...overview} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
