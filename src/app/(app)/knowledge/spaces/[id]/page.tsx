import { notFound } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { relatedConversations } from "@/application/history-service";
import { syncDueSources } from "@/application/knowledge-background";
import { getSpace, knowledgeAccounts, knowledgeSetup } from "@/application/knowledge-service";
import { PageContainer } from "@/components/shared/page";
import { SpaceView } from "@/features/knowledge/space-view";

export default async function SpacePage({
  params,
  searchParams,
}: PageProps<"/knowledge/spaces/[id]">) {
  const [{ id }, { add, attention }] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  const auth = await requireAuthContext();
  const data = await getSpace(auth, id).catch(() => null);
  if (!data) notFound();
  const [accounts, conversations] = await Promise.all([
    knowledgeAccounts(auth),
    relatedConversations(auth, id).catch(() => []),
  ]);
  // This Space's (and its Sections') due sources refresh after the page is sent.
  const ids = [id, ...data.children.map((c) => c.id)];
  after(() => syncDueSources(auth.workspaceId, ids).catch(() => 0));
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
        sources={data.sources}
        items={data.items}
        accounts={accounts}
        allSpaces={data.allSpaces}
        workspaceId={auth.workspaceId}
        notionAvailable={setup.notionAvailable}
        backgroundAvailable={setup.backgroundAvailable}
        initialAdd={add === "drive" || add === "notion" ? add : null}
        initialAttention={attention === "1"}
      />
    </PageContainer>
  );
}
