import { requireAuthContext } from "@/application/auth-context";
import { financeGoogleAccounts } from "@/application/finance-sources";
import { BackLink } from "@/components/shared/back-link";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ConnectSheetWizard } from "@/features/finance/connect-wizard";
import { getT } from "@/lib/i18n/server";

export default async function FinanceConnectPage({
  searchParams,
}: PageProps<"/my-elise/finance/connect">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const accounts = await financeGoogleAccounts(auth);
  return (
    <PageContainer>
      <BackLink href="/my-elise/finance/sources" label={t.common.backTo(t.finance.sourcesTitle)} />
      <PageHeader title="Google Sheets" subtitle={t.finance.sourcesSubtitle} />
      <ConnectSheetWizard
        accounts={accounts}
        initialMode={params.mode === "import" ? "import" : "connect"}
      />
    </PageContainer>
  );
}
