import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { financeGoogleAccounts } from "@/application/finance-sources";
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
      <Link href="/my-elise/finance/sources" className="text-[13px] text-muted hover:text-fg">
        {t.finance.sourcesTitle}
      </Link>
      <PageHeader title="Google Sheets" subtitle={t.finance.sourcesSubtitle} />
      <ConnectSheetWizard
        accounts={accounts}
        initialMode={params.mode === "import" ? "import" : "connect"}
      />
    </PageContainer>
  );
}
