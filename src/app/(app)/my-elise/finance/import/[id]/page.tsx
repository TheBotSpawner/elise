import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ImportWizard } from "@/features/finance/import-wizard";
import { getT } from "@/lib/i18n/server";

export default async function FinanceImportPage({
  params,
}: PageProps<"/my-elise/finance/import/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const { data } = await auth.db
    .from("imports")
    .select("status")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!data) notFound();
  return (
    <PageContainer>
      <Link href="/my-elise/finance/sources" className="text-[13px] text-muted hover:text-fg">
        {t.finance.sourcesTitle}
      </Link>
      <PageHeader title={t.finance.wizard.title} subtitle={t.finance.modes.importBody} />
      <ImportWizard importId={id} status={data.status} />
    </PageContainer>
  );
}
