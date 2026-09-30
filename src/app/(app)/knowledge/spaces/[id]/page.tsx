import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  getSpace,
  knowledgeAccounts,
  knowledgeSetup,
  listSpaces,
} from "@/application/knowledge-service";
import { PageContainer } from "@/components/shared/page";
import { SpaceView } from "@/features/knowledge/space-view";

export default async function SpacePage({
  params,
  searchParams,
}: PageProps<"/knowledge/spaces/[id]">) {
  const [{ id }, { add }] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const auth = await requireAuthContext();
  const data = await getSpace(auth, id).catch(() => null);
  if (!data) notFound();
  const [accounts, allSpaces] = await Promise.all([knowledgeAccounts(auth), listSpaces(auth)]);
  const setup = knowledgeSetup();
  return (
    <PageContainer>
      <SpaceView
        space={data.space}
        subspaces={data.children}
        sources={data.sources}
        items={data.items}
        accounts={accounts}
        allSpaces={allSpaces}
        workspaceId={auth.workspaceId}
        notionAvailable={setup.notionAvailable}
        backgroundAvailable={setup.backgroundAvailable}
        initialAdd={add === "drive" || add === "notion" ? add : null}
      />
    </PageContainer>
  );
}
