import { Suspense } from "react";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { notesOverview } from "@/application/native-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { NotesView } from "@/features/native/notes-view";
import { getT } from "@/lib/i18n/server";

export default async function NotesPage({ searchParams }: PageProps<"/my-elise/notes">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const query = typeof params.q === "string" ? params.q.slice(0, 200) : "";
  const openId =
    typeof params.note === "string" && z.uuid().safeParse(params.note).success ? params.note : null;
  // ADR-088: ?tags=<id>,<id> narrows to notes with every one of them.
  const tagIds = (typeof params.tags === "string" ? params.tags.split(",") : [])
    .filter((id) => z.uuid().safeParse(id).success)
    .slice(0, 10);
  const { notes, spaces, tags } = await notesOverview(auth, query || null, tagIds);
  return (
    <PageContainer wide>
      <PageHeader
        title={t.native.notes.title}
        icon={MY_ELISE_ICONS.notes}
        info={[t.native.notes.subtitle]}
      />
      <Suspense>
        <NotesView
          notes={notes}
          spaces={spaces}
          tags={tags}
          tagFilter={tagIds}
          query={query}
          openId={openId}
          workspaceId={auth.workspaceId}
        />
      </Suspense>
    </PageContainer>
  );
}
