import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { getStructuredSource } from "@/application/structured-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SourceDetail } from "@/features/structured/source-detail";
import { getT } from "@/lib/i18n/server";

export default async function StructuredSourcePage({
  params,
}: PageProps<"/connections/sources/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const source = await getStructuredSource(auth, id).catch(() => null);
  if (!source) notFound();
  return (
    <PageContainer>
      <Link href="/connections" className="text-[13px] text-muted hover:text-fg">
        {t.structured.back}
      </Link>
      <PageHeader title={source.name} subtitle={source.context ?? undefined} />
      <SourceDetail source={source} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
