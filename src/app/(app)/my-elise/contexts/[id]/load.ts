import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { contextCatalog, getContextProfile } from "@/application/contexts-service";
import { runUserTool } from "@/application/elise";
import { studyStore } from "@/application/study-service";
import { progressCounts } from "@/core/study/model";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth, { params }) => {
  const { id } = params;
  if (!z.uuid().safeParse(id).success) notFound();
  const profile = await getContextProfile(auth, id);
  if (!profile) notFound();
  // A Section's context lives in its Section (ADR-018); old links keep working.
  if (profile.section) redirect(`/knowledge/spaces/${profile.section.spaceId}`);
  const [catalog, concepts] = await Promise.all([
    contextCatalog(auth, async () => {
      // Task lists of every connected provider, read through the executor.
      const outcome = await runUserTool(auth, "tasks.listLists", {}).catch(() => null);
      return outcome?.display?.kind === "task_lists"
        ? outcome.display.lists.map((l) => ({
            id: l.id,
            name: l.name,
            source: l.provenance.source,
          }))
        : [];
    }),
    profile.kind === "study" ? studyStore(auth).concepts(profile.id) : Promise.resolve([]),
  ]);
  return {
    profile,
    catalog,
    progress: concepts.length ? { counts: progressCounts(concepts), total: concepts.length } : null,
  };
}) satisfies RouteLoader<unknown>;

export type ContextProps = Awaited<ReturnType<typeof load>>;
