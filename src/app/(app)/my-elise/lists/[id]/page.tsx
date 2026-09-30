import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { listDetail } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ListDetail } from "@/features/native/lists-view";

export default async function ListPage({ params }: PageProps<"/my-elise/lists/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const auth = await requireAuthContext();
  const list = await listDetail(auth, id);
  if (!list) notFound();
  return (
    <PageContainer>
      <PageHeader title={list.name} />
      <ListDetail list={list} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
