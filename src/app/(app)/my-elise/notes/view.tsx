"use client";

import { Suspense } from "react";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { NotesView } from "@/features/native/notes-view";
import { useI18n } from "@/lib/i18n/client";

import type { NotesProps } from "./load";

export function View({ notes, spaces, tags, tagIds, query, openId, workspaceId }: NotesProps) {
  const { t } = useI18n();
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
          workspaceId={workspaceId}
        />
      </Suspense>
    </PageContainer>
  );
}
