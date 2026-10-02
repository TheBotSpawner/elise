import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { relatedConversations } from "@/application/history-service";
import {
  getSpace,
  knowledgeAccounts,
  knowledgeSetup,
  listSpaces,
} from "@/application/knowledge-service";
import { sectionDetail } from "@/application/sections-service";
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
  const isSection = Boolean(data.space.parentId);
  const [accounts, allSpaces, section, conversations] = await Promise.all([
    knowledgeAccounts(auth),
    listSpaces(auth),
    isSection ? sectionDetail(auth, id).catch(() => null) : Promise.resolve(null),
    relatedConversations(auth, id).catch(() => []),
  ]);
  const setup = knowledgeSetup();
  return (
    <PageContainer>
      <SpaceView
        space={data.space}
        sections={data.children}
        conversations={conversations.map((c) => ({
          key: `${c.thread.kind}:${c.thread.id}`,
          href: c.href,
          title: c.title,
          at: c.at,
          section: c.section,
        }))}
        section={section}
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
