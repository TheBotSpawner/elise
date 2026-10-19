"use client";

import { SECTION_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { SchedulesView } from "@/features/schedules/schedules-view";
import { useI18n } from "@/lib/i18n/client";

import type { SchedulesProps } from "./load";

export function View(props: SchedulesProps) {
  const { t } = useI18n();
  return (
    <PageContainer wide>
      <PageHeader
        title={t.schedules.title}
        icon={SECTION_ICONS.schedules}
        info={[t.schedules.subtitle]}
      />
      <SchedulesView {...props} />
    </PageContainer>
  );
}
