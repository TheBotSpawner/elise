import { Suspense } from "react";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { notesOverview } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { NotesView } from "@/features/native/notes-view";
import { getT } from "@/lib/i18n/server";

export default async function NotesPage({ searchParams }: PageProps<"/my-elise/notes">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const query = typeof params.q === "string" ? params.q.slice(0, 200) : "";
  const openId =
    typeof params.note === "string" && z.uuid().safeParse(params.note).success ? params.note : null;
  const { notes, spaces } = await notesOverview(auth, query || null);
  return (
    <PageContainer>
      <PageHeader title={t.native.notes.title} subtitle={t.native.notes.subtitle} />
      <Suspense>
        <NotesView
          notes={notes}
          spaces={spaces}
          query={query}
          openId={openId}
          workspaceId={auth.workspaceId}
        />
      </Suspense>
    </PageContainer>
  );
}
