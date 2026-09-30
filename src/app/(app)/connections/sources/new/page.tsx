import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { getStructuredSource, notionWorkspaces } from "@/application/structured-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { StructuredSetup } from "@/features/structured/setup";
import { getT } from "@/lib/i18n/server";

export default async function NewStructuredSourcePage({
  searchParams,
}: PageProps<"/connections/sources/new">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const editId = typeof params.edit === "string" ? params.edit : null;
  const [workspaces, edit] = await Promise.all([
    notionWorkspaces(auth),
    editId ? getStructuredSource(auth, editId).catch(() => null) : null,
  ]);
  return (
    <PageContainer>
      <Link href="/connections" className="text-[13px] text-muted hover:text-fg">
        {t.structured.back}
      </Link>
      <PageHeader
        title={edit ? edit.name : t.structured.connect}
        subtitle={t.structured.subtitle}
      />
      <StructuredSetup workspaces={workspaces} edit={edit} />
    </PageContainer>
  );
}
