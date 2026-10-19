"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { HabitsView } from "@/features/native/habits-view";
import { useI18n } from "@/lib/i18n/client";

import type { HabitsProps } from "./load";

export function View({ data, workspaceId }: HabitsProps) {
  const { t } = useI18n();
  return (
    <PageContainer wide>
      <PageHeader
        title={t.native.habits.title}
        icon={MY_ELISE_ICONS.habits}
        info={[t.native.habits.subtitle]}
      />
      <HabitsView data={data} workspaceId={workspaceId} />
    </PageContainer>
  );
}
