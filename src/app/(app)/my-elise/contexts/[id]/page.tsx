import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { contextCatalog, getContextProfile } from "@/application/contexts-service";
import { runUserTool } from "@/application/elise";
import { studyStore } from "@/application/study-service";
import { PageContainer } from "@/components/shared/page";
import { progressCounts } from "@/core/study/model";
import { ContextEditor } from "@/features/contexts/contexts-view";

export default async function ContextPage({ params }: PageProps<"/my-elise/contexts/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const auth = await requireAuthContext();
  const profile = await getContextProfile(auth, id);
  if (!profile) notFound();
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
  return (
    <PageContainer>
      <ContextEditor
        profile={profile}
        catalog={catalog}
        progress={
          concepts.length ? { counts: progressCounts(concepts), total: concepts.length } : null
        }
      />
    </PageContainer>
  );
}
