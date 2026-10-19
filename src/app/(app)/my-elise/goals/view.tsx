"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { GoalsView } from "@/features/native/goals-view";
import { useI18n } from "@/lib/i18n/client";

import type { GoalsProps } from "./load";

export function View({ data, workspaceId }: GoalsProps) {
  const { t } = useI18n();
  return (
    <PageContainer wide>
      <PageHeader
        title={t.native.goals.title}
        icon={MY_ELISE_ICONS.goals}
        info={[t.native.goals.subtitle]}
      />
      <GoalsView key={String(data.archived)} data={data} workspaceId={workspaceId} />
    </PageContainer>
  );
}
