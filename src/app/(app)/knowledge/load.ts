import { after } from "next/server";

import { syncDueSources } from "@/application/knowledge-background";
import { knowledgeSetup, listSpaces } from "@/application/knowledge-service";

import type { RouteLoader } from "../route-contract";

export const load = (async (auth) => {
  const spaces = await listSpaces(auth);
  // Due Drive/Notion sources refresh in the background; the page never waits for them.
  after(() => syncDueSources(auth.workspaceId).catch(() => 0));
  const setup = knowledgeSetup();
  return {
    spaces,
    workspaceId: auth.workspaceId,
    backgroundAvailable: setup.backgroundAvailable,
    notionAvailable: setup.notionAvailable,
  };
}) satisfies RouteLoader<unknown>;

export type KnowledgeProps = Awaited<ReturnType<typeof load>>;
